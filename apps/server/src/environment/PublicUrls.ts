import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  encodePublicUrlsDocument,
  normalizePublicUrls,
  parsePublicUrlList,
  parsePublicUrlsDocument,
  PUBLIC_URLS_ENV,
  PUBLIC_URLS_FILE_ENV,
  PUBLIC_URLS_FILE_NAME,
} from "@t3tools/shared/selfHost";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import { readDevicePublicUrl } from "../fork/deviceKeys/devicePublicUrl.ts"; // fork: self-hosted pairing

export class PublicUrlsWriteError extends Schema.TaggedError<PublicUrlsWriteError>()(
  "PublicUrlsWriteError",
  {
    path: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to save public URLs to ${this.path}.`;
  }
}

/**
 * HTTPS origins the owner put in front of this server, such as a reverse
 * tunnel on their own VPS. Reported to clients as `public` direct endpoints.
 * Saved ones are re-read on every call, so desktop edits apply without a
 * restart and a removed URL stops being reported at once.
 */
export class PublicUrls extends Context.Service<
  PublicUrls,
  {
    readonly list: Effect.Effect<ReadonlyArray<string>>;
  }
>()("t3/environment/PublicUrls") {}

/** Desktop names its own settings file; headless servers keep it with their state. */
const resolvePublicUrlsFilePath = Effect.fn("PublicUrls.resolveFilePath")(function* (
  stateDir: string,
) {
  const path = yield* Path.Path;
  const override = (yield* HostProcess.Environment)[PUBLIC_URLS_FILE_ENV]?.trim();
  return override !== undefined && override.length > 0
    ? override
    : path.join(stateDir, PUBLIC_URLS_FILE_NAME);
});

/** Replaces the saved list; `t3 serve --public-url` and `t3 up --public-url` call this. */
export const savePublicUrls = Effect.fn("PublicUrls.save")(function* (
  stateDir: string,
  urls: ReadonlyArray<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const filePath = yield* resolvePublicUrlsFilePath(stateDir);
  const tempPath = `${filePath}.${process.pid}.tmp`;
  yield* fs.makeDirectory(path.dirname(filePath), { recursive: true }).pipe(
    Effect.andThen(fs.writeFileString(tempPath, encodePublicUrlsDocument(urls))),
    Effect.andThen(fs.rename(tempPath, filePath)),
    Effect.mapError((cause) => new PublicUrlsWriteError({ path: filePath, cause })),
  );
  return normalizePublicUrls(urls);
});

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const filePath = yield* resolvePublicUrlsFilePath(config.stateDir);
  const readDevice = yield* readDevicePublicUrl(config.stateDir); // fork: this computer's own address
  const fromEnvironment = parsePublicUrlList((yield* HostProcess.Environment)[PUBLIC_URLS_ENV]);

  const list = fs.readFileString(filePath).pipe(
    Effect.map(parsePublicUrlsDocument),
    Effect.orElseSucceed((): ReadonlyArray<string> => []),
    Effect.flatMap((saved) =>
      Effect.map(readDevice, (device) =>
        normalizePublicUrls([...fromEnvironment, ...saved, ...device]),
      ),
    ),
    Effect.withSpan("PublicUrls.list"),
  );

  return PublicUrls.of({ list });
});

export const layer = Layer.effect(PublicUrls, make);

/** A fixed list, for tests and callers with no state directory. */
export const layerStatic = (urls: ReadonlyArray<string>) =>
  Layer.succeed(PublicUrls, PublicUrls.of({ list: Effect.succeed(normalizePublicUrls(urls)) }));
