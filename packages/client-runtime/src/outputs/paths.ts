import { resolvePathLinkTarget, splitFilePathPosition } from "@t3tools/shared/fileLinks";
import {
  isAbsolutePath,
  isNetworkPath,
  isWindowsAbsolutePath,
  stripSlashPrefixedWindowsDrive,
} from "@t3tools/shared/path";

export interface NormalizedOutputPath {
  /** Absolute, with `.`, `..` and repeated separators collapsed and any `:line` removed. */
  readonly path: string;
  readonly line?: number;
}

function collapseSegments(path: string): string | null {
  // A folder, or a UNC share that would make Windows sign in to a remote host, is no output file.
  if (isNetworkPath(path) || /[\\/]$/.test(path)) return null;
  const windows = isWindowsAbsolutePath(path);
  const parts = windows ? path.split(/[\\/]+/) : path.split("/");
  const root = windows ? parts.shift() : "";
  const stack: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") stack.pop();
    else stack.push(part);
  }
  if (stack.length === 0) return null;
  return windows ? `${root}\\${stack.join("\\")}` : `/${stack.join("/")}`;
}

/** Resolves `raw` against `cwd` when it is relative; null when no absolute file path comes out. */
export function normalizeOutputPath(
  raw: string,
  cwd: string | undefined,
): NormalizedOutputPath | null {
  const position = splitFilePathPosition(raw.trim());
  const path = stripSlashPrefixedWindowsDrive(position.path);
  if (path.length === 0) return null;
  let absolute = path;
  if (!isAbsolutePath(path)) {
    if (cwd === undefined || cwd.length === 0) return null;
    absolute = resolvePathLinkTarget(path, cwd);
  }
  if (!isAbsolutePath(absolute)) return null;
  const collapsed = collapseSegments(absolute);
  if (collapsed === null) return null;
  return { path: collapsed, ...(position.line === undefined ? {} : { line: position.line }) };
}

/** Windows paths ignore case; everything else keeps it. */
export function outputPathKey(path: string): string {
  return isWindowsAbsolutePath(path) ? path.toLowerCase() : path;
}

const NOISE_SEGMENT_PATTERN = /(?:^|[\\/])(?:node_modules|\.git)[\\/]/;

/** Dependency and VCS internals that tools rewrite as a side effect, never as a result. */
export function isNoiseOutputPath(path: string): boolean {
  return NOISE_SEGMENT_PATTERN.test(path);
}

const DELETED_KIND_PATTERN = /^(?:d|del|delete|deleted|remove|removed|rm)$/i;

export function isDeletedChangeKind(kind: string): boolean {
  return DELETED_KIND_PATTERN.test(kind.trim());
}
