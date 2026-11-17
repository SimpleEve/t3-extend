import { setUiLocale } from "@t3tools/client-runtime/i18n";
import type { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { PreviewUnreachable } from "~/components/preview/PreviewUnreachable";

import { render } from "../../../test/render";
import { useGatewayStorage } from "./disabledStore";
import type { LoopbackGatewayState } from "./gatewayState";
import {
  noteGatewayDenied,
  noteGatewayTabState,
  noteGatewayTicketDelivered,
  useGatewayStore,
} from "./gatewayStore";

const mocks = vi.hoisted(() => ({
  state: { state: "active" } as { state: string },
  wasActive: false,
  connecting: true,
  permittedToAllow: true,
  allowed: [] as Array<number>,
  allowOutcome: { ok: true } as
    | { readonly ok: true }
    | { readonly ok: false; readonly failure: string },
}));

// The allowed-ports commands need the connection runtime; what matters here is what the card does
// with their answers.
vi.mock(import("./allowedPorts"), async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    allowLoopbackPort: { permissionAtom: () => Atom.make(() => mocks.permittedToAllow) },
    allowLoopbackGatewayPort: async (_environmentId: unknown, port: number) => {
      mocks.allowed.push(port);
      return mocks.allowOutcome;
    },
  } as never;
});

vi.mock(import("./useLoopbackGatewayState"), () => ({
  useLoopbackGatewayState: () => ({
    inputs: {} as never,
    state: mocks.state as LoopbackGatewayState,
    connected: true,
    connecting: mocks.connecting,
    wasActive: mocks.wasActive,
  }),
}));

import { LoopbackGatewayCard } from "./LoopbackGatewayCard";

const ENV = "env-studio" as EnvironmentId;
const TAB = "tab-1";

function setup(state: Record<string, unknown> = { state: "active" }) {
  mocks.state = state as { state: string };
  mocks.wasActive = false;
  mocks.connecting = true;
  mocks.permittedToAllow = true;
  mocks.allowed = [];
  mocks.allowOutcome = { ok: true };
  useGatewayStorage.setState({ disabled: [], wasActive: [] });
  useGatewayStore.setState({
    seq: 0,
    tabs: {},
    pageDenials: {},
    connectDenials: {},
    ticketGeneration: {},
  });
  noteGatewayTabState({ runtimeTabId: TAB, webContentsId: 7, loading: true });
}

const denied = (code: Parameters<typeof noteGatewayDenied>[0]["code"], port = 5173) =>
  noteGatewayDenied({ environmentId: ENV, code, port, webContentsId: 7 });

function card(overrides: Partial<Parameters<typeof LoopbackGatewayCard>[0]> = {}) {
  return (
    <LoopbackGatewayCard
      environmentId={ENV}
      environmentLabel="Studio"
      runtimeTabId={TAB}
      url="http://localhost:5173/"
      loadFailed={false}
      onReload={() => {}}
      move={{ label: "Open in Studio's browser", onMove: () => {} }}
      {...overrides}
    />
  );
}

describe("loopback gateway card", () => {
  it("tells a port that is not T3's from a service that left its terminal, and offers the environment's browser", async () => {
    setup();
    denied("not-owned");
    await using screen = await render(card(), { router: false });
    await expect
      .element(
        screen.getByRole("heading", { name: "This port isn't served by a T3 terminal or agent" }),
      )
      .toBeVisible();
    await expect
      .element(screen.getByText("moved to the background with nohup", { exact: false }))
      .toBeVisible();
    await expect
      .element(screen.getByText("If you trust it, you can allow this port.", { exact: false }))
      .toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: "Open in Studio's browser" }))
      .toBeVisible();
    // The generic troubleshooting list has nothing to do with this.
    expect(screen.getByRole("button", { name: "Details" }).elements()).toEqual([]);
  });

  it("allows the port from the card and loads the tab again", async () => {
    setup();
    denied("not-owned");
    const onReload = vi.fn();
    await using screen = await render(card({ onReload }));
    await expect
      .element(screen.getByText("remove it in Settings → Browser", { exact: false }))
      .toBeVisible();
    // The reload button is the quiet one now; the allow button leads.
    await userEvent.click(screen.getByRole("button", { name: "Allow forwarding localhost:5173" }));
    await vi.waitFor(() => expect(onReload).toHaveBeenCalledOnce());
    expect(mocks.allowed).toEqual([5173]);
  });

  it("stays and says why when the port could not be allowed", async () => {
    setup();
    denied("not-owned");
    mocks.allowOutcome = { ok: false, failure: "limit-reached" };
    const onReload = vi.fn();
    await using screen = await render(card({ onReload }));
    await userEvent.click(screen.getByRole("button", { name: "Allow forwarding localhost:5173" }));
    await expect
      .element(screen.getByRole("alert"))
      .toHaveTextContent(
        "At most 64 ports can be allowed. Remove one in Settings → Browser, then try again.",
      );
    expect(onReload).not.toHaveBeenCalled();
    // Reloading clears the line.
    await userEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(onReload).toHaveBeenCalledOnce();
    expect(screen.getByRole("alert").elements()).toEqual([]);
  });

  it("offers to allow a port only for a service nobody here started, and only with permission", async () => {
    setup();
    denied("not-owned");
    mocks.permittedToAllow = false;
    await using screen = await render(card());
    await expect.element(screen.getByRole("heading")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Allow forwarding localhost:5173" }).elements(),
    ).toEqual([]);

    setup();
    denied("reserved");
    await using reserved = await render(card());
    await expect
      .element(reserved.getByRole("heading", { name: "This port can't be forwarded" }))
      .toBeVisible();
    expect(
      reserved.getByRole("button", { name: "Allow forwarding localhost:5173" }).elements(),
    ).toEqual([]);
  });

  it("says a service that listens on no loopback address is out of reach, with the environment's browser", async () => {
    setup();
    denied("not-loopback");
    await using screen = await render(card());
    await expect
      .element(screen.getByRole("heading", { name: "This service isn't listening on localhost" }))
      .toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: "Open in Studio's browser" }))
      .toBeVisible();
    expect(
      screen.getByRole("button", { name: "Allow forwarding localhost:5173" }).elements(),
    ).toEqual([]);
  });

  it("says a service the user can start is not running, with a reload and no way around", async () => {
    setup();
    denied("upstream-refused", 3000);
    await using screen = await render(card({ url: "http://localhost:3000/" }), { router: false });
    await expect
      .element(screen.getByRole("heading", { name: "Nothing is listening on port 3000 in Studio" }))
      .toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Reload" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Open in Studio's browser" }).elements()).toEqual([]);
  });

  it("says the certificate is not trusted", async () => {
    setup();
    denied("tls-untrusted");
    await using screen = await render(card(), { router: false });
    await expect
      .element(screen.getByRole("heading", { name: "Studio's certificate isn't trusted" }))
      .toBeVisible();
    await expect
      .element(
        screen.getByText("private certificate authorities aren't supported yet", { exact: false }),
      )
      .toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: "Open in Studio's browser" }))
      .toBeVisible();
  });

  it("points a plain Tailscale address at the MagicDNS name or https", async () => {
    setup({ state: "unsupported-route", reason: "insecure-transport", hint: "tailscale-address" });
    await using screen = await render(card({ loadFailed: true }), { router: false });
    await expect
      .element(
        screen.getByRole("heading", {
          name: "This connection isn't encrypted, so localhost isn't forwarded",
        }),
      )
      .toBeVisible();
    await expect
      .element(
        screen.getByText("Use its MagicDNS name (*.ts.net) or https instead.", { exact: false }),
      )
      .toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: "Open in Studio's browser" }))
      .toBeVisible();
  });

  it("asks for https, Tailscale or SSH on a plain LAN address", async () => {
    setup({ state: "unsupported-route", reason: "insecure-transport" });
    await using screen = await render(card({ loadFailed: true }), { router: false });
    await expect
      .element(
        screen.getByText("over https, Tailscale (using its MagicDNS name) or SSH", {
          exact: false,
        }),
      )
      .toBeVisible();
    expect(screen.getByText("Tailscale IP address", { exact: false }).elements()).toEqual([]);
  });

  it("explains each reason a page could not be forwarded when nothing was forwarding", async () => {
    const cases: ReadonlyArray<readonly [Record<string, unknown>, string]> = [
      [{ state: "unsupported-server" }, "Studio's T3 can't forward localhost"],
      [
        { state: "unsupported-route", reason: "relay" },
        "Connections through T3 Connect can't forward localhost",
      ],
      [{ state: "no-permission" }, "This connection isn't allowed to forward localhost"],
    ];
    for (const [state, heading] of cases) {
      setup(state);
      await using screen = await render(card({ loadFailed: true }), { router: false });
      await expect.element(screen.getByRole("heading", { name: heading })).toBeVisible();
    }
  });

  it("draws nothing for a page that loaded, was not refused, or a user who turned forwarding off", async () => {
    setup();
    await using screen = await render(card(), { router: false });
    expect(screen.container.querySelector("h1")).toBeNull();

    for (const state of [
      { state: "active" },
      { state: "disabled-by-user" },
      { state: "not-applicable" },
    ]) {
      setup(state);
      await screen.rerender(card({ loadFailed: true }));
      expect(screen.container.querySelector("h1"), state.state).toBeNull();
    }
    // A failed load of something that is not localhost is the ordinary card's business.
    setup({ state: "unsupported-server" });
    await screen.rerender(card({ loadFailed: true, url: "https://example.com/" }));
    expect(screen.container.querySelector("h1")).toBeNull();
  });

  it("explains a failed load with a refused connection, and leaves a page that loaded alone", async () => {
    setup();
    noteGatewayTabState({ runtimeTabId: "tab-2", webContentsId: 8, loading: true });
    // A refused https or websocket connection names a port, not a tab.
    noteGatewayDenied({
      environmentId: ENV,
      code: "tls-untrusted",
      port: 5173,
      webContentsId: undefined,
    });
    await using failed = await render(card({ loadFailed: true }), { router: false });
    await expect
      .element(failed.getByRole("heading", { name: "Studio's certificate isn't trusted" }))
      .toBeVisible();

    // The same environment and port in another tab, whose page loaded.
    await using loaded = await render(card({ runtimeTabId: "tab-2", loadFailed: false }), {
      router: false,
    });
    expect(loaded.container.querySelector("h1")).toBeNull();
  });

  it("does not cover a page that loaded when its websocket is refused", async () => {
    setup();
    noteGatewayDenied({
      environmentId: ENV,
      code: "forbidden",
      port: 5173,
      webContentsId: undefined,
    });
    await using screen = await render(card({ loadFailed: false }), { router: false });
    expect(screen.container.querySelector("h1")).toBeNull();
  });

  it("shows a refusal only for a page on localhost", async () => {
    setup();
    denied("not-owned");
    await using screen = await render(card({ url: "https://example.com/" }), { router: false });
    expect(screen.container.querySelector("h1")).toBeNull();
  });

  it("forgets a refusal when the page is loaded again", async () => {
    setup();
    denied("not-owned");
    await using screen = await render(card(), { router: false });
    await expect.element(screen.getByRole("heading")).toBeVisible();
    noteGatewayTabState({ runtimeTabId: TAB, webContentsId: 7, loading: false });
    noteGatewayTabState({ runtimeTabId: TAB, webContentsId: 7, loading: true });
    await expect.poll(() => screen.container.querySelector("h1")).toBeNull();
  });

  it("reloads once when the ticket it was waiting for arrives", async () => {
    setup();
    denied("unauthorized");
    const onReload = vi.fn();
    await using screen = await render(card({ onReload }), { router: false });
    await expect
      .element(screen.getByRole("heading", { name: "Reconnecting to Studio…" }))
      .toBeVisible();
    expect(onReload).not.toHaveBeenCalled();

    noteGatewayTicketDelivered(ENV);
    await vi.waitFor(() => expect(onReload).toHaveBeenCalledOnce());
    noteGatewayTicketDelivered(ENV);
    noteGatewayTicketDelivered(ENV);
    expect(onReload).toHaveBeenCalledOnce();
  });

  it("speaks Chinese when the interface does", async () => {
    setup();
    denied("tls-untrusted");
    await setUiLocale("zh-Hans");
    using _restore = { [Symbol.dispose]: () => void setUiLocale("en") };
    await using screen = await render(card(), { router: false });
    await expect
      .element(screen.getByRole("heading", { name: "Studio 的证书不受信任" }))
      .toBeVisible();
    await expect.element(screen.getByText("暂不支持私有 CA", { exact: false })).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "重新加载" })).toBeVisible();
  });

  it("offers the allow button in Chinese", async () => {
    setup();
    denied("not-owned");
    await setUiLocale("zh-Hans");
    using _restore = { [Symbol.dispose]: () => void setUiLocale("en") };
    await using screen = await render(card());
    await expect
      .element(screen.getByRole("button", { name: "允许转发 localhost:5173" }))
      .toBeVisible();
    await expect
      .element(screen.getByText("可以在 设置 → 浏览器 里移除", { exact: false }))
      .toBeVisible();
  });
});

describe("page unreachable card", () => {
  it("keeps its usual words and its troubleshooting list", async () => {
    await using screen = await render(
      <PreviewUnreachable
        url="http://localhost:5173/"
        code={-102}
        description="ERR_CONNECTION_REFUSED"
        onReload={() => {}}
      />,
      { router: false },
    );
    await expect
      .element(screen.getByRole("heading", { name: "This site can’t be reached" }))
      .toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Details" }));
    await expect.element(screen.getByText("Checking the proxy and the firewall")).toBeVisible();
    expect(page.getByText("ERR_CONNECTION_REFUSED").elements().length).toBeGreaterThan(0);
  });
});
