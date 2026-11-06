import type { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { useGatewayStorage } from "./disabledStore";
import type { LoopbackGatewayState } from "./gatewayState";
import { setGatewayRegistration, useGatewayStore } from "./gatewayStore";

const mocks = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const box = {
    snapshot: { state: "unknown", connecting: false, wasActive: true },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** What the connection atoms would now say; every reader is told, as an atom would. */
    set: (snapshot: { state: string; connecting: boolean; wasActive: boolean }) => {
      box.snapshot = snapshot;
      listeners.forEach((listener) => listener());
    },
  };
  return box;
});

// The state is what the connection atoms would work out; the gate, the card and the user's switch
// are the real ones.
vi.mock(import("./useLoopbackGatewayState"), async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    useLoopbackGatewayState: () => {
      const { state, connecting, wasActive } = useSyncExternalStore(
        mocks.subscribe,
        () => mocks.snapshot,
      );
      return {
        inputs: {} as never,
        state: { state } as LoopbackGatewayState,
        connected: false,
        connecting,
        wasActive,
      };
    },
  };
});

import { LoopbackGatewayCard } from "./LoopbackGatewayCard";
import { useLoopbackGatewayReady } from "./useLoopbackGatewayReady";

const ENV = "env-studio" as EnvironmentId;

function setup(input: { state: string; connecting: boolean; wasActive: boolean }) {
  mocks.set(input);
  useGatewayStorage.setState({ disabled: [], wasActive: [] });
  useGatewayStore.setState({ registration: {}, retryRequests: {} });
}

// What a restored tab is: the webview behind the gate, and the card for the wait.
function RestoredTab() {
  const ready = useLoopbackGatewayReady(ENV);
  return (
    <div>
      {ready ? <div data-testid="webview" /> : null}
      <LoopbackGatewayCard
        environmentId={ENV}
        environmentLabel="Studio"
        runtimeTabId="tab-1"
        url="http://localhost:5173/"
        loadFailed={false}
        onReload={() => {}}
        move={undefined}
      />
    </div>
  );
}

const webview = (screen: { container: HTMLElement }) =>
  screen.container.querySelector("[data-testid=webview]");

describe("a restored tab of an environment that was forwarding", () => {
  it("shows the card and no webview while it cannot be reached, then opens once forwarding is active", async () => {
    setup({ state: "unknown", connecting: false, wasActive: true });
    await using screen = await render(<RestoredTab />, { router: false });
    await expect.element(screen.getByRole("heading", { name: "Can't reach Studio" })).toBeVisible();
    await expect
      .element(
        screen.getByText("This tab opens by itself once Studio is connected.", { exact: false }),
      )
      .toBeVisible();
    await expect
      .element(
        screen.getByRole("button", { name: "Stop forwarding and use this computer's localhost" }),
      )
      .toBeVisible();
    expect(webview(screen)).toBeNull();

    // The environment connects and its forwarding is active, but the main process does not know it yet.
    mocks.set({ state: "active", connecting: true, wasActive: true });
    expect(webview(screen)).toBeNull();
    setGatewayRegistration(ENV, "registered");
    await vi.waitFor(() => expect(webview(screen)).not.toBeNull());
    expect(screen.container.querySelector("h1")).toBeNull();
  });

  it("waits quietly, with no card, while the environment is still connecting", async () => {
    setup({ state: "unknown", connecting: true, wasActive: true });
    await using screen = await render(<RestoredTab />, { router: false });
    expect(webview(screen)).toBeNull();
    expect(screen.container.querySelector("h1")).toBeNull();
  });

  it("opens the tab on this computer's localhost when the user stops forwarding", async () => {
    setup({ state: "unknown", connecting: false, wasActive: true });
    await using screen = await render(<RestoredTab />, { router: false });
    await userEvent.click(
      screen.getByRole("button", { name: "Stop forwarding and use this computer's localhost" }),
    );
    expect(useGatewayStorage.getState().disabled).toEqual([ENV]);
    await vi.waitFor(() => expect(webview(screen)).not.toBeNull());
    expect(screen.container.querySelector("h1")).toBeNull();
  });

  it("keeps the old behavior for an environment that never forwarded: it opens when unreachable", async () => {
    setup({ state: "unknown", connecting: false, wasActive: false });
    await using screen = await render(<RestoredTab />, { router: false });
    expect(webview(screen)).not.toBeNull();
    expect(screen.container.querySelector("h1")).toBeNull();
  });

  it("opens, without a card, once the environment turns out not to forward", async () => {
    setup({ state: "unknown", connecting: false, wasActive: true });
    await using screen = await render(<RestoredTab />, { router: false });
    expect(webview(screen)).toBeNull();
    mocks.set({ state: "unsupported-server", connecting: false, wasActive: true });
    await vi.waitFor(() => expect(webview(screen)).not.toBeNull());
  });
});

describe("a tab of an environment whose forwarding could not be set up", () => {
  it("shows the card and no webview, and opens once a retry registers it", async () => {
    setup({ state: "active", connecting: true, wasActive: false });
    setGatewayRegistration(ENV, "failed");
    await using screen = await render(<RestoredTab />, { router: false });
    await expect
      .element(screen.getByRole("heading", { name: "Couldn't start localhost forwarding" }))
      .toBeVisible();
    expect(webview(screen)).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(useGatewayStore.getState().retryRequests[ENV]).toBe(1);
    expect(webview(screen)).toBeNull();
    // The manager registers again: pending first, then done.
    setGatewayRegistration(ENV, "pending");
    setGatewayRegistration(ENV, "registered");
    await vi.waitFor(() => expect(webview(screen)).not.toBeNull());
    expect(screen.container.querySelector("h1")).toBeNull();
  });

  it("opens on this computer's localhost when the user stops forwarding instead", async () => {
    setup({ state: "active", connecting: true, wasActive: false });
    setGatewayRegistration(ENV, "failed");
    await using screen = await render(<RestoredTab />, { router: false });
    await userEvent.click(
      screen.getByRole("button", { name: "Stop forwarding and use this computer's localhost" }),
    );
    expect(useGatewayStorage.getState().disabled).toEqual([ENV]);
    await vi.waitFor(() => expect(webview(screen)).not.toBeNull());
    expect(screen.container.querySelector("h1")).toBeNull();
  });
});
