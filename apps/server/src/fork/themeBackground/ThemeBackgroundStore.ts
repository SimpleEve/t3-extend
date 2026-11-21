// @effect-diagnostics nodeBuiltinImport:off - hashing and exclusive writes are filesystem boundaries Effect does not wrap.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { THEME_BACKGROUND_HASH_PATTERN, THEME_BACKGROUND_MAX_BYTES } from "@t3tools/contracts";

// fork: background images chosen in the theme studio. They are stored once per picture, named by
// the SHA-256 of their bytes, in `backgrounds/` inside the environment's themes directory. A theme's
// look records the hash, so every client of the environment can fetch the same image.

const THEME_BACKGROUND_DIRECTORY = "backgrounds";

/**
 * The most pictures kept. The server cannot see which schemes on which browsers still use one, so
 * it never deletes any; a cap keeps a person who tries many pictures from filling the disk.
 */
export const MAX_STORED_THEME_BACKGROUNDS = 64;

const EXTENSIONS = ["webp", "png", "jpg"] as const;
type BackgroundExtension = (typeof EXTENSIONS)[number];

const MIME_TYPES: Readonly<Record<BackgroundExtension, string>> = {
  webp: "image/webp",
  png: "image/png",
  jpg: "image/jpeg",
};

const startsWith = (bytes: Uint8Array, offset: number, signature: ReadonlyArray<number>) =>
  signature.every((value, index) => bytes[offset + index] === value);

/** Decides the type from the bytes. The name and the declared type of an upload are not trusted. */
export function sniffThemeBackground(
  bytes: Uint8Array,
): { readonly extension: BackgroundExtension; readonly mimeType: string } | null {
  const extension: BackgroundExtension | null = startsWith(bytes, 0, [0xff, 0xd8, 0xff])
    ? "jpg"
    : startsWith(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      ? "png"
      : startsWith(bytes, 0, [0x52, 0x49, 0x46, 0x46]) &&
          startsWith(bytes, 8, [0x57, 0x45, 0x42, 0x50])
        ? "webp"
        : null;
  return extension === null ? null : { extension, mimeType: MIME_TYPES[extension] };
}

export const themeBackgroundDirectory = (themesDir: string): string =>
  NodePath.join(themesDir, THEME_BACKGROUND_DIRECTORY);

/** The stored picture for `hash`, or null. A hash that is not 64 hex digits never reaches the disk. */
export function findStoredThemeBackground(
  themesDir: string,
  hash: string,
): { readonly path: string; readonly mimeType: string } | null {
  if (!THEME_BACKGROUND_HASH_PATTERN.test(hash)) return null;
  for (const extension of EXTENSIONS) {
    const filePath = NodePath.join(themeBackgroundDirectory(themesDir), `${hash}.${extension}`);
    try {
      const info = NodeFS.lstatSync(filePath);
      if (info.isFile() && info.size <= THEME_BACKGROUND_MAX_BYTES) {
        return { path: filePath, mimeType: MIME_TYPES[extension] };
      }
    } catch {
      continue;
    }
  }
  return null;
}

export type StoreThemeBackgroundResult =
  | { readonly ok: true; readonly hash: string }
  | { readonly ok: false; readonly status: number; readonly detail: string };

/**
 * Stores one picture. The same bytes sent again are not written again. Nothing here yields, so
 * the cap check and the write cannot interleave with another upload in this process.
 */
export function storeThemeBackground(
  themesDir: string,
  bytes: Uint8Array,
): StoreThemeBackgroundResult {
  if (bytes.byteLength === 0 || bytes.byteLength > THEME_BACKGROUND_MAX_BYTES) {
    return {
      ok: false,
      status: 413,
      detail: `A background image must be up to ${THEME_BACKGROUND_MAX_BYTES / (1024 * 1024)} MB.`,
    };
  }
  const type = sniffThemeBackground(bytes);
  if (type === null) {
    return { ok: false, status: 415, detail: "A background image must be a JPEG, PNG or WebP." };
  }
  const hash = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
  if (findStoredThemeBackground(themesDir, hash) !== null) return { ok: true, hash };

  const directory = themeBackgroundDirectory(themesDir);
  try {
    NodeFS.mkdirSync(directory, { recursive: true });
    const stored = NodeFS.readdirSync(directory).filter((name) => !name.endsWith(".part"));
    if (stored.length >= MAX_STORED_THEME_BACKGROUNDS) {
      return {
        ok: false,
        status: 507,
        detail: `This server already keeps ${MAX_STORED_THEME_BACKGROUNDS} background images. Delete some from the backgrounds folder of its themes directory.`,
      };
    }
    const finalPath = NodePath.join(directory, `${hash}.${type.extension}`);
    // Exclusive create, so a link left at the staging path is never written through.
    const partPath = `${finalPath}.${NodeCrypto.randomUUID()}.part`;
    try {
      NodeFS.writeFileSync(partPath, bytes, { flag: "wx", mode: 0o600 });
      NodeFS.renameSync(partPath, finalPath);
    } finally {
      NodeFS.rmSync(partPath, { force: true });
    }
    return { ok: true, hash };
  } catch {
    // A rename that lost to another writer of the same bytes (another process) still stored it.
    if (findStoredThemeBackground(themesDir, hash) !== null) return { ok: true, hash };
    return { ok: false, status: 500, detail: "Failed to store the background image." };
  }
}
