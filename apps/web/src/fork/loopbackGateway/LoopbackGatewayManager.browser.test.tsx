import type {
  LoopbackGatewayBridge,
  LoopbackGatewayEvent,
} from "@t3tools/shared/forkLoopbackGateway/bridge";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import type { LoopbackGatewayState } from "./gatewayState";
import { requestGatewayRetry, selectGatewayDenial, useGatewayStore } from "./gatewayStore";

const mocks = vi.hoisted(() => ({
  snapshot: {} as Record<string, unknown>,
  stateListener: null as null | ((tabId: string, state: unknown) => void),
}));

vi.mock(import("~/state/environments"), () => ({
  useEnvironments: () => ({ environments: [{ environmentId: "env-studio" }] }) as never,
}));

vi.mock(import("~/components/preview/previewBridge"), () => ({
  previewBridge: {
    onStateChange: (listener: (tabId: string, state: unknown) => void) => {
      mocks.stateListener = listener;
      return () => {
        mocks.stateListener = null;
      };
    },
  } as never,
}));

vi.mock(import("./useLoopbackGatewayState"), () => ({
  useLoopbackGatewayState: () => mocks.snapshot as never,
}));

vi.mock(import("./ticketCommand"), () => ({
  fetchLoopbackGatewayTicket: async () => ({
    ticket: "sentinel-ticket",
    expiresAt: new Date(Date.now() + 5 * 60_000),
  }),
  issueLoopbackGatewayTicket: {} as never,
}));

import { LoopbackGatewayManager } from "./LoopbackGatewayManager";

const ENV = "env-studio";

function setup(input: {
  readonly state: LoopbackGatewayState;
  readonly httpBaseUrl?: string;
  readonly connected?: boolean;
}) {
  mocks.stateListener = null;
  mocks.snapshot = {
    state: input.state,
    inputs: {
      route: { httpBaseUrl: input.httpBaseUrl ?? "https://box.example.com", relay: false },
    },
    connected: input.connected ?? true,
    connecting: true,
  };
  useGatewayStore.setState({
    states: {},
    registration: {},
    retryRequests: {},
    ticketGeneration: {},
    seq: 0,
    tabs: {},
    pageDenials: {},
    connectDenials: {},
  });
  let emit: (event: LoopbackGatewayEvent) => void = () => {};
  const bridge = {
    register: vi.fn(async (_input: unknown) => ({ state: "pending" as const })),
    updateTicket: vi.fn(async (_input: unknown) => ({ state: "active" as const })),
    unregister: vi.fn(async (_input: unknown) => undefined),
    setEnabled: vi.fn(async (_input: unknown) => null),
    setReachable: vi.fn(async (_input: unknown) => null),
    getStatus: vi.fn(async (_input: unknown) => null),
    onEvent: (listener: (event: LoopbackGatewayEvent) => void) => {
      emit = listener;
      return () => {
        emit = () => {};
      };
    },
  } satisfies LoopbackGatewayBridge;
  (window as unknown as Record<string, unknown>).t3xLoopbackGatewayBridge = bridge;
  return {
    bridge,
    emit: (event: LoopbackGatewayEvent) => emit(event),
    [Symbol.dispose]: () => {
      delete (window as unknown as Record<string, unknown>).t3xLoopbackGatewayBridge;
    },
  };
}

describe("loopback gateway manager", () => {
  it("registers a forwarded environment, hands over its ticket, and lets go when it is removed", async () => {
    using gateway = setup({ state: { state: "active" } });
    let clock = 1_000_000;
    using _now = vi.spyOn(Date, "now").mockImplementation(() => clock);
    await using screen = await render(<LoopbackGatewayManager />, { router: false });

    await vi.waitFor(() => expect(gateway.bridge.updateTicket).toHaveBeenCalledOnce());
    expect(gateway.bridge.register).toHaveBeenCalledWith({
      environmentId: ENV,
      httpBaseUrl: "https://box.example.com",
      enabled: true,
    });
    expect(gateway.bridge.updateTicket.mock.calls[0]?.[0]).toMatchObject({
      environmentId: ENV,
      credential: { ticket: "sentinel-ticket" },
    });
    expect(useGatewayStore.getState().registration[ENV]).toBe("registered");
    expect(useGatewayStore.getState().states[ENV]).toBe("active");
    expect(useGatewayStore.getState().ticketGeneration[ENV]).toBe(1);

    // The main process asks again once the minimum interval has passed: that is a new fetch.
    clock += 3_001;
    gateway.emit({ type: "ticket-needed", environmentId: ENV });
    await vi.waitFor(() => expect(gateway.bridge.updateTicket).toHaveBeenCalledTimes(2));
    expect(useGatewayStore.getState().ticketGeneration[ENV]).toBe(2);
    await screen.unmount();
    await vi.waitFor(() =>
      expect(gateway.bridge.unregister).toHaveBeenCalledWith({ environmentId: ENV }),
    );
    expect(useGatewayStore.getState().registration[ENV]).toBeUndefined();
    expect(useGatewayStore.getState().states[ENV]).toBeUndefined();
  });

  it("registers again when the user retries a registration that failed", async () => {
    using gateway = setup({ state: { state: "active" } });
    gateway.bridge.register.mockRejectedValueOnce(new Error("ipc closed"));
    await using _screen = await render(<LoopbackGatewayManager />, { router: false });
    await vi.waitFor(() => expect(useGatewayStore.getState().registration[ENV]).toBe("failed"));
    expect(gateway.bridge.updateTicket).not.toHaveBeenCalled();

    requestGatewayRetry(ENV);
    await vi.waitFor(() => expect(useGatewayStore.getState().registration[ENV]).toBe("registered"));
    expect(gateway.bridge.register).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(gateway.bridge.updateTicket).toHaveBeenCalledOnce());
  });

  it("registers an environment the user stopped, without asking it for a ticket", async () => {
    using gateway = setup({ state: { state: "disabled-by-user" } });
    await using _screen = await render(<LoopbackGatewayManager />, { router: false });
    await vi.waitFor(() => expect(gateway.bridge.register).toHaveBeenCalledOnce());
    expect(gateway.bridge.register).toHaveBeenCalledWith({
      environmentId: ENV,
      httpBaseUrl: "https://box.example.com",
      enabled: false,
    });
    expect(gateway.bridge.updateTicket).not.toHaveBeenCalled();
    expect(useGatewayStore.getState().states[ENV]).toBe("disabled-by-user");
  });

  it("registers an environment that is not connected as unreachable", async () => {
    using gateway = setup({ state: { state: "active" }, connected: false });
    await using _screen = await render(<LoopbackGatewayManager />, { router: false });
    await vi.waitFor(() =>
      expect(gateway.bridge.setReachable).toHaveBeenCalledWith({
        environmentId: ENV,
        reachable: false,
      }),
    );
    expect(gateway.bridge.updateTicket).not.toHaveBeenCalled();
  });

  it.each([
    ["old server", { state: "unsupported-server" }],
    ["plain connection", { state: "unsupported-route", reason: "insecure-transport" }],
    ["relay", { state: "unsupported-route", reason: "relay" }],
    ["missing scopes", { state: "no-permission" }],
    ["still unknown", { state: "unknown" }],
    ["this computer's own server", { state: "not-applicable" }],
  ] as const)("does not register an environment behind %s", async (_name, state) => {
    using gateway = setup({ state: state as LoopbackGatewayState });
    await using _screen = await render(<LoopbackGatewayManager />, { router: false });
    await vi.waitFor(() => expect(useGatewayStore.getState().states[ENV]).toBe(state.state));
    expect(gateway.bridge.register).not.toHaveBeenCalled();
  });

  it("keeps a refusal for the tab whose page the proxy answered", async () => {
    using gateway = setup({ state: { state: "active" } });
    await using _screen = await render(<LoopbackGatewayManager />, { router: false });
    await vi.waitFor(() => expect(mocks.stateListener).not.toBeNull());
    const tabState = (loading: boolean) => ({
      webContentsId: 11,
      navStatus: { kind: loading ? "Loading" : "Success", url: "http://localhost:5173/" },
    });
    mocks.stateListener?.("tab-1", tabState(true));
    gateway.emit({
      type: "denied",
      environmentId: ENV,
      code: "not-owned",
      port: 5173,
      mainFrame: true,
      webContentsId: 11,
      url: "http://localhost:5173/",
    });
    mocks.stateListener?.("tab-1", tabState(false));
    const denial = (loadFailed = true) =>
      selectGatewayDenial(useGatewayStore.getState(), {
        runtimeTabId: "tab-1",
        environmentId: ENV,
        port: 5173,
        loadFailed,
      });
    expect(denial()?.code).toBe("not-owned");

    // A refused https or websocket connection has no page: it is matched by port.
    mocks.stateListener?.("tab-1", tabState(true));
    gateway.emit({
      type: "denied",
      environmentId: ENV,
      code: "tls-untrusted",
      port: 5173,
      mainFrame: false,
    });
    expect(denial()?.code).toBe("tls-untrusted");
    expect(denial(false)).toBeNull();
  });
});
