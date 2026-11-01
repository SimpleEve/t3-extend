import { describe, expect, it, vi } from "vite-plus/test";

const navigation = vi.hoisted(() => ({
  ready: false,
  dispatch: vi.fn(),
  queue: [] as Array<() => void>,
}));

vi.mock("react-native", () => ({ Platform: { OS: "android" } }));
vi.mock("@react-navigation/native", () => ({
  CommonActions: { navigate: (payload: object) => ({ type: "NAVIGATE", payload }) },
}));
vi.mock("../lib/rootNavigation", () => ({
  rootNavigationRef: { isReady: () => navigation.ready, dispatch: navigation.dispatch },
  whenRootNavigationReady: (navigate: () => void) =>
    navigation.ready ? navigate() : navigation.queue.push(navigate),
}));

import {
  deferInitialLinkSheet,
  splashScreenHidden,
  splitInitialLinkSheet,
} from "./initialLinkSheet";

const isSheet = (name: string) => name === "ConnectionsNew";
const pairLink = {
  index: 1,
  routes: [{ name: "Home" }, { name: "ConnectionsNew", params: { pairingUrl: "http://h/pair" } }],
};

describe("splitInitialLinkSheet", () => {
  it("splits the top sheet off and keeps the routes under it", () => {
    expect(splitInitialLinkSheet(pairLink, isSheet)).toEqual({
      state: { index: 0, routes: [{ name: "Home" }] },
      sheet: pairLink.routes[1],
    });
  });

  it("leaves links without a top sheet, or with nothing under it, unchanged", () => {
    const settings = { routes: [{ name: "Home" }, { name: "SettingsEnvironmentNew" }] };
    expect(splitInitialLinkSheet(settings, isSheet)).toEqual({ state: settings });
    const lone = { routes: [{ name: "ConnectionsNew" }] };
    expect(splitInitialLinkSheet(lone, isSheet)).toEqual({ state: lone });
    expect(splitInitialLinkSheet(undefined, isSheet)).toEqual({ state: undefined });
  });
});

describe("deferInitialLinkSheet", () => {
  it("opens a cold-start sheet once the splash screen is gone and the navigator is ready", async () => {
    expect(deferInitialLinkSheet(pairLink, isSheet)).toEqual({
      index: 0,
      routes: [{ name: "Home" }],
    });
    await Promise.resolve();
    expect(navigation.queue).toHaveLength(0);

    splashScreenHidden();
    await Promise.resolve();
    expect(navigation.queue).toHaveLength(1);
    expect(navigation.dispatch).not.toHaveBeenCalled();

    navigation.ready = true;
    navigation.queue.shift()?.();
    expect(navigation.dispatch).toHaveBeenCalledExactlyOnceWith({
      type: "NAVIGATE",
      payload: { name: "ConnectionsNew", params: { pairingUrl: "http://h/pair" } },
    });

    // Links that arrive while the app runs navigate to the sheet directly.
    expect(deferInitialLinkSheet(pairLink, isSheet)).toBe(pairLink);
  });
});
