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

const denialFor = (port: number | null = 5173, loadFailed = true) =>
  selectGatewayDenial(useGatewayStore.getState(), {
    runtimeTabId: TAB,
    environmentId: ENV,
    port,
    loadFailed,
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

  it("keeps a refusal that came before the tab learned of its webview, when that load is then reported as running", () => {
    // A new tab's webview starts loading as soon as it attaches; the tab is bound to it afterwards.
    noteGatewayDenied({ environmentId: ENV, code: "not-owned", port: 5173, webContentsId: 7 });
    noteGatewayTabState({ runtimeTabId: TAB, webContentsId: null, loading: false });
    noteGatewayTabState({ runtimeTabId: TAB, webContentsId: 7, loading: true });
    expect(denialFor()?.code).toBe("not-owned");

    // Only the first load is counted this way: the next one retires it as usual.
    noteGatewayTabState({ runtimeTabId: TAB, webContentsId: 7, loading: false });
    noteGatewayTabState({ runtimeTabId: TAB, webContentsId: 7, loading: true });
    expect(denialFor()).toBeNull();
  });

  it("keeps a refusal that comes while its bound tab still reads as idle, when the load is then reported as running", () => {
    // A new tab is Idle until its first URL commits (`computeNavStatus`), which is after the proxy's
    // response headers, where the refusal is sent: the load is reported only once it has a URL.
    noteGatewayTabState({ runtimeTabId: TAB, webContentsId: 7, loading: false });
    noteGatewayDenied({ environmentId: ENV, code: "not-owned", port: 5173, webContentsId: 7 });
    noteGatewayTabState({ runtimeTabId: TAB, webContentsId: 7, loading: true });
    expect(denialFor()?.code).toBe("not-owned");
    noteGatewayTabState({ runtimeTabId: TAB, webContentsId: 7, loading: false });
    expect(denialFor()?.code).toBe("not-owned");

    // Counted for that load only: a reload after the service was allowed retires it.
    noteGatewayTabState({ runtimeTabId: TAB, webContentsId: 7, loading: true });
    expect(denialFor()).toBeNull();
  });

  it("does not let a refusal that came during a load outlive the next one", () => {
    noteGatewayTabState({ runtimeTabId: TAB, webContentsId: 7, loading: true });
    noteGatewayDenied({ environmentId: ENV, code: "not-owned", port: 5173, webContentsId: 7 });
    noteGatewayTabState({ runtimeTabId: TAB, webContentsId: 7, loading: false });
    noteGatewayTabState({ runtimeTabId: TAB, webContentsId: 7, loading: true });
    expect(denialFor()).toBeNull();
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
        loadFailed: true,
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
        loadFailed: true,
      }),
    ).toBeNull();
  });

  it("uses a refused connection only to explain a load that failed, never to cover a page", () => {
    // Two tabs of one environment load the same port; the page of one fails, the other loads.
    noteGatewayTabState({ runtimeTabId: TAB, webContentsId: 7, loading: true });
    noteGatewayTabState({ runtimeTabId: "tab-2", webContentsId: 8, loading: true });
    noteGatewayDenied({
      environmentId: ENV,
      code: "tls-untrusted",
      port: 5173,
      webContentsId: undefined,
    });
    const forTab = (runtimeTabId: string, loadFailed: boolean) =>
      selectGatewayDenial(useGatewayStore.getState(), {
        runtimeTabId,
        environmentId: ENV,
        port: 5173,
        loadFailed,
      });
    expect(forTab(TAB, true)?.code).toBe("tls-untrusted");
    expect(forTab("tab-2", false)).toBeNull();
    // A page that loaded and then had its socket refused stays uncovered.
    noteGatewayTabState({ runtimeTabId: TAB, webContentsId: 7, loading: false });
    expect(denialFor(5173, false)).toBeNull();
  });

  it("still shows a page the proxy answered, whether or not the load counts as failed", () => {
    noteGatewayTabState({ runtimeTabId: TAB, webContentsId: 7, loading: true });
    noteGatewayDenied({ environmentId: ENV, code: "not-owned", port: 5173, webContentsId: 7 });
    expect(denialFor(5173, false)?.code).toBe("not-owned");
  });

  it("knows nothing of a tab it has not seen", () => {
    noteGatewayDenied({ environmentId: ENV, code: "forbidden", port: 5173, webContentsId: 7 });
    expect(denialFor()).toBeNull();
  });
});
