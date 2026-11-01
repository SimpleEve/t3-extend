import { normalizePublicUrl } from "@t3tools/shared/selfHost";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Flag } from "effect/cli";

import * as ServerConfig from "../config.ts";
import { savePublicUrls } from "../environment/PublicUrls.ts";

const PublicUrlString = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((value) => normalizePublicUrl(value) !== null, {
      expected: "an https:// origin with no path, such as https://t3.example.com",
    }),
  ),
);

/** fork: self-hosted public route. Saved in the server's state, so an installed service keeps them. */
export const publicUrlFlags = {
  publicUrl: Flag.String("public-url").pipe(
    Flag.withSchema(PublicUrlString),
    Flag.withDescription(
      "HTTPS address you put in front of this server, such as a reverse tunnel on your own VPS. Paired devices learn it as a route. Repeat for several; replaces the saved list. Also read from T3CODE_PUBLIC_URLS.",
    ),
    Flag.atLeast(0),
  ),
  clearPublicUrls: Flag.Boolean("clear-public-urls").pipe(
    Flag.withDescription("Forget the saved --public-url addresses."),
    Flag.withDefault(false),
  ),
} as const;

export interface PublicUrlFlags {
  readonly publicUrl: ReadonlyArray<string>;
  readonly clearPublicUrls: boolean;
}

export const applyPublicUrlFlags = Effect.fn("cli.applyPublicUrlFlags")(function* (
  flags: PublicUrlFlags,
) {
  const urls = flags.publicUrl;
  if (!flags.clearPublicUrls && urls.length === 0) return;
  const { stateDir } = yield* ServerConfig.ServerConfig;
  const saved = yield* savePublicUrls(stateDir, flags.clearPublicUrls ? [] : urls);
  yield* Console.log(
    saved.length === 0
      ? "Public URLs cleared."
      : `Public URLs saved: ${saved.join(", ")}. Pair with \`t3 pair --base-url ${saved[0]}\`.`,
  );
});
