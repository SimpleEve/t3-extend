import { DEFAULT_CLIENT_SETTINGS, type ClientSettings } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../test/render";

const mocks = vi.hoisted(() => ({ persistedSettings: [] as unknown[] }));

vi.mock(import("~/localApi"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    ensureLocalApi: () =>
      ({
        persistence: {
          setClientSettings: async (settings: unknown) => {
            mocks.persistedSettings.push(settings);
          },
        },
      }) as never,
  };
});

import { __setClientSettingsForTests, getClientSettings } from "../hooks/useSettings";
import {
  getSidebarViewMode,
  setSidebarViewMode,
  toggleSidebarGroupCollapsed,
  useSidebarViewMode,
  useSidebarViewStore,
} from "./sidebarViewStore";

function ViewProbe() {
  return <p>view: {useSidebarViewMode()}</p>;
}

function setup(settings: Partial<ClientSettings> = {}) {
  useSidebarViewStore.setState({ collapsed: [] });
  window.localStorage.clear();
  mocks.persistedSettings.length = 0;
  const previous = getClientSettings();
  __setClientSettingsForTests({ ...DEFAULT_CLIENT_SETTINGS, ...settings });
  return {
    restore: () => __setClientSettingsForTests(previous),
    persisted: () => JSON.parse(window.localStorage.getItem("t3extend:sidebar-view:v1") ?? "null"),
  };
}

describe("sidebar view store", () => {
  it("persists folds only, and an old stored mode is ignored", () => {
    const { persisted, restore } = setup();
    using _restore = { [Symbol.dispose]: restore };
    toggleSidebarGroupCollapsed("project:worktree:env:p:/w/a");
    expect(persisted()).toEqual({ collapsed: ["project:worktree:env:p:/w/a"] });

    // A folded group opens again from the same toggle.
    toggleSidebarGroupCollapsed("project:worktree:env:p:/w/a");
    expect(persisted()).toEqual({ collapsed: [] });
  });

  it("is the Boring sidebar setting, read and written the way Labs does", async () => {
    const { restore } = setup({ boringSidebarEnabled: false });
    using _restore = { [Symbol.dispose]: restore };
    expect(getSidebarViewMode()).toBe("status");

    __setClientSettingsForTests({ ...DEFAULT_CLIENT_SETTINGS, boringSidebarEnabled: true });
    expect(getSidebarViewMode()).toBe("project");
    // router: false because the probe reads settings only.
    await using screen = await render(<ViewProbe />, { router: false });
    expect(screen.container.textContent).toBe("view: project");

    await setSidebarViewMode("status");
    expect(getClientSettings()).toMatchObject({ boringSidebarEnabled: false });
    expect(mocks.persistedSettings.at(-1)).toMatchObject({ boringSidebarEnabled: false });
    expect(getSidebarViewMode()).toBe("status");
    await vi.waitFor(() => expect(screen.container.textContent).toBe("view: status"));

    await setSidebarViewMode("project");
    expect(getClientSettings()).toMatchObject({ boringSidebarEnabled: true });
    await vi.waitFor(() => expect(screen.container.textContent).toBe("view: project"));
  });
});
