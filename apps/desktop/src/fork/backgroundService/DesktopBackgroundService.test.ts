// Every command goes to a fake launchd and the launch agent plist and the T3 home are files in a
// temp directory: nothing here reaches the real launchd.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { FORK } from "@t3tools/shared/forkIdentity";
import * as DesktopBackgroundService from "./DesktopBackgroundService.ts";

const TARGET = `gui/501/${FORK.bootServiceLabel}`;
const APP = "/Applications/T3 Extend.app";
const EXECUTABLE = `${APP}/Contents/MacOS/T3 Extend`;
const ENTRY = `${APP}/Contents/Resources/app.asar/apps/server/dist/bin.mjs`;
const installedStatus = JSON.stringify({
  supported: true,
  installed: true,
  current: true,
  problems: [],
});

const plistFor = (input: {
  readonly baseDir: string;
  readonly executable?: string;
  readonly entry?: string;
  readonly marker?: boolean;
}) =>
  [
    "<dict><key>ProgramArguments</key><array>",
    `<string>${input.executable ?? EXECUTABLE}</string>`,
    `<string>${input.entry ?? ENTRY}</string>`,
    "<string>__service-launcher</string></array>",
    "<key>EnvironmentVariables</key><dict>",
    "<key>ELECTRON_RUN_AS_NODE</key><string>1</string>",
    `<key>T3CODE_HOME</key><string>${input.baseDir}</string>`,
    input.marker === false ? "" : "<key>T3X_APP_SERVICE</key><string>1</string>",
    "</dict></dict>",
  ].join("");

const makeHarness = Effect.fn("test.make_background_service_harness")(function* (options?: {
  readonly available?: boolean;
  /** The plist on disk: this app's own (default), another one, or none. */
  readonly plist?: (baseDir: string) => string | null;
  readonly cliExecutable?: string;
  readonly cliEntry?: string;
  readonly respond?: (command: string) => Partial<DesktopBackgroundService.CommandResult>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-background-service-test-" });
  const baseDir = path.join(home, ".t3extend");
  const plistPath = path.join(home, "Library", "LaunchAgents", `${FORK.bootServiceLabel}.plist`);
  const plist = options?.plist === undefined ? plistFor({ baseDir }) : options.plist(baseDir);
  if (plist !== null) {
    yield* fs.makeDirectory(path.dirname(plistPath), { recursive: true });
    yield* fs.writeFileString(plistPath, plist);
  }
  const calls: Array<DesktopBackgroundService.CommandInput> = [];
  const launchd = {
    loaded: true,
    /** bootout leaves the job loaded, as when launchd refuses it. */
    bootoutFails: false,
    /** The next this-many bootstrap and kickstart commands fail. */
    startFailures: 0,
  };
  const service = yield* DesktopBackgroundService.make({
    available: options?.available ?? true,
    homeDirectory: home,
    uid: 501,
    cli: {
      executable: options?.cliExecutable ?? EXECUTABLE,
      entry: options?.cliEntry ?? ENTRY,
      baseDir,
      frpcPath: `${APP}/Contents/Resources/bin/frpc`,
    },
    environment: { HOME: home, PATH: "/usr/bin", T3_BOOT_SERVICE_UNIT: "t3extend.service" },
    runCommand: (input) =>
      Effect.sync(() => {
        calls.push(input);
        const command = `${input.command} ${input.args.join(" ")}`;
        const reply = options?.respond?.(command) ?? {};
        let code = 0;
        let stderr = "";
        if (command.startsWith("launchctl bootout")) {
          if (launchd.bootoutFails) {
            code = 5;
            stderr = "Boot-out failed: 5: Input/output error";
          } else launchd.loaded = false;
        }
        if (
          command.startsWith("launchctl bootstrap") ||
          command.startsWith("launchctl kickstart")
        ) {
          if (launchd.startFailures > 0) {
            launchd.startFailures -= 1;
            code = 5;
            stderr = "Bootstrap failed: 5: Input/output error";
          } else launchd.loaded = true;
        }
        if (command === `launchctl print ${TARGET}`) code = launchd.loaded ? 0 : 113;
        return { code, stdout: "", stderr, ...reply };
      }),
  });
  return {
    service,
    calls,
    launchd,
    home,
    baseDir,
    plistPath,
    failurePath: path.join(baseDir, "runtime", "background-service-resume-failed.json"),
    commands: () => calls.map((call) => `${call.command} ${call.args.join(" ")}`),
    launchctlCommands: () =>
      calls.flatMap((call) =>
        call.command === "launchctl" ? [`launchctl ${call.args.join(" ")}`] : [],
      ),
  };
});

it.layer(NodeServices.layer)("desktop background service switch", (it) => {
  it.effect("is unavailable, and runs nothing, outside the packaged macOS app", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ available: false });

      expect(yield* h.service.getState).toEqual({ kind: "unavailable" });
      expect((yield* h.service.setEnabled(true)).state).toEqual({ kind: "unavailable" });
      expect(yield* h.service.pauseForApp).toEqual({ kind: "skipped" });
      yield* h.service.resumeAfterApp;
      expect(h.calls).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("reads the status from the bundled CLI, run the way the t3x shim runs it", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ respond: () => ({ stdout: `${installedStatus}\n` }) });

      expect(yield* h.service.getState).toEqual({ kind: "on" });

      const [call] = h.calls;
      expect(call?.command).toBe(EXECUTABLE);
      expect(call?.args).toEqual([ENTRY, "service", "status", "--json", "--base-dir", h.baseDir]);
      expect(call?.env).toMatchObject({
        ELECTRON_RUN_AS_NODE: "1",
        T3CODE_HOME: h.baseDir,
        T3X_FRPC_PATH: `${APP}/Contents/Resources/bin/frpc`,
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
        respond: (command) => (command.includes("--json") ? { stdout: installedStatus } : {}),
      });

      expect(yield* h.service.setEnabled(true)).toEqual({ state: { kind: "on" }, error: null });

      expect(h.commands()[0]).toMatch(/ service install --base-dir /);
      expect(h.launchctlCommands()).toEqual([
        `launchctl print ${TARGET}`,
        `launchctl bootout --wait ${TARGET}`,
        `launchctl print ${TARGET}`,
      ]);
      expect(h.commands().at(-1)).toMatch(/ service status --json /);
    }).pipe(Effect.scoped),
  );

  it.effect("says why turning on failed, and touches no service when nothing was installed", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({
        respond: (command) =>
          command.includes("install")
            ? { code: 1, stderr: "T3 Extend is running from /Volumes/T3 Extend.\n" }
            : command.includes("--json")
              ? { stdout: JSON.stringify({ supported: true, installed: false }) }
              : {},
      });

      expect(yield* h.service.setEnabled(true)).toEqual({
        state: { kind: "off" },
        error: "T3 Extend is running from /Volumes/T3 Extend.",
      });
      expect(h.launchctlCommands()).toEqual([]);
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
      expect(h.launchctlCommands()).toEqual([]);
    }).pipe(Effect.scoped),
  );

  // Only the exact service this app installed for this home is ever stopped or started.
  const notOurs: ReadonlyArray<{
    readonly case: string;
    readonly plist: (baseDir: string) => string | null;
  }> = [
    { case: "no service installed", plist: () => null },
    {
      case: "an npm plist that only sets ELECTRON_RUN_AS_NODE",
      plist: (baseDir) => plistFor({ baseDir, marker: false }),
    },
    {
      case: "a service for another T3 home",
      plist: () => plistFor({ baseDir: "/Users/theo/.t3extend-other" }),
    },
    {
      case: "a service run from another copy of the app",
      plist: (baseDir) =>
        plistFor({
          baseDir,
          executable: "/Applications/Other.app/Contents/MacOS/Other",
          entry: "/Applications/Other.app/Contents/Resources/app.asar/apps/server/dist/bin.mjs",
        }),
    },
    {
      case: "a service whose program is not an app bundle",
      plist: (baseDir) =>
        plistFor({ baseDir, executable: "/Users/theo/.t3/runtime/versions/1.2.3/t3", entry: "x" }),
    },
  ];

  it.effect.each(notOurs)("leaves $case alone at launch and at quit", ({ plist }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const h = yield* makeHarness({ plist });

      expect(yield* h.service.pauseForApp).toEqual({ kind: "skipped" });
      yield* h.service.resumeAfterApp;

      expect(h.launchctlCommands()).toEqual([]);
      expect(yield* fs.exists(h.failurePath)).toBe(false);
    }).pipe(Effect.scoped),
  );

  it.effect("knows its service when the plist and the app name it through a link", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-background-service-link-" });
      const realApp = path.join(root, "real", "T3 Extend.app");
      const linkedApp = path.join(root, "link", "T3 Extend.app");
      yield* fs.makeDirectory(realApp, { recursive: true });
      yield* fs.makeDirectory(path.dirname(linkedApp), { recursive: true });
      yield* fs.symlink(realApp, linkedApp);
      const inApp = (app: string, rest: string) => `${app}/Contents/${rest}`;
      const h = yield* makeHarness({
        cliExecutable: inApp(realApp, "MacOS/T3 Extend"),
        cliEntry: inApp(realApp, "Resources/app.asar/apps/server/dist/bin.mjs"),
        plist: (baseDir) =>
          plistFor({
            baseDir,
            executable: inApp(linkedApp, "MacOS/T3 Extend"),
            entry: inApp(linkedApp, "Resources/app.asar/apps/server/dist/bin.mjs"),
          }),
      });

      expect(yield* h.service.pauseForApp).toEqual({ kind: "stopped" });
    }).pipe(Effect.scoped),
  );

  it.effect("stops its own loaded service at launch and checks it let go", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();

      expect(yield* h.service.pauseForApp).toEqual({ kind: "stopped" });

      expect(h.launchctlCommands()).toEqual([
        `launchctl print ${TARGET}`,
        `launchctl bootout --wait ${TARGET}`,
        `launchctl print ${TARGET}`,
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("has nothing to stop when its service is not loaded", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      h.launchd.loaded = false;

      expect(yield* h.service.pauseForApp).toEqual({ kind: "skipped" });
      expect(h.launchctlCommands()).toEqual([`launchctl print ${TARGET}`]);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "reports a service that will not stop, so the app does not wait out the home lock",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        h.launchd.bootoutFails = true;

        expect(yield* h.service.pauseForApp).toEqual({
          kind: "failed",
          reason: "Boot-out failed: 5: Input/output error",
        });
      }).pipe(Effect.scoped),
  );

  it.effect("treats a bootout that exits 0 but leaves the job loaded as not stopped", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({
        respond: (command) => (command.startsWith("launchctl bootout") ? { code: 0 } : {}),
      });
      h.launchd.bootoutFails = true;

      expect((yield* h.service.pauseForApp).kind).toBe("failed");
    }).pipe(Effect.scoped),
  );

  it.effect("starts a service that is not loaded when the app quits, and checks it loaded", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      h.launchd.loaded = false;

      yield* h.service.resumeAfterApp;

      expect(h.launchctlCommands()).toEqual([
        `launchctl print ${TARGET}`,
        `launchctl enable ${TARGET}`,
        `launchctl bootstrap gui/501 ${h.plistPath}`,
        `launchctl print ${TARGET}`,
      ]);
      expect(h.launchd.loaded).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.effect("restarts a service that is still loaded and waiting for the home", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();

      yield* h.service.resumeAfterApp;

      expect(h.launchctlCommands()).toEqual([
        `launchctl print ${TARGET}`,
        `launchctl kickstart -k ${TARGET}`,
        `launchctl print ${TARGET}`,
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("tries once more when the start fails, and records nothing when that works", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const h = yield* makeHarness();
      h.launchd.loaded = false;
      h.launchd.startFailures = 1;
      yield* fs.makeDirectory(`${h.baseDir}/runtime`, { recursive: true });
      yield* fs.writeFileString(h.failurePath, '{"at":"2026-11-16T00:00:00.000Z","reason":"old"}');

      yield* h.service.resumeAfterApp;

      expect(h.launchd.loaded).toBe(true);
      expect(h.launchctlCommands().filter((command) => command.includes("bootstrap"))).toHaveLength(
        2,
      );
      expect(yield* fs.exists(h.failurePath)).toBe(false);
    }).pipe(Effect.scoped),
  );

  it.effect("records a start that still fails, and the next launch reports and clears it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const h = yield* makeHarness({
        respond: (command) => (command.includes("--json") ? { stdout: installedStatus } : {}),
      });
      h.launchd.loaded = false;
      h.launchd.startFailures = 2;

      yield* h.service.resumeAfterApp;

      // One try and one retry, then it gives up so quitting is not held up.
      expect(h.launchctlCommands().filter((command) => command.includes("bootstrap"))).toHaveLength(
        2,
      );
      const recorded: unknown = JSON.parse(yield* fs.readFileString(h.failurePath));
      expect(recorded).toEqual({
        at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        reason: "Bootstrap failed: 5: Input/output error",
      });
      expect(yield* h.service.getState).toEqual({
        kind: "attention",
        problem: "resume-failed",
        reason: "Bootstrap failed: 5: Input/output error",
      });

      // Retrying is a fresh install, which clears the record.
      expect(yield* h.service.setEnabled(true)).toEqual({ state: { kind: "on" }, error: null });
      expect(yield* fs.exists(h.failurePath)).toBe(false);
    }).pipe(Effect.scoped),
  );

  it.effect("forgets a recorded failure once the service is removed", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const h = yield* makeHarness({
        respond: (command) =>
          command.includes("--json")
            ? { stdout: JSON.stringify({ supported: true, installed: false }) }
            : {},
      });
      yield* fs.makeDirectory(`${h.baseDir}/runtime`, { recursive: true });
      yield* fs.writeFileString(h.failurePath, '{"at":"2026-11-16T00:00:00.000Z","reason":"x"}');

      expect(yield* h.service.getState).toEqual({ kind: "off" });
      expect(yield* fs.exists(h.failurePath)).toBe(false);
    }).pipe(Effect.scoped),
  );
});
