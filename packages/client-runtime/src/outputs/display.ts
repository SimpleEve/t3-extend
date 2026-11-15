import { fileBasename, workspaceRelativeFilePath } from "@t3tools/shared/path";

/** Every outputs list shows this many rows before "Show N more". */
export const OUTPUT_ROW_LIMIT = 6;

export function visibleOutputRows<T>(
  rows: ReadonlyArray<T>,
  expanded: boolean,
): {
  readonly visible: ReadonlyArray<T>;
  readonly hiddenCount: number;
  /** Expanded past the limit, so "Show less" has something to fold back. */
  readonly canCollapse: boolean;
} {
  if (rows.length <= OUTPUT_ROW_LIMIT) return { visible: rows, hiddenCount: 0, canCollapse: false };
  if (expanded) return { visible: rows, hiddenCount: 0, canCollapse: true };
  return {
    visible: rows.slice(0, OUTPUT_ROW_LIMIT),
    hiddenCount: rows.length - OUTPUT_ROW_LIMIT,
    canCollapse: false,
  };
}

/**
 * How many trailing characters of a folder path stay whole when it is cut to fit: the last
 * segment with its separator, so a cut path ends in `/visual`. Undefined leaves it to the
 * component's default (a single segment has no separator to keep).
 */
export function outputDirectoryTail(directory: string): number | undefined {
  const separator = Math.max(directory.lastIndexOf("/"), directory.lastIndexOf("\\"));
  return separator > 0 ? directory.length - separator : undefined;
}

/**
 * A run that rewrites a whole tree must not turn its strip into the tree. The cut is shown as a
 * "not listed" row, and the counts people see stay the real totals.
 */
export const RUN_OUTPUT_FILE_LIMIT = 100;
export const RUN_OUTPUT_LINK_LIMIT = 50;

export function limitOutputRows<T>(
  rows: ReadonlyArray<T>,
  limit: number,
): { readonly rows: ReadonlyArray<T>; readonly omitted: number } {
  return rows.length <= limit
    ? { rows, omitted: 0 }
    : { rows: rows.slice(0, limit), omitted: rows.length - limit };
}

/** The path the file panel opens: relative to the thread's workspace, null anywhere else. */
export function workspacePreviewPath(
  path: string,
  workspaceRoot: string | undefined,
): string | null {
  const relative = workspaceRelativeFilePath(path, workspaceRoot);
  return relative === null || relative === "." ? null : relative;
}

export function outputFileDisplay(
  path: string,
  workspaceRoot: string | undefined,
): { readonly name: string; readonly directory: string } {
  const name = fileBasename(path);
  const shown = workspacePreviewPath(path, workspaceRoot) ?? path;
  const separator = Math.max(shown.lastIndexOf("/"), shown.lastIndexOf("\\"));
  return { name, directory: separator > 0 ? shown.slice(0, separator) : "" };
}

export function outputLinkDisplay(url: string): { readonly host: string; readonly path: string } {
  try {
    const parsed = new URL(url);
    return {
      host: parsed.host,
      path: `${parsed.pathname === "/" ? "" : parsed.pathname}${parsed.search}${parsed.hash}`,
    };
  } catch {
    return { host: url, path: "" };
  }
}
