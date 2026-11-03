// The computer's own address reaches `PublicUrls` from the file the join leaves in the state directory.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../../config.ts";
import * as PublicUrls from "../../environment/PublicUrls.ts";
import { DEVICE_PUBLIC_URL_FILE } from "./devicePublicUrl.ts";

const layerConfig = ServerConfig.layerTest(process.cwd(), { prefix: "t3-device-url-" }).pipe(
  Layer.provide(NodeServices.layer),
);

describe("device-public-url.json", () => {
  it.effect(
    "is reported with the other public URLs, re-read each time, and ignored when broken",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { stateDir } = yield* ServerConfig.ServerConfig;
        const file = path.join(stateDir, DEVICE_PUBLIC_URL_FILE);
        const service = yield* PublicUrls.PublicUrls.pipe(
          Effect.provide(PublicUrls.layer),
          Effect.provideService(HostProcess.Environment, {
            T3CODE_PUBLIC_URLS: "https://own.example.com",
          }),
        );
        assert.deepEqual(yield* service.list, ["https://own.example.com/"]);

        yield* fs.writeFileString(file, '{"url":"https://studio.t3.example.test"}');
        assert.deepEqual(yield* service.list, [
          "https://own.example.com/",
          "https://studio.t3.example.test/",
        ]);

        yield* fs.writeFileString(file, '{"url":"http://not-https.example"}');
        assert.deepEqual(yield* service.list, ["https://own.example.com/"]);
        yield* fs.writeFileString(file, "not json");
        assert.deepEqual(yield* service.list, ["https://own.example.com/"]);
        yield* fs.remove(file);
        assert.deepEqual(yield* service.list, ["https://own.example.com/"]);
      }).pipe(Effect.provide(Layer.merge(layerConfig, NodeServices.layer))),
  );
});
