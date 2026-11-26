import type { ProjectEntry, ProjectEntrySymlink } from "@t3tools/contracts";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

type Entry = Pick<ProjectEntry, "kind" | "symlink">;

export type ProjectSymlinkState = "link" | "broken" | "cycle" | "unresolved";

export function projectSymlinkState(symlink: ProjectEntrySymlink): ProjectSymlinkState {
  if (symlink.broken) return "broken";
  if (symlink.cycle) return "cycle";
  return symlink.unresolved ? "unresolved" : "link";
}

/** A loop is sent as a file, for older clients, but is still shown as the folder it points at. */
export function isFolderEntry(entry: Entry): boolean {
  return entry.kind === "directory" || entry.symlink?.cycle === true;
}

/** A loop is never expanded: it would only list the same folders again. */
export function isExpandableEntry(entry: Entry): boolean {
  return entry.kind === "directory" && !entry.symlink?.cycle;
}

/** Broken and unresolved links are listed so they can be seen, but there is nothing to open yet. */
export function isOpenableEntry(entry: Entry): boolean {
  return !isFolderEntry(entry) && !entry.symlink?.broken && !entry.symlink?.unresolved;
}

/** Describes a link; `target` is the link's own text, a path, so it stays as is. */
export function projectSymlinkTitle(
  symlink: ProjectEntrySymlink,
  resolve: MFunctionType = mFallback,
): string {
  const { target } = symlink;
  // The server leaves the text out of ordinary links that stay inside the workspace.
  if (target === undefined) return resolve(msg("Symbolic link"));
  switch (projectSymlinkState(symlink)) {
    case "broken":
      return resolve(msg("Broken symbolic link to {target}", { target }));
    case "cycle":
      return resolve(msg("Symbolic link to {target} (loops back to a parent folder)", { target }));
    case "unresolved":
      return resolve(
        msg("Symbolic link to {target} (not resolved yet, refresh to retry)", { target }),
      );
    case "link":
      return resolve(msg("Symbolic link to {target}", { target }));
  }
}
