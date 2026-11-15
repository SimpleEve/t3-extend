import { fileBasename, workspaceRelativeFilePath } from "@t3tools/shared/path";

/** Every outputs list shows this many rows before "Show N more". */
export const OUTPUT_ROW_LIMIT = 6;

export function visibleOutputRows<T>(
  rows: ReadonlyArray<T>,
  expanded: boolean,
): { readonly visible: ReadonlyArray<T>; readonly hiddenCount: number } {
  if (expanded || rows.length <= OUTPUT_ROW_LIMIT) return { visible: rows, hiddenCount: 0 };
  return { visible: rows.slice(0, OUTPUT_ROW_LIMIT), hiddenCount: rows.length - OUTPUT_ROW_LIMIT };
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
