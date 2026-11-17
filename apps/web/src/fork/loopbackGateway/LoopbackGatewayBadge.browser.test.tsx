import type { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { useGatewayStorage, useLoopbackForwardingDisabled } from "./disabledStore";
import type { LoopbackGatewayState } from "./gatewayState";

const mocks = vi.hoisted(() => ({
  otherwise: "active" as string,
  allowed: [] as ReadonlyArray<{ readonly port: number }> | null,
  refreshed: [] as Array<string>,
  removed: [] as Array<number>,
}));

// The list and its commands need the connection runtime; the menu only reads the list.
vi.mock(
  import("./allowedPorts"),
  () =>
    ({
      useAllowedLoopbackPorts: () => mocks.allowed,
      refreshAllowedLoopbackPorts: async (environmentId: string) =>
        void mocks.refreshed.push(environmentId),
      removeAllowedLoopbackGatewayPort: async (_environmentId: string, port: number) => {
        mocks.removed.push(port);
        return { ok: true };
      },
    }) as never,
);

// The state hook reads the connection atoms; what matters here is only how the user's switch
// moves it, so the real switch decides between forwarding and stopped, and a test sets the rest.
vi.mock(import("./useLoopbackGatewayState"), () => ({
  useLoopbackGatewayState: (environmentId: EnvironmentId) => {
    const stopped = useLoopbackForwardingDisabled(environmentId);
    const state = (
      mocks.otherwise === "active"
        ? { state: stopped ? "disabled-by-user" : "active" }
        : { state: mocks.otherwise }
    ) as LoopbackGatewayState;
    return { inputs: {} as never, state, wasActive: false, connected: true, connecting: true };
  },
}));

import { LoopbackGatewayBadge } from "./LoopbackGatewayBadge";

const ENV = "env-studio" as EnvironmentId;

function setup(otherwise = "active") {
  mocks.otherwise = otherwise;
  mocks.allowed = [];
  mocks.refreshed = [];
  mocks.removed = [];
  useGatewayStorage.setState({ disabled: [], wasActive: [] });
  window.localStorage.clear();
}

function badge(overrides: Partial<Parameters<typeof LoopbackGatewayBadge>[0]> = {}) {
  return (
    <LoopbackGatewayBadge
      environmentId={ENV}
      environmentLabel="Studio"
      url="http://localhost:5173/"
      move={undefined}
      {...overrides}
    />
  );
}

describe("loopback gateway badge", () => {
  it("stops forwarding from the menu, stays visible grey, and resumes from the same place", async () => {
    setup();
    const onMove = vi.fn();
    await using screen = await render(
      badge({ move: { label: "Open in Studio's browser", onMove } }),
    );

    const mark = screen.getByRole("button", { name: "localhost is forwarded to Studio" });
    await expect.element(mark).toHaveAttribute("data-loopback-gateway", "forwarding");
    await userEvent.click(mark);
    await expect
      .element(page.getByRole("menuitem", { name: "Open in Studio's browser" }))
      .toBeVisible();
    await expect
      .element(page.getByText("Forwarding applies to all of Studio's tabs", { exact: false }))
      .toBeVisible();
    await userEvent.click(
      page.getByRole("menuitem", { name: "Stop forwarding and use this computer's localhost" }),
    );

    expect(useGatewayStorage.getState().disabled).toEqual([ENV]);
    expect(
      JSON.parse(window.localStorage.getItem("t3extend:loopback-gateway:v1") ?? "null"),
    ).toEqual({ disabled: [ENV], wasActive: [] });

    // The mark does not disappear: it is the only way back.
    const stopped = screen.getByRole("button", {
      name: "localhost forwarding is off. Here, localhost is this computer",
    });
    await expect.element(stopped).toHaveAttribute("data-loopback-gateway", "stopped");
    await userEvent.click(stopped);
    await expect.element(page.getByRole("menuitem", { name: "Resume forwarding" })).toBeVisible();
    expect(
      page
        .getByRole("menuitem", { name: "Stop forwarding and use this computer's localhost" })
        .elements(),
    ).toEqual([]);
    expect(page.getByRole("menuitem", { name: "Open in Studio's browser" }).elements()).toEqual([]);
    await userEvent.click(page.getByRole("menuitem", { name: "Resume forwarding" }));

    expect(useGatewayStorage.getState().disabled).toEqual([]);
    await expect
      .element(screen.getByRole("button", { name: "localhost is forwarded to Studio" }))
      .toBeVisible();
  });

  it("takes this port away from the allowed ones, only when it is one, and leads to the list", async () => {
    setup();
    mocks.allowed = [];
    await using screen = await render(badge());
    await userEvent.click(screen.getByRole("button", { name: "localhost is forwarded to Studio" }));
    expect(mocks.refreshed).toEqual([ENV]);
    await expect
      .element(page.getByRole("menuitem", { name: "Manage allowed ports…" }))
      .toBeVisible();
    expect(page.getByRole("menuitem", { name: "Stop allowing localhost:5173" }).elements()).toEqual(
      [],
    );
    await userEvent.keyboard("{Escape}");

    // Another port is allowed, not this one: still no item.
    mocks.allowed = [{ port: 8080 }];
    await screen.rerender(badge());
    await userEvent.click(screen.getByRole("button", { name: "localhost is forwarded to Studio" }));
    expect(page.getByRole("menuitem", { name: "Stop allowing localhost:5173" }).elements()).toEqual(
      [],
    );
    await userEvent.keyboard("{Escape}");

    mocks.allowed = [{ port: 5173 }, { port: 8080 }];
    await screen.rerender(badge());
    await userEvent.click(screen.getByRole("button", { name: "localhost is forwarded to Studio" }));
    await userEvent.click(page.getByRole("menuitem", { name: "Stop allowing localhost:5173" }));
    expect(mocks.removed).toEqual([5173]);
  });

  it("opens the tab in the environment's browser", async () => {
    setup();
    const onMove = vi.fn();
    await using screen = await render(
      badge({ move: { label: "Open in Studio's browser", onMove } }),
    );
    await userEvent.click(screen.getByRole("button", { name: "localhost is forwarded to Studio" }));
    await userEvent.click(page.getByRole("menuitem", { name: "Open in Studio's browser" }));
    expect(onMove).toHaveBeenCalledOnce();
  });

  it("offers no way to the environment's browser when there is none", async () => {
    setup();
    await using screen = await render(badge());
    await userEvent.click(screen.getByRole("button", { name: "localhost is forwarded to Studio" }));
    await expect
      .element(
        page.getByRole("menuitem", { name: "Stop forwarding and use this computer's localhost" }),
      )
      .toBeVisible();
    expect(page.getByRole("menuitem", { name: "Open in Studio's browser" }).elements()).toEqual([]);
  });

  it("is absent where nothing is forwarded or the page is not on localhost", async () => {
    setup("unsupported-route");
    await using screen = await render(badge());
    expect(screen.container.querySelector("[data-loopback-gateway]")).toBeNull();

    setup();
    await screen.rerender(badge({ url: "https://example.com/" }));
    expect(screen.container.querySelector("[data-loopback-gateway]")).toBeNull();
    await screen.rerender(badge({ url: "http://127.0.0.1:3000/" }));
    expect(screen.container.querySelector("[data-loopback-gateway]")).not.toBeNull();
  });
});
