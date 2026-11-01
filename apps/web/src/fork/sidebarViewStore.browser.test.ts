import { describe, expect, it } from "vite-plus/test";

import {
  getSidebarViewMode,
  setSidebarViewMode,
  toggleSidebarGroupCollapsed,
  useSidebarViewStore,
} from "./sidebarViewStore";

function setup() {
  useSidebarViewStore.setState({ mode: "status", collapsed: [] });
  window.localStorage.clear();
  return {
    persisted: () => JSON.parse(window.localStorage.getItem("t3extend:sidebar-view:v1") ?? "null"),
  };
}

describe("sidebar view store", () => {
  it("persists the view and folds, and switching views keeps each view's folds", () => {
    const { persisted } = setup();
    setSidebarViewMode("project");
    toggleSidebarGroupCollapsed("project:worktree:env:p:/w/a");
    expect(persisted()).toEqual({ mode: "project", collapsed: ["project:worktree:env:p:/w/a"] });

    setSidebarViewMode("status");
    expect(getSidebarViewMode()).toBe("status");
    expect(persisted().collapsed).toEqual(["project:worktree:env:p:/w/a"]);

    // A folded group opens again from the same toggle.
    toggleSidebarGroupCollapsed("project:worktree:env:p:/w/a");
    expect(persisted()).toEqual({ mode: "status", collapsed: [] });
  });
});
