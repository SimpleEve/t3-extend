// fork: this computer's own https://<subdomain>.<domain>, written beside the state when it joins a
// server and read by `PublicUrls` so already-paired clients learn it as a `public` endpoint.
import { normalizePublicUrls } from "@t3tools/shared/selfHost";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

export const DEVICE_PUBLIC_URL_FILE = "device-public-url.json";

const decode = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ url: Schema.String })),
);

/** Re-reads the file on every call; a missing or unreadable one means no address. */
export const readDevicePublicUrl = Effect.fn("DevicePublicUrl.read")(function* (stateDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = path.join(stateDir, DEVICE_PUBLIC_URL_FILE);
  return fs.readFileString(file).pipe(
    Effect.map((raw) => {
      const parsed = decode(raw);
      return parsed._tag === "Some" ? normalizePublicUrls([parsed.value.url]) : [];
    }),
    Effect.orElseSucceed((): ReadonlyArray<string> => []),
  );
});
