// Every command goes to a fake runner and the launch agent plist is a file in a temp directory:
// nothing here reaches the real launchd.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { FORK } from "@t3tools/shared/forkIdentity";
import * as DesktopBackgroundService from "./DesktopBackgroundService.ts";

const TARGET = `gui/501/${FORK.bootServiceLabel}`;
const installedStatus = JSON.stringify({
  supported: true,
  installed: true,
  current: true,
  problems: [],
});
const APP_PLIST = "<dict><key>ELECTRON_RUN_AS_NODE</key><string>1</string></dict>";
const DOWNLOADED_PLIST = "<dict><key>PATH</key><string>/usr/bin</string></dict>";

const makeHarness = Effect.fn("test.make_background_service_harness")(function* (options?: {
  readonly available?: boolean;
  readonly plist?: string;
  readonly respond?: (command: string) => Partial<DesktopBackgroundService.CommandResult>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-background-service-test-" });
  const plistPath = path.join(home, "Library", "LaunchAgents", `${FORK.bootServiceLabel}.plist`);
  if (options?.plist !== undefined) {
    yield* fs.makeDirectory(path.dirname(plistPath), { recursive: true });
    yield* fs.writeFileString(plistPath, options.plist);
  }
  const calls: Array<DesktopBackgroundService.CommandInput> = [];
  const service = yield* DesktopBackgroundService.make({
    available: options?.available ?? true,
    homeDirectory: home,
    uid: 501,
    cli: {
      executable: "/Applications/T3 Extend.app/Contents/MacOS/T3 Extend",
      entry: "/Applications/T3 Extend.app/Contents/Resources/app.asar/apps/server/dist/bin.mjs",
      baseDir: "/Users/theo/.t3extend",
      frpcPath: "/Applications/T3 Extend.app/Contents/Resources/bin/frpc",
    },
    environment: { HOME: home, PATH: "/usr/bin", T3_BOOT_SERVICE_UNIT: "t3extend.service" },
    runCommand: (input) =>
      Effect.sync(() => {
        calls.push(input);
        const reply = options?.respond?.(`${input.command} ${input.args.join(" ")}`) ?? {};
        return { code: 0, stdout: "", stderr: "", ...reply };
      }),
  });
  return {
    service,
    calls,
    plistPath,
    commands: () => calls.map((call) => `${call.command} ${call.args.join(" ")}`),
  };
});

it.layer(NodeServices.layer)("desktop background service switch", (it) => {
  it.effect("is unavailable, and runs nothing, outside the packaged macOS app", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ available: false, plist: APP_PLIST });

      expect(yield* h.service.getState).toEqual({ kind: "unavailable" });
      expect((yield* h.service.setEnabled(true)).state).toEqual({ kind: "unavailable" });
      yield* h.service.pauseForApp;
      yield* h.service.resumeAfterApp;
      expect(h.calls).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("reads the status from the bundled CLI, run the way the t3x shim runs it", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ respond: () => ({ stdout: `${installedStatus}\n` }) });

      expect(yield* h.service.getState).toEqual({ kind: "on" });

      const [call] = h.calls;
      expect(call?.command).toBe("/Applications/T3 Extend.app/Contents/MacOS/T3 Extend");
      expect(call?.args).toEqual([
        "/Applications/T3 Extend.app/Contents/Resources/app.asar/apps/server/dist/bin.mjs",
        "service",
        "status",
        "--json",
        "--base-dir",
        "/Users/theo/.t3extend",
      ]);
      expect(call?.env).toMatchObject({
        ELECTRON_RUN_AS_NODE: "1",
        T3CODE_HOME: "/Users/theo/.t3extend",
        T3X_FRPC_PATH: "/Applications/T3 Extend.app/Contents/Resources/bin/frpc",
        PATH: "/usr/bin",
      });
      expect(call?.env).not.toHaveProperty("T3_BOOT_SERVICE_UNIT");
    }).pipe(Effect.scoped),
  );

  it.effect("reports an unreadable status instead of guessing", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ respond: () => ({ code: 1, stderr: "boom" }) });
      expect(yield* h.service.getState).toEqual({ kind: "attention", problem: "unreadable" });
    }).pipe(Effect.scoped),
  );

  it.effect("turns on by installing, then stops the service so the app keeps the home", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({
        plist: APP_PLIST,
        respond: (command) => (command.includes("--json") ? { stdout: installedStatus } : {}),
      });

      const change = yield* h.service.setEnabled(true);

      expect(change).toEqual({ state: { kind: "on" }, error: null });
      const [install, pause, status] = h.commands();
      expect(install).toMatch(/ service install --base-dir \/Users\/theo\/\.t3extend$/);
      expect(pause).toBe(`launchctl bootout --wait ${TARGET}`);
      expect(status).toMatch(/ service status --json --base-dir \/Users\/theo\/\.t3extend$/);
      expect(h.calls).toHaveLength(3);
    }).pipe(Effect.scoped),
  );

  it.effect("says why turning on failed, and leaves a service that is not installed alone", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({
        plist: APP_PLIST,
        respond: (command) =>
          command.includes("install")
            ? { code: 1, stderr: "T3 Extend is running from /Volumes/T3 Extend.\n" }
            : command.includes("--json")
              ? { stdout: JSON.stringify({ supported: true, installed: false }) }
              : {},
      });

      const change = yield* h.service.setEnabled(true);

      expect(change).toEqual({
        state: { kind: "off" },
        error: "T3 Extend is running from /Volumes/T3 Extend.",
      });
      expect(h.commands().some((command) => command.startsWith("launchctl"))).toBe(false);
    }).pipe(Effect.scoped),
  );

  it.effect("turns off by uninstalling", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({
        respond: (command) =>
          command.includes("--json")
            ? { stdout: JSON.stringify({ supported: true, installed: false }) }
            : {},
      });

      expect(yield* h.service.setEnabled(false)).toEqual({ state: { kind: "off" }, error: null });
      expect(h.commands()[0]).toContain("service uninstall");
      expect(h.commands().some((command) => command.startsWith("launchctl"))).toBe(false);
    }).pipe(Effect.scoped),
  );

  it.effect("stops an installed service at launch", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ plist: APP_PLIST });
      yield* h.service.pauseForApp;
      expect(h.commands()).toEqual([`launchctl bootout --wait ${TARGET}`]);
    }).pipe(Effect.scoped),
  );

  it.effect.each([
    { case: "no service installed", plist: undefined },
    { case: "a service that runs a downloaded runtime", plist: DOWNLOADED_PLIST },
  ])("leaves $case alone at launch and at quit", ({ plist }) =>
    Effect.gen(function* () {
      const h = yield* makeHarness(plist === undefined ? {} : { plist });
      yield* h.service.pauseForApp;
      yield* h.service.resumeAfterApp;
      expect(h.calls).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("starts a service that is not loaded when the app quits", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({
        plist: APP_PLIST,
        respond: (command) => (command.startsWith("launchctl print") ? { code: 113 } : {}),
      });
      yield* h.service.resumeAfterApp;
      expect(h.commands()).toEqual([
        `launchctl print ${TARGET}`,
        `launchctl enable ${TARGET}`,
        `launchctl bootstrap gui/501 ${h.plistPath}`,
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("restarts a service that is still loaded and waiting for the home", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ plist: APP_PLIST });
      yield* h.service.resumeAfterApp;
      expect(h.commands()).toEqual([
        `launchctl print ${TARGET}`,
        `launchctl kickstart -k ${TARGET}`,
      ]);
    }).pipe(Effect.scoped),
  );
});
