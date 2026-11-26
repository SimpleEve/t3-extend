import type { ProjectEntry } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { isExpandableDirectory, isOpenableFile, symlinkEntryState } from "./symlinkEntry";

const entries: Record<string, ProjectEntry> = {
  file: { path: "a.txt", kind: "file" },
  folder: { path: "src", kind: "directory" },
  fileLink: { path: "l.txt", kind: "file", symlink: { target: "../a.txt" } },
  folderLink: { path: "l", kind: "directory", symlink: { target: "/data" } },
  broken: { path: "gone", kind: "file", symlink: { target: "missing", broken: true } },
  cycle: { path: "up", kind: "directory", symlink: { target: "..", cycle: true } },
};

describe("symlink entries", () => {
  it("names the state of each entry", () => {
    expect(Object.values(entries).map(symlinkEntryState)).toEqual([
      "plain",
      "plain",
      "link",
      "link",
      "broken",
      "cycle",
    ]);
  });

  it("opens links like the files they lead to, but not broken ones", () => {
    expect(Object.values(entries).map(isOpenableFile)).toEqual([
      true,
      false,
      true,
      false,
      false,
      false,
    ]);
  });

  it("expands links like the folders they lead to, but not ones that loop", () => {
    expect(Object.values(entries).map(isExpandableDirectory)).toEqual([
      false,
      true,
      false,
      true,
      false,
      false,
    ]);
  });
});
