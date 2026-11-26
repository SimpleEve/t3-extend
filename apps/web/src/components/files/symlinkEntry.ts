import type { ProjectEntry, ProjectEntrySymlink } from "@t3tools/contracts";
import { msg } from "gt-react";

import { m, type MessageResolver } from "~/i18n/messages";

/** Where a symlink's entry stands in the tree; `plain` is every other entry. */
export type SymlinkEntryState = "plain" | "link" | "broken" | "cycle";

export function symlinkEntryState(entry: Pick<ProjectEntry, "symlink">): SymlinkEntryState {
  if (!entry.symlink) return "plain";
  return entry.symlink.broken ? "broken" : entry.symlink.cycle ? "cycle" : "link";
}

/**
 * A link to a folder that contains the one listed stays a leaf: expanding it would list the same
 * folders again, and "Expand all folders" would never stop.
 */
export function isExpandableDirectory(entry: ProjectEntry): boolean {
  return entry.kind === "directory" && symlinkEntryState(entry) !== "cycle";
}

/** A broken link is listed so it can be seen, but nothing is there to open. */
export function isOpenableFile(entry: ProjectEntry): boolean {
  return entry.kind === "file" && symlinkEntryState(entry) !== "broken";
}

/** What a link's marker says when hovered; `target` is the link's own text, a path, so it stays as is. */
export function symlinkEntryTitle(
  symlink: ProjectEntrySymlink,
  resolve: MessageResolver = m,
): string {
  const target = symlink.target;
  if (symlink.broken) return resolve(msg("Broken symbolic link to {target}", { target }));
  if (symlink.cycle) {
    return resolve(
      msg(
        "Symbolic link to {target}, which leads back to a parent folder, so it is not expanded.",
        {
          target,
        },
      ),
    );
  }
  return resolve(msg("Symbolic link to {target}", { target }));
}
