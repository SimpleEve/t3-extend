import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  forwardedLoopbackUrl,
  noteGatewayDenied,
  noteGatewayTabState,
  publishGatewayState,
  selectGatewayDenial,
  useGatewayStore,
} from "./gatewayStore";

const TAB = "tab-1";
const ENV = "env-1";

const denialFor = (port: number | null = 5173) =>
  selectGatewayDenial(useGatewayStore.getState(), {
    runtimeTabId: TAB,
    environmentId: ENV,
    port,
  });

describe("forwarded localhost URLs", () => {
  beforeEach(() => useGatewayStore.setState({ states: {} }));

  const rows: ReadonlyArray<
    readonly [
      string,
      Parameters<typeof publishGatewayState>[1] | null,
      boolean | undefined,
      string | null,
    ]
  > = [
    ["active keeps localhost", "active", undefined, "http://localhost:5173/"],
    ["the system browser is never forwarded", "active", true, null],
    ["stopped by the user", "disabled-by-user", undefined, null],
    ["plain connection", "unsupported-route", undefined, null],
    ["old server", "unsupported-server", undefined, null],
    ["no permission", "no-permission", undefined, null],
    ["not applicable", "not-applicable", undefined, null],
    ["not yet known", "unknown", undefined, null],
    ["never published", null, undefined, null],
  ];
  it.each(rows)("%s", (_name, state, systemBrowser, expected) => {
    if (state !== null) publishGatewayState(ENV, state);
    expect(forwardedLoopbackUrl(ENV, "http://localhost:5173/", systemBrowser)).toBe(expected);
  });

  it("shows an unspecified address as localhost, and leaves other hosts and other environments alone", () => {
    publishGatewayState(ENV, "active");
    expect(forwardedLoopbackUrl(ENV, "http://0.0.0.0:3000/app", undefined)).toBe(
      "http://localhost:3000/app",
    );
    expect(forwardedLoopbackUrl(ENV, "http://[::]:3000/", undefined)).toBe(
      "http://localhost:3000/",
    );
    expect(forwardedLoopbackUrl(ENV, "http://127.0.0.1:3000/", undefined)).toBe(
      "http://127.0.0.1:3000/",
    );
    expect(forwardedLoopbackUrl("env-2", "http://localhost:3000/", undefined)).toBeNull();
  });
});

describe("gateway denials", () => {
  beforeEach(() =>
    useGatewayStore.setState({ seq: 0, tabs: {}, pageDenials: {}, connectDenials: {} }),
  );

  it("shows the refusal a tab's load caused, and drops it when the tab starts another load", () => {
    noteGatewayTabState({ runtimeTabId: TAB, webContentsId: 7, loading: true });
    noteGatewayDenied({ environmentId: ENV, code: "not-owned", port: 5173, webContentsId: 7 });
    noteGatewayTabState({ runtimeTabId: TAB, webContentsId: 7, loading: false });
    expect(denialFor()?.code).toBe("not-owned");

    // The service was started and the user reloads: the old refusal no longer describes the page.
    noteGatewayTabState({ runtimeTabId: TAB, webContentsId: 7, loading: true });
    expect(denialFor()).toBeNull();
    noteGatewayTabState({ runtimeTabId: TAB, webContentsId: 7, loading: false });
    expect(denialFor()).toBeNull();
  });

  it("does not drop it on a state change within the same load", () => {
    noteGatewayTabState({ runtimeTabId: TAB, webContentsId: 7, loading: true });
    noteGatewayDenied({
      environmentId: ENV,
      code: "upstream-refused",
      port: 5173,
      webContentsId: 7,
    });
    noteGatewayTabState({ runtimeTabId: TAB, webContentsId: 7, loading: true });
    expect(denialFor()?.code).toBe("upstream-refused");
  });

  it("keeps a page's refusal to the tab that loaded it", () => {
    noteGatewayTabState({ runtimeTabId: TAB, webContentsId: 7, loading: true });
    noteGatewayTabState({ runtimeTabId: "tab-2", webContentsId: 8, loading: true });
    noteGatewayDenied({ environmentId: ENV, code: "reserved", port: 9229, webContentsId: 8 });
    expect(denialFor(null)).toBeNull();
    expect(
      selectGatewayDenial(useGatewayStore.getState(), {
        runtimeTabId: "tab-2",
        environmentId: ENV,
        port: null,
      })?.code,
    ).toBe("reserved");
  });

  it("matches a refused https or websocket connection to the port, once the load has begun", () => {
    noteGatewayDenied({
      environmentId: ENV,
      code: "tls-untrusted",
      port: 5173,
      webContentsId: undefined,
    });
    noteGatewayTabState({ runtimeTabId: TAB, webContentsId: 7, loading: true });
    // That refusal came before this load began.
    expect(denialFor()).toBeNull();

    noteGatewayDenied({
      environmentId: ENV,
      code: "offline",
      port: 5173,
      webContentsId: undefined,
    });
    expect(denialFor()?.code).toBe("offline");
    expect(denialFor(3000)).toBeNull();
    expect(denialFor(null)).toBeNull();
    expect(
      selectGatewayDenial(useGatewayStore.getState(), {
        runtimeTabId: TAB,
        environmentId: "env-2",
        port: 5173,
      }),
    ).toBeNull();
  });

  it("knows nothing of a tab it has not seen", () => {
    noteGatewayDenied({ environmentId: ENV, code: "forbidden", port: 5173, webContentsId: 7 });
    expect(denialFor()).toBeNull();
  });
});
