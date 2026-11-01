import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { describe, expect } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import * as PublicUrls from "./PublicUrls.ts";

const layerConfig = ServerConfig.layerTest(process.cwd(), { prefix: "t3-public-urls-" }).pipe(
  Layer.provide(NodeServices.layer),
);

const withEnvironment = (environment: NodeJS.ProcessEnv) =>
  Effect.provideService(HostProcess.Environment, environment);

describe("PublicUrls", () => {
  it.effect("re-reads saved URLs on every call, so removing one stops reporting it", () =>
    Effect.gen(function* () {
      const { stateDir } = yield* ServerConfig.ServerConfig;
      const environment = {};
      const service = yield* PublicUrls.PublicUrls.pipe(
        Effect.provide(PublicUrls.layer),
        withEnvironment(environment),
      );
      expect(yield* service.list).toEqual([]);

      yield* PublicUrls.savePublicUrls(stateDir, [
        "https://t3.example.com",
        "http://plain.example",
      ]).pipe(withEnvironment(environment));
      expect(yield* service.list).toEqual(["https://t3.example.com/"]);

      yield* PublicUrls.savePublicUrls(stateDir, []).pipe(withEnvironment(environment));
      expect(yield* service.list).toEqual([]);
    }).pipe(Effect.provide(Layer.merge(layerConfig, NodeServices.layer))),
  );

  it.effect("merges the environment list with the file desktop names", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { stateDir } = yield* ServerConfig.ServerConfig;
      const desktopFile = path.join(stateDir, "desktop", "public-urls.json");
      yield* fs.makeDirectory(path.dirname(desktopFile), { recursive: true });
      yield* fs.writeFileString(desktopFile, '{"urls":["https://b.example.com"]}');
      const environment = {
        T3CODE_PUBLIC_URLS: "https://a.example.com,https://b.example.com/",
        T3CODE_PUBLIC_URLS_FILE: desktopFile,
      };
      const service = yield* PublicUrls.PublicUrls.pipe(
        Effect.provide(PublicUrls.layer),
        withEnvironment(environment),
      );
      expect(yield* service.list).toEqual(["https://a.example.com/", "https://b.example.com/"]);
    }).pipe(Effect.provide(Layer.merge(layerConfig, NodeServices.layer))),
  );
});
