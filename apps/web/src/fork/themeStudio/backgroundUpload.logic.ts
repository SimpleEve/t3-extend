import { THEME_BACKGROUND_MAX_BYTES } from "@t3tools/contracts";

// fork: what the studio checks before it sends a picture, and how it names a refusal. The server
// decides from the bytes; these checks only save a long upload that would be refused.

export const THEME_BACKGROUND_ACCEPT = "image/jpeg,image/png,image/webp";

const ACCEPTED_TYPES: ReadonlySet<string> = new Set(THEME_BACKGROUND_ACCEPT.split(","));

export type BackgroundRefusal = "type" | "size" | "full" | "failed";

/** The reason a picture will not do, or null. An empty declared type is left to the server. */
export function checkBackgroundFile(file: {
  readonly type: string;
  readonly size: number;
}): "type" | "size" | null {
  if (file.type !== "" && !ACCEPTED_TYPES.has(file.type.toLowerCase())) return "type";
  if (file.size < 1 || file.size > THEME_BACKGROUND_MAX_BYTES) return "size";
  return null;
}

/** What the upload route's status means to a person. */
export function refusalOfStatus(status: number): BackgroundRefusal {
  if (status === 415) return "type";
  if (status === 413) return "size";
  if (status === 507) return "full";
  return "failed";
}
