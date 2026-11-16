// fork: `t3x service install` from the packaged macOS app. Every launchctl call goes to a fake
// runner and every path lives under a temp directory: nothing here reaches the real launchd.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { HttpClient } from "effect/http";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { FORK } from "@t3tools/shared/forkIdentity";
import * as BootService from "../cloud/bootService.ts";
import * as ProcessRunner from "../processRunner.ts";

const LABEL = FORK.bootServiceLabel;
const SERVICE_TARGET = `gui/501/${LABEL}`;

const makeHarness = Effect.fn("test.make_app_service_harness")(function* (options?: {
  readonly appParent?: string;
  readonly appRuntime?: boolean;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-app-service-test-" });
  const baseDir = path.join(home, ".t3extend");
  const appPath = path.join(options?.appParent ?? path.join(home, "Applications"), "T3 Extend.app");
  const executable = path.join(appPath, "Contents", "MacOS", "T3 Extend");
  const entry = path.join(
    appPath,
    "Contents",
    "Resources",
    "app.asar",
    "apps",
    "server",
    "dist",
    "bin.mjs",
  );
  const frpc = path.join(appPath, "Contents", "Resources", "bin", "frpc");
  // A location the install refuses is only named, never created: it is outside the temp directory.
  for (const file of options?.appParent === undefined ? [executable, entry, frpc] : []) {
    yield* fs.makeDirectory(path.dirname(file), { recursive: true });
    yield* fs.writeFileString(file, "");
  }

  const commands: string[] = [];
  const httpRequests: string[] = [];
  const launchd = { loaded: false, running: true };
  const runner = ProcessRunner.ProcessRunner.of({
    run: (input: ProcessRunner.ProcessRunInput) =>
      Effect.sync(() => {
        const command = `${input.command} ${input.args.join(" ")}`;
        commands.push(command);
        if (command.startsWith("launchctl bootstrap ")) launchd.loaded = true;
        if (command.startsWith("launchctl bootout ")) launchd.loaded = false;
        const printing = command === `launchctl print ${SERVICE_TARGET}`;
        return {
          stdout: printing && launchd.loaded && launchd.running ? "\tstate = running\n" : "",
          stderr: "",
          code: ChildProcessSpawner.ExitCode(printing && !launchd.loaded ? 113 : 0),
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
          stdoutInvalidUtf8: false,
          stderrInvalidUtf8: false,
        };
      }),
  });

  const environment: NodeJS.ProcessEnv =
    options?.appRuntime === false
      ? {}
      : { ELECTRON_RUN_AS_NODE: "1", T3X_FRPC_PATH: frpc, PATH: "/usr/bin:/bin" };
  const makeService = (
    cliVersion = "1.2.3",
    app: { readonly executable: string; readonly entry: string; readonly frpc: string } = {
      executable,
      entry,
      frpc,
    },
  ) =>
    BootService.make({
      baseDir,
      logsDir: path.join(baseDir, "userdata", "logs"),
      cliVersion,
    }).pipe(
      Effect.provideService(ProcessRunner.ProcessRunner, runner),
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(HostProcess.Platform, "darwin"),
          Layer.succeed(HostProcess.UserId, 501),
          Layer.succeed(HostProcess.ExecutablePath, app.executable),
          Layer.succeed(HostProcess.Arguments, [app.executable, app.entry, "service", "install"]),
          Layer.succeed(
            HostProcess.Environment,
            options?.appRuntime === false ? {} : { ...environment, T3X_FRPC_PATH: app.frpc },
          ),
          Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make((request) => {
              httpRequests.push(request.url);
              return Effect.die("no release download expected");
            }),
          ),
          ConfigProvider.layer(
            ConfigProvider.fromEnv({ env: { HOME: home, PATH: "/usr/bin:/bin" } }),
          ),
        ),
      ),
    );

  return {
    fs,
    path,
    home,
    baseDir,
    appPath,
    executable,
    entry,
    frpc,
    commands,
    httpRequests,
    launchd,
    makeService,
    plistPath: path.join(home, "Library", "LaunchAgents", `${LABEL}.plist`),
  };
});

it.layer(NodeServices.layer)("service installed from the desktop app", (it) => {
  it.effect("runs the app itself and downloads nothing", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const service = yield* h.makeService();

      const plan = yield* service.install();

      expect(plan.program).toEqual([h.executable, h.entry, "__service-launcher"]);
      expect(h.httpRequests).toEqual([]);
      expect(h.commands.some((command) => command.includes("--version"))).toBe(false);
      expect(yield* h.fs.exists(h.path.join(h.baseDir, "runtime", "versions"))).toBe(false);
      const plist = yield* h.fs.readFileString(h.plistPath);
      expect(plist).toContain(`<string>${h.executable}</string>`);
      expect(plist).toContain(`<string>${h.entry}</string>`);
      expect(plist).toContain(`<key>ELECTRON_RUN_AS_NODE</key>\n    <string>1</string>`);
      expect(plist).toContain(`<key>T3X_FRPC_PATH</key>\n    <string>${h.frpc}</string>`);
      expect(plist).toContain(`<key>T3X_APP_RUNTIME_VERSION</key>\n    <string>1.2.3</string>`);
      expect(plist).toContain(`<key>T3CODE_HOME</key>\n    <string>${h.baseDir}</string>`);
      expect(
        JSON.parse(
          yield* h.fs.readFileString(h.path.join(h.baseDir, "runtime", "service-state.json")),
        ),
      ).toEqual({
        protocol: 4,
        activeVersion: "1.2.3",
      });
      expect(h.commands).toEqual([
        `launchctl enable ${SERVICE_TARGET}`,
        `launchctl bootstrap gui/501 ${h.plistPath}`,
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps the app's own directory out of the service PATH", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* (yield* h.makeService()).install();
      const plist = yield* h.fs.readFileString(h.plistPath);
      expect(plist).not.toContain("Contents/MacOS</string>");
      expect(plist).not.toMatch(/<key>PATH<\/key>\s*<string>[^<]*Contents\/MacOS/);
    }).pipe(Effect.scoped),
  );

  it.effect("reports a running, current service", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const service = yield* h.makeService();
      yield* service.install();

      expect(yield* service.status).toMatchObject({
        supported: true,
        installed: true,
        current: true,
        running: true,
        installedVersion: "1.2.3",
        problems: [],
      });
    }).pipe(Effect.scoped),
  );

  it.effect("reports an installed service that launchd no longer has loaded", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const service = yield* h.makeService();
      yield* service.install();
      h.launchd.loaded = false;

      expect(yield* service.status).toMatchObject({ installed: true, running: false });
    }).pipe(Effect.scoped),
  );

  it.effect("says so when the app the service runs from has been moved or deleted", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const service = yield* h.makeService();
      yield* service.install();
      yield* h.fs.remove(h.appPath, { recursive: true });

      const status = yield* service.status;

      expect(status).toMatchObject({
        installed: true,
        current: false,
        problems: ["app-runtime-missing"],
      });
      expect(BootService.formatBootServiceProblem("app-runtime-missing")).toContain(
        FORK.appBaseName,
      );
    }).pipe(Effect.scoped),
  );

  it.effect("repairs a service whose app moved, from the app's new location", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* (yield* h.makeService()).install();
      const movedApp = h.path.join(h.home, "Moved", "T3 Extend.app");
      yield* h.fs.makeDirectory(h.path.dirname(movedApp), { recursive: true });
      yield* h.fs.rename(h.appPath, movedApp);
      const from = (file: string) => h.path.join(movedApp, h.path.relative(h.appPath, file));
      const service = yield* h.makeService("1.2.3", {
        executable: from(h.executable),
        entry: from(h.entry),
        frpc: from(h.frpc),
      });

      expect(yield* service.status).toMatchObject({
        current: false,
        problems: ["app-runtime-missing"],
      });
      h.commands.length = 0;
      yield* service.install();

      const plist = yield* h.fs.readFileString(h.plistPath);
      expect(plist).toContain(`<string>${from(h.executable)}</string>`);
      expect(plist).not.toContain(`<string>${h.executable}</string>`);
      expect(h.commands).toEqual([
        `launchctl bootout --wait ${SERVICE_TARGET}`,
        `launchctl enable ${SERVICE_TARGET}`,
        `launchctl bootstrap gui/501 ${h.plistPath}`,
      ]);
      expect(yield* service.status).toMatchObject({ current: true, problems: [] });
    }).pipe(Effect.scoped),
  );

  it.effect.each([
    { place: "translocated", appParent: "/private/var/folders/xx/T/AppTranslocation/ABC/d" },
    { place: "a disk image", appParent: "/Volumes/T3 Extend" },
  ])("refuses to install from $place, which would not survive a reboot", ({ appParent }) =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ appParent });
      const service = yield* h.makeService();

      const error = yield* service.install().pipe(Effect.flip);

      expect(error._tag).toBe("BootServiceAppLocationError");
      expect(error.message).toContain("Applications");
      expect(yield* h.fs.exists(h.plistPath)).toBe(false);
      expect(h.commands).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("still downloads the pinned runtime when the CLI is not the app's", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ appRuntime: false });
      const service = yield* h.makeService();

      const exit = yield* Effect.exit(service.install());

      expect(Exit.isFailure(exit)).toBe(true);
      expect(h.httpRequests.length).toBeGreaterThan(0);
      expect(yield* h.fs.exists(h.plistPath)).toBe(false);
    }).pipe(Effect.scoped),
  );

  it("renders no app environment for a downloaded runtime", () => {
    const plist = BootService.renderBootServicePlist(
      {
        program: ["/Users/theo/.t3extend/runtime/versions/1.2.3/t3", "__service-launcher"],
        baseDir: "/Users/theo/.t3extend",
        logPath: "/log",
        unitPath: "/unit",
      },
      { homeDir: "/Users/theo", environmentPath: "/usr/bin" },
    );
    expect(plist).not.toContain("ELECTRON_RUN_AS_NODE");
    expect(plist).not.toContain("T3X_");
  });
});
