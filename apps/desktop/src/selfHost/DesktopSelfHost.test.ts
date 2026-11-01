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
        return {
          state,
          file: yield* fs.readFileString(DesktopSelfHost.publicUrlsFilePath(environment)),
          publicUrls: yield* selfHost.publicUrls,
        };
      }).pipe(Effect.provide(layerFor(baseDir, spawned, env)), Effect.scoped);

      assert.deepEqual(first.state.publicUrls, ["https://t3.example.com/"]);
      assert.deepEqual(first.state.environmentPublicUrls, ["https://env.example.com/"]);
      assert.deepEqual(first.publicUrls, ["https://env.example.com/", "https://t3.example.com/"]);
      assert.include(first.file, "https://t3.example.com/");
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
