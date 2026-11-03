import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as TestClock from "effect/testing/TestClock";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopSelfHost from "./DesktopSelfHost.ts";

const layerFor = (baseDir: string, spawned: Ref.Ref<number>, env: Record<string, string> = {}) => {
  const config = DesktopConfig.layerTest({ T3CODE_HOME: baseDir, ...env });
  const spawner = ChildProcessSpawner.make(() =>
    Ref.update(spawned, (count) => count + 1).pipe(
      Effect.as(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(7),
          exitCode: Effect.never,
          isRunning: Effect.succeed(true),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.empty,
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        }),
      ),
    ),
  );
  return DesktopSelfHost.layer.pipe(
    Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)),
    Layer.provideMerge(
      DesktopEnvironment.layer({
        dirname: "/repo/apps/desktop/src",
        homeDirectory: baseDir,
        platform: "darwin",
        processArch: "arm64",
        appVersion: "1.2.3",
        appPath: "/repo",
        isPackaged: true,
        resourcesPath: "/missing/resources",
        runningUnderArm64Translation: false,
      }).pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, config))),
    ),
    Layer.provide(config),
    Layer.provideMerge(NodeServices.layer),
  );
};

describe("DesktopSelfHost", () => {
  it.effect("saves addresses where the backend reads them and restarts the saved tunnel", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3x-self-host-" });
      const spawned = yield* Ref.make(0);
      const env = {
        T3CODE_DESKTOP_HTTPS_ENDPOINTS: "https://env.example.com,http://plain.example",
      };

      const first = yield* Effect.gen(function* () {
        const selfHost = yield* DesktopSelfHost.DesktopSelfHost;
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const state = yield* selfHost.setPublicUrls(["https://t3.example.com", "not a url"]);
        yield* selfHost.setTunnel({ command: "  frpc -c ~/frpc.toml  ", enabled: true });
        const modeOf = (path: string) =>
          fs.stat(path).pipe(Effect.map((info) => info.mode & 0o777));
        return {
          state,
          file: yield* fs.readFileString(DesktopSelfHost.publicUrlsFilePath(environment)),
          publicUrls: yield* selfHost.publicUrls,
          modes: [
            yield* modeOf(environment.stateDir),
            yield* modeOf(DesktopSelfHost.publicUrlsFilePath(environment)),
            yield* modeOf(environment.path.join(environment.stateDir, "self-host-tunnel.json")),
          ],
        };
      }).pipe(Effect.provide(layerFor(baseDir, spawned, env)), Effect.scoped);

      assert.deepEqual(first.state.publicUrls, ["https://t3.example.com/"]);
      assert.deepEqual(first.state.environmentPublicUrls, ["https://env.example.com/"]);
      assert.deepEqual(first.publicUrls, ["https://env.example.com/", "https://t3.example.com/"]);
      assert.include(first.file, "https://t3.example.com/");
      if (HostProcess.Platform.defaultValue() !== "win32") {
        assert.deepEqual(first.modes, [0o700, 0o600, 0o600]);
      }
      assert.strictEqual(yield* Ref.get(spawned), 1);

      const restarted = yield* Effect.gen(function* () {
        const selfHost = yield* DesktopSelfHost.DesktopSelfHost;
        return yield* selfHost.getState;
      }).pipe(Effect.provide(layerFor(baseDir, spawned)), Effect.scoped);

      assert.deepEqual(restarted.publicUrls, ["https://t3.example.com/"]);
      assert.strictEqual(restarted.tunnel.command, "frpc -c ~/frpc.toml");
      assert.isTrue(restarted.tunnel.enabled);
      assert.strictEqual(yield* Ref.get(spawned), 2);
    }).pipe(
      Effect.provide(NodeServices.layer),
      Effect.provideService(HostProcess.Environment, {}),
      Effect.scoped,
    ),
  );

  it.effect("reads this computer's address from the file the server writes, and nothing else", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3x-self-host-" });
      const spawned = yield* Ref.make(0);
      yield* fs.makeDirectory(`${baseDir}/userdata`, { recursive: true });
      const file = `${baseDir}/userdata/device-public-url.json`;
      const read = Effect.gen(function* () {
        return yield* (yield* DesktopSelfHost.DesktopSelfHost).deviceUrl;
      }).pipe(Effect.provide(layerFor(baseDir, spawned)), Effect.scoped);

      // Not joined: the server removes the file, or never wrote it.
      assert.strictEqual(yield* read, null);

      yield* fs.writeFileString(file, JSON.stringify({ url: "https://mac.t3.example.com" }));
      assert.deepEqual(yield* read, { url: "https://mac.t3.example.com/", tunnelConnected: false });

      // Anything that is not a bare https address is not an address.
      for (const url of ["http://mac.t3.example.com", "https://mac.t3.example.com/path", "x"]) {
        yield* fs.writeFileString(file, JSON.stringify({ url }));
        assert.strictEqual(yield* read, null, url);
      }
      yield* fs.writeFileString(file, "not json");
      assert.strictEqual(yield* read, null);
    }).pipe(
      Effect.provide(NodeServices.layer),
      Effect.provideService(HostProcess.Environment, {}),
      Effect.scoped,
    ),
  );

  it.effect(
    "calls the address connected only while the server's tunnel file says so, recently",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3x-self-host-" });
        const spawned = yield* Ref.make(0);
        yield* fs.makeDirectory(`${baseDir}/userdata/fork-tunnel`, { recursive: true });
        yield* fs.writeFileString(
          `${baseDir}/userdata/device-public-url.json`,
          JSON.stringify({ url: "https://mac.t3.example.com" }),
        );
        const now = 10 * 60 * 1000;
        yield* TestClock.setTime(now);
        const statusFile = `${baseDir}/userdata/fork-tunnel/status.json`;
        const status = (status: string, updatedAt: number) =>
          fs.writeFileString(
            statusFile,
            JSON.stringify({ serverPid: 1, frpcPid: null, status, lastError: null, updatedAt }),
          );
        const connected = Effect.gen(function* () {
          const address = yield* (yield* DesktopSelfHost.DesktopSelfHost).deviceUrl;
          return address?.tunnelConnected;
        }).pipe(Effect.provide(layerFor(baseDir, spawned)), Effect.scoped);

        assert.strictEqual(yield* connected, false, "no status file yet");
        yield* status("connected", now - 60_000);
        assert.strictEqual(yield* connected, true);
        yield* status("connected", now - 180_000);
        assert.strictEqual(yield* connected, true, "three minutes old is still a heartbeat");
        yield* status("connected", now - 180_001);
        assert.strictEqual(yield* connected, false, "a server that stopped writing");
        for (const other of ["connecting", "error", "stopped", "disabled"]) {
          yield* status(other, now);
          assert.strictEqual(yield* connected, false, other);
        }
        yield* fs.writeFileString(statusFile, "not json");
        assert.strictEqual(yield* connected, false);
      }).pipe(
        Effect.provide(NodeServices.layer),
        Effect.provideService(HostProcess.Environment, {}),
        Effect.scoped,
      ),
  );

  it("points the backend at the saved file and passes environment addresses through", () => {
    assert.deepEqual(
      DesktopSelfHost.backendEnvironment({
        publicUrlsFile: "/state/public-urls.json",
        environmentPublicUrls: ["https://a.example.com/", "https://b.example.com/"],
      }),
      {
        T3CODE_PUBLIC_URLS_FILE: "/state/public-urls.json",
        T3CODE_PUBLIC_URLS: "https://a.example.com/,https://b.example.com/",
      },
    );
  });
});
