import {
  ATTACHMENT_UPLOAD_URL_TTL_MS,
  THEME_BACKGROUND_MAX_BYTES,
  ThemeBackgroundUploadSigningError,
  type ThemeBackgroundCreateUploadUrlInput,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as Stream from "effect/Stream";

import * as AssetSigner from "../../assets/AssetSigner.ts";
import { base64UrlDecodeUtf8, base64UrlEncode } from "../../auth/utils.ts";
import * as ServerConfig from "../../config.ts";
import { storeThemeBackground, type StoreThemeBackgroundResult } from "./ThemeBackgroundStore.ts";

// fork: the signed URL a client sends a background image to. The route lives in `route.ts`.

export const THEME_BACKGROUND_UPLOAD_ROUTE_PREFIX = "/api/theme-backgrounds/upload";

const UploadClaims = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("theme-background-upload"),
  sizeBytes: Schema.Number,
  expiresAt: Schema.Number,
});
export type ThemeBackgroundUploadClaims = typeof UploadClaims.Type;

const uploadClaimsJson = Schema.fromJsonString(UploadClaims);
const decodeUploadClaims = Schema.decodeUnknownOption(uploadClaimsJson);
const encodeUploadClaims = Schema.encodeSync(uploadClaimsJson);

function decodeClaims(encodedPayload: string): ThemeBackgroundUploadClaims | null {
  try {
    return Option.getOrNull(decodeUploadClaims(base64UrlDecodeUtf8(encodedPayload)));
  } catch {
    return null;
  }
}

export const issueThemeBackgroundUploadUrl = Effect.fn("ThemeBackgroundUpload.issueUrl")(function* (
  input: ThemeBackgroundCreateUploadUrlInput,
) {
  const expiresAt = (yield* Clock.currentTimeMillis) + ATTACHMENT_UPLOAD_URL_TTL_MS;
  const encodedPayload = base64UrlEncode(
    encodeUploadClaims({
      version: 1,
      kind: "theme-background-upload",
      sizeBytes: input.sizeBytes,
      expiresAt,
    }),
  );
  const signer = yield* AssetSigner.AssetSigner;
  const signature = yield* signer
    .sign(encodedPayload)
    .pipe(Effect.mapError((cause) => new ThemeBackgroundUploadSigningError({ cause })));
  return {
    relativeUrl: `${THEME_BACKGROUND_UPLOAD_ROUTE_PREFIX}/${encodedPayload}.${signature}`,
    expiresAt,
  };
});

export const validateThemeBackgroundUploadToken = Effect.fn("ThemeBackgroundUpload.validateToken")(
  function* (token: string) {
    const [encodedPayload, signature, unexpectedSegment] = token.split(".");
    if (!encodedPayload || !signature || unexpectedSegment) return null;

    const signer = yield* AssetSigner.AssetSigner;
    const verified = yield* signer
      .verify(encodedPayload, signature)
      .pipe(Effect.orElseSucceed(() => false));
    if (!verified) return null;

    const claims = decodeClaims(encodedPayload);
    if (claims === null || claims.expiresAt <= (yield* Clock.currentTimeMillis)) return null;
    if (claims.sizeBytes < 1 || claims.sizeBytes > THEME_BACKGROUND_MAX_BYTES) return null;
    return claims;
  },
);

/** Reads exactly `claims.sizeBytes` from the body, then stores it as a background image. */
export const storeThemeBackgroundUpload = Effect.fn("ThemeBackgroundUpload.store")(function* (
  claims: ThemeBackgroundUploadClaims,
  body: HttpServerRequest.HttpServerRequest["stream"],
) {
  const { environmentThemesDir } = yield* ServerConfig.ServerConfig;
  const chunks: Array<Uint8Array> = [];
  let received = 0;
  yield* Stream.runForEach(
    body.pipe(
      Stream.takeWhile((chunk) => {
        received += chunk.byteLength;
        return received <= claims.sizeBytes;
      }),
    ),
    (chunk) => Effect.sync(() => void chunks.push(chunk)),
  );
  if (received !== claims.sizeBytes) {
    return {
      ok: false,
      status: 400,
      detail: `Body was ${received} bytes, expected ${claims.sizeBytes}.`,
    } satisfies StoreThemeBackgroundResult;
  }
  return storeThemeBackground(environmentThemesDir, Buffer.concat(chunks));
});
