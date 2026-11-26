import { EnvironmentId, type ProjectEntry } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { FileBreadcrumbs } from "./FileBreadcrumbs";

const entries: readonly ProjectEntry[] = [
  { path: "notes.txt", kind: "file" },
  { path: "gone.txt", kind: "file", symlink: { target: "missing.txt", broken: true } },
  { path: "up", kind: "file", symlink: { target: "..", cycle: true } },
  { path: "data", kind: "directory", symlink: { target: "/mnt/data" } },
];

vi.mock("./projectFilesQueryState", () => ({
  useProjectEntriesQuery: () => ({
    data: { entries, truncated: false },
    error: null,
    isPending: false,
    refresh: () => {},
  }),
}));

describe("FileBreadcrumbs", () => {
  it("lists looping and broken links as disabled rows that say why", async () => {
    const onOpenFile = vi.fn();
    await using _screen = await render(
      <FileBreadcrumbs
        cwd="/repo"
        environmentId={EnvironmentId.make("env-crumbs")}
        onNavigateFolder={() => {}}
        onOpenFile={onOpenFile}
        projectName="repo"
        relativePath="notes.txt"
        trail="notes.txt"
        workspaceMutationId={null}
      />,
    );
    await userEvent.click(page.getByRole("button", { name: "Browse repo" }));
    const row = (name: string) => page.getByRole("menuitem", { name, exact: true });
    await expect.element(row("up")).toBeVisible();

    for (const [name, hint] of [
      ["up", "Symbolic link to .. (loops back to a parent folder)"],
      ["gone.txt", "Broken symbolic link to missing.txt"],
    ] as const) {
      expect(row(name).element().getAttribute("aria-disabled")).toBe("true");
      await userEvent.hover(row(name).element().parentElement!);
      await expect.element(page.getByText(hint, { exact: true })).toBeVisible();
    }
    // A loop sorts with the folders, after nothing else but them.
    const names = [...document.querySelectorAll('[role^="menuitem"]')].map((element) =>
      element.textContent?.trim(),
    );
    expect(names).toEqual(["data", "up", "gone.txt", "notes.txt"]);
    // A link to an ordinary folder is entered like any folder.
    expect(row("data").element().getAttribute("aria-disabled")).not.toBe("true");
  });
});
