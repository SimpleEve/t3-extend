// fork: `device-public-url.json` mirrors this computer's membership: written while it belongs to a
// server, removed when it leaves or is removed. `PublicUrls` (8.2) reads it on every call.
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { DEVICE_PUBLIC_URL_FILE } from "./devicePublicUrl.ts";

const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Struct({ url: Schema.String })));

/** Replaced whole (write then rename), so a reader never sees half a file. */
export const writeDevicePublicUrl = Effect.fn("DevicePublicUrl.write")(function* (
  stateDir: string,
  url: Option.Option<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = path.join(stateDir, DEVICE_PUBLIC_URL_FILE);
  if (Option.isNone(url)) {
    yield* fs.remove(file, { force: true });
    return;
  }
  const partial = `${file}.partial`;
  yield* fs.writeFileString(partial, encode({ url: url.value }), { mode: 0o600 });
  yield* fs.rename(partial, file);
});
