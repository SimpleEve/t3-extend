// fork: progress of the server's headless browser download, sent as the reason of a close code so a
// viewer that attaches meanwhile can show it. A server or client without it falls back to retrying.
import * as Schema from "effect/Schema";

/** JSON reason for preview stream close code 4504; must fit the 123-byte close-reason limit. */
export const PreviewStreamHostInstalling = Schema.Struct({
  downloadedBytes: Schema.Number,
  totalBytes: Schema.Number,
  unpacking: Schema.Boolean,
});
export type PreviewStreamHostInstalling = typeof PreviewStreamHostInstalling.Type;
export const PREVIEW_STREAM_HOST_INSTALLING_CLOSE_CODE = 4504;
