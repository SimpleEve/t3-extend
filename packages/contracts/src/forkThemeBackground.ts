import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";

import { AuthSettingsWriteScope, EnvironmentAuthorizationError } from "./auth.ts";
import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { THEME_BACKGROUND_MAX_BYTES } from "./forkThemeLook.ts";

// fork: a background image chosen in the theme studio lives on the environment, so every device
// connected to it can show it. The bytes travel over HTTP to a signed, short-lived URL, the way an
// attachment does; the socket carries only the request for that URL.

export const FORK_THEME_BACKGROUND_WS_METHODS = {
  createUploadUrl: "themeBackgrounds.createUploadUrl",
} as const;

export const ThemeBackgroundCreateUploadUrlInput = Schema.Struct({
  sizeBytes: NonNegativeInt.check(
    Schema.isGreaterThanOrEqualTo(1),
    Schema.isLessThanOrEqualTo(THEME_BACKGROUND_MAX_BYTES),
  ),
});
export type ThemeBackgroundCreateUploadUrlInput = typeof ThemeBackgroundCreateUploadUrlInput.Type;

export const ThemeBackgroundCreateUploadUrlResult = Schema.Struct({
  relativeUrl: TrimmedNonEmptyString.check(
    Schema.isMaxLength(4096),
    Schema.isPattern(/^\/api\/theme-backgrounds\/upload\/[\w.-]+$/u),
  ),
  expiresAt: Schema.Number,
});
export type ThemeBackgroundCreateUploadUrlResult = typeof ThemeBackgroundCreateUploadUrlResult.Type;

/** What the upload route answers with once the image is stored. */
export const ThemeBackgroundUploadResult = Schema.Struct({
  hash: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
});
export type ThemeBackgroundUploadResult = typeof ThemeBackgroundUploadResult.Type;

export class ThemeBackgroundUploadSigningError extends Schema.TaggedError<ThemeBackgroundUploadSigningError>()(
  "ThemeBackgroundUploadSigningError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to prepare the background image upload.";
  }
}

const WsThemeBackgroundCreateUploadUrlRpc = Rpc.make(
  FORK_THEME_BACKGROUND_WS_METHODS.createUploadUrl,
  {
    payload: ThemeBackgroundCreateUploadUrlInput,
    success: ThemeBackgroundCreateUploadUrlResult,
    error: Schema.Union([ThemeBackgroundUploadSigningError, EnvironmentAuthorizationError]),
  },
);

export const FORK_THEME_BACKGROUND_RPCS = [WsThemeBackgroundCreateUploadUrlRpc] as const;

/** The image becomes part of the environment's themes, so it takes the grant that writing settings does. */
export const FORK_THEME_BACKGROUND_GUARDED_RPC_SCOPES = {
  [FORK_THEME_BACKGROUND_WS_METHODS.createUploadUrl]: AuthSettingsWriteScope,
} as const;
