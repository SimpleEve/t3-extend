import type { ProjectEntry } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  isExpandableEntry,
  isFolderEntry,
  isOpenableEntry,
  projectSymlinkTitle,
} from "./projectSymlink.ts";

const entries: ReadonlyArray<ProjectEntry> = [
  { path: "a.txt", kind: "file" },
  { path: "src", kind: "directory" },
  { path: "inside.txt", kind: "file", symlink: {} },
  { path: "data", kind: "directory", symlink: { target: "/data" } },
  { path: "gone", kind: "file", symlink: { target: "missing", broken: true } },
  { path: "up", kind: "file", symlink: { target: "..", cycle: true } },
  { path: "slow", kind: "file", symlink: { target: "/mnt/slow", unresolved: true } },
];

const matching = (predicate: (entry: ProjectEntry) => boolean) =>
  entries.filter(predicate).map((entry) => entry.path);

describe("project symlinks", () => {
  it("opens links like the files they lead to, unless nothing is known to be there", () => {
    expect(matching(isOpenableEntry)).toEqual(["a.txt", "inside.txt"]);
  });

  it("expands links like the folders they lead to, but not ones that loop", () => {
    expect(matching(isExpandableEntry)).toEqual(["src", "data"]);
    // A loop still looks like a folder.
    expect(matching(isFolderEntry)).toEqual(["src", "data", "up"]);
  });

  it("does not expand a loop however the server typed it", () => {
    expect(isExpandableEntry({ kind: "directory", symlink: { target: "..", cycle: true } })).toBe(
      false,
    );
  });

  it("says where each link leads and what is wrong with it", () => {
    expect(
      entries.flatMap((entry) => (entry.symlink ? [projectSymlinkTitle(entry.symlink)] : [])),
    ).toEqual([
      "Symbolic link",
      "Symbolic link to /data",
      "Broken symbolic link to missing",
      "Symbolic link to .. (loops back to a parent folder)",
      "Symbolic link to /mnt/slow (could not be resolved in time)",
    ]);
  });
});
