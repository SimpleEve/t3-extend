import { encodeInvite } from "@t3tools/shared/forkDeviceKeys/invite";
import type { DeviceListEntry, DevicesSnapshot, DevicesStatus } from "@t3tools/contracts";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import { AsyncResult, Atom } from "effect/reactivity";
import { page, userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";
import { fakeTimers, render, stubGlobal } from "../../test/render";
import { AppAtomRegistryProvider } from "../rpc/atomRegistry";

const NOW = Date.parse("2026-11-03T12:00:00.000Z");

const mocks = vi.hoisted(() => ({
  status: null as unknown,
  snapshot: null as unknown,
  join: vi.fn(),
  leave: vi.fn(),
  invite: vi.fn(),
  cancelInvite: vi.fn(),
  remove: vi.fn(),
  refreshStatus: vi.fn(),
  // Environments the registry's directory knows as devices, environment id to device id.
  deviceIds: new Map<string, string>(),
}));

vi.mock(import("~/fork/deviceKeysRuntime"), async (original) => ({
  ...(await original()),
  deviceEnvironmentIndex: {
    get: (id: string) => mocks.deviceIds.get(id),
    bind: () => () => undefined,
    notReady: () => false,
  },
}));
vi.mock(import("~/fork/deviceKeysStore"), async (original) => ({
  ...(await original()),
  devicesStatus: (() => mocks.status) as never,
  devicesSnapshot: (() => mocks.snapshot) as never,
  devicesCommands: {
    join: "join",
    leave: "leave",
    invite: "invite",
    cancelInvite: "cancelInvite",
    remove: "remove",
  } as never,
  refreshDevicesStatus: mocks.refreshStatus,
}));
vi.mock(import("~/state/environments"), async (original) => ({
  ...(await original()),
  usePrimaryEnvironmentId: (() => "primary") as never,
}));
vi.mock(import("~/state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((command: "join" | "leave" | "invite" | "cancelInvite" | "remove") =>
    mocks[command]) as never,
}));

import { peerWait } from "~/fork/deviceKeysRuntime";
import { YourServerSettings } from "./YourServerSettings";

const success = <A,>(value: A) => AsyncResult.success(value) as AtomCommandResult<A, never>;

const status = (overrides: Partial<DevicesStatus> = {}): DevicesStatus => ({
  state: "joined",
  registryOrigin: "https://t3.example.com",
  registryHost: "t3.example.com",
  deviceId: "me",
  name: "Mac",
  url: "https://mac.t3.example.com",
  tunnel: { status: "connected", lastError: null },
  fetchedAt: Math.floor(NOW / 1000) - 30,
  staleness: "fresh",
  ...overrides,
});

const device = (overrides: Partial<DeviceListEntry>): DeviceListEntry => ({
  id: "device",
  name: "Device",
  kind: "computer",
  createdAt: 1,
  lastSeenAt: Math.floor(NOW / 1000) - 120,
  self: false,
  ...overrides,
});

const DEVICES: ReadonlyArray<DeviceListEntry> = [
  device({ id: "me", name: "Mac", self: true, url: "https://mac.t3.example.com" }),
  device({ id: "mac-mini", name: "Mac mini", online: true, url: "https://mini.t3.example.com" }),
  device({ id: "phone", name: "Pixel", kind: "phone" }),
];

function setup(
  input: {
    status?: DevicesStatus;
    /** What the server has pushed since the one-shot status was read. */
    pushed?: DevicesStatus;
    devices?: ReadonlyArray<DeviceListEntry>;
    desktop?: boolean;
  } = {},
) {
  const current = input.status ?? status();
  mocks.status = Atom.make(AsyncResult.success(current));
  mocks.snapshot = Atom.make(
    AsyncResult.success({
      status: input.pushed ?? current,
      rev: 1,
      devices: input.devices ?? DEVICES,
    } satisfies DevicesSnapshot),
  );
  for (const command of [
    mocks.join,
    mocks.leave,
    mocks.invite,
    mocks.cancelInvite,
    mocks.remove,
    mocks.refreshStatus,
  ]) {
    command.mockReset();
  }
  mocks.join.mockResolvedValue(success(status()));
  mocks.leave.mockResolvedValue(success(status({ state: "not_joined" })));
  mocks.invite.mockResolvedValue(
    success({ id: "invite-1", invite: "t3x1.example", expiresAt: Math.floor(NOW / 1000) + 900 }),
  );
  mocks.cancelInvite.mockResolvedValue(success({}));
  mocks.remove.mockResolvedValue(success({ removedAt: 1, rev: 2, pendingComputers: [] }));
  peerWait.end("env-mini");
  mocks.deviceIds.clear();
  const clock = vi.spyOn(Date, "now").mockReturnValue(NOW);
  const bridge = input.desktop === false ? null : stubGlobal("desktopBridge", {});
  return {
    clock,
    [Symbol.dispose]: () => {
      bridge?.[Symbol.dispose]();
      clock.mockRestore();
    },
  };
}

const inviteFor = (origin: string, kind: "computer" | "phone" = "computer", expiresIn = 900) =>
  encodeInvite({
    origin,
    registryId: "abcdefgh",
    id: "AAAAAAAAAAA",
    secret: "B".repeat(22),
    kind,
    expiresAt: Math.floor(NOW / 1000) + expiresIn,
  });

const ui = () => (
  <AppAtomRegistryProvider>
    <YourServerSettings />
  </AppAtomRegistryProvider>
);

describe("Your server settings, not joined", () => {
  it("asks which server before it sends anything, and then joins", async () => {
    using _bridge = setup({ status: status({ state: "not_joined" }) });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await using _screen = await render(ui(), { router: false });

    await userEvent.click(page.getByRole("button", { name: "Join my server" }));
    await userEvent.fill(
      page.getByRole("textbox", { name: "Invite" }),
      inviteFor("https://t3.example.com"),
    );
    await userEvent.click(page.getByRole("button", { name: "Continue" }));

    await expect.element(page.getByText("Join t3.example.com?")).toBeVisible();
    expect(mocks.join).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();

    await userEvent.click(page.getByRole("button", { name: "Join t3.example.com" }));
    await vi.waitFor(() => expect(mocks.join).toHaveBeenCalledTimes(1));
    expect(mocks.join.mock.calls[0]![0]).toMatchObject({
      environmentId: "primary",
      input: { name: "Mac" },
    });
    await vi.waitFor(() => expect(mocks.refreshStatus).toHaveBeenCalled());
  });

  it("shows an address written with other letters next to its real form", async () => {
    using _bridge = setup({ status: status({ state: "not_joined" }) });
    await using _screen = await render(ui(), { router: false });
    await userEvent.click(page.getByRole("button", { name: "Join my server" }));
    // The first "e" is Cyrillic.
    await userEvent.fill(
      page.getByRole("textbox", { name: "Invite" }),
      inviteFor("https://tе.example.com"),
    );
    await userEvent.click(page.getByRole("button", { name: "Continue" }));
    await expect.element(page.getByText("tе.example.com", { exact: true })).toBeVisible();
    await expect.element(page.getByText(/xn--t-/)).toBeVisible();
    expect(mocks.join).not.toHaveBeenCalled();
  });

  it.each([
    ["not an invite", () => "hello", "That is not an invite from your server."],
    [
      "an invite for a phone",
      () => inviteFor("https://t3.example.com", "phone"),
      "This invite is for a phone. Create one for a computer to join here.",
    ],
    [
      "an expired invite",
      () => inviteFor("https://t3.example.com", "computer", -5),
      "This invite has expired. Create a new one on a computer that is already joined.",
    ],
  ])("refuses %s", async (_name, text, message) => {
    using _bridge = setup({ status: status({ state: "not_joined" }) });
    await using _screen = await render(ui(), { router: false });
    await userEvent.click(page.getByRole("button", { name: "Join my server" }));
    await userEvent.fill(page.getByRole("textbox", { name: "Invite" }), text());
    await expect.element(page.getByText(message)).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Continue" })).toBeDisabled();
  });

  it("says when this computer was removed from the server", async () => {
    using _bridge = setup({ status: status({ state: "removed" }) });
    await using _screen = await render(ui(), { router: false });
    await expect
      .element(page.getByText("This computer was removed from your server."))
      .toBeVisible();
    await expect.element(page.getByRole("button", { name: "Join my server" })).toBeVisible();
  });

  it.each([
    ["removed", "This computer was removed from your server."],
    ["not_joined", "Connect your computers and phones through a server you run yourself."],
  ] as const)(
    "follows the pushed status when the server removes or leaves after the status was read (%s)",
    async (state, message) => {
      using _bridge = setup({
        status: status(),
        pushed: status({
          state,
          registryOrigin: null,
          registryHost: null,
          deviceId: null,
          name: null,
          url: null,
        }),
      });
      await using screen = await render(ui(), { router: false });
      await expect.element(page.getByText(message, { exact: false })).toBeVisible();
      await expect.element(page.getByRole("button", { name: "Join my server" })).toBeVisible();
      expect(screen.container.textContent).not.toContain("Connected to");
      expect(page.getByRole("button", { name: "Leave this server" }).elements()).toHaveLength(0);
    },
  );
});

describe("Your server settings, joined", () => {
  it("lists the devices and removes one after a confirmation", async () => {
    using _bridge = setup();
    mocks.remove.mockResolvedValue(
      success({
        removedAt: 1,
        rev: 2,
        pendingComputers: [{ id: "mac-mini", name: "Mac mini" }],
      }),
    );
    await using screen = await render(ui(), { router: false });
    await expect.element(page.getByText("Connected to t3.example.com.")).toBeVisible();
    // The anchor settings search jumps to.
    expect(screen.container.querySelector("#your-server")).not.toBeNull();
    await expect.element(page.getByText("Pixel")).toBeVisible();
    await expect.element(page.getByText("This computer", { exact: true })).toBeVisible();

    await userEvent.click(page.getByRole("button", { name: "Remove Pixel" }));
    await expect.element(page.getByText("Remove Pixel?")).toBeVisible();
    expect(mocks.remove).not.toHaveBeenCalled();
    await userEvent.click(page.getByRole("button", { name: "Remove", exact: true }));
    await vi.waitFor(() => expect(mocks.remove).toHaveBeenCalledTimes(1));
    expect(mocks.remove.mock.calls[0]![0]).toMatchObject({ input: { deviceId: "phone" } });
    // The computers that have not synced the removal are named.
    await expect.element(page.getByText("Removed Pixel")).toBeVisible();
    await expect
      .element(page.getByRole("listitem").filter({ hasText: /^Mac mini$/ }))
      .toBeVisible();
  });

  it("shows a computer waiting for another one as waiting, not as a failure", async () => {
    using _bridge = setup();
    mocks.deviceIds.set("env-mini", "mac-mini");
    await using _screen = await render(ui(), { router: false });
    peerWait.begin("env-mini");
    await expect.element(page.getByText("Waiting for that computer to confirm…")).toBeVisible();
  });

  it("creates an invite that is valid until a fixed time, and can cancel it", async () => {
    using bridge = setup();
    await using _screen = await render(ui(), { router: false });
    await userEvent.click(page.getByRole("button", { name: "Invite a device" }));
    await userEvent.click(page.getByRole("button", { name: "Create invite" }));
    await vi.waitFor(() =>
      expect(mocks.invite).toHaveBeenCalledWith({
        environmentId: "primary",
        input: { kind: "phone" },
      }),
    );
    const deadline = new Intl.DateTimeFormat(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(new Date(NOW + 900_000));
    await expect
      .element(
        page.getByText(`Scan the code in the app, or paste the invite. Valid until ${deadline}.`),
      )
      .toBeVisible();
    // Time passing changes nothing on screen: it is a time of day, not a countdown.
    bridge.clock.mockReturnValue(NOW + 600_000);
    await expect.element(page.getByText(new RegExp(`Valid until ${deadline}`))).toBeVisible();

    await userEvent.click(page.getByRole("button", { name: "Cancel invite" }));
    await vi.waitFor(() =>
      expect(mocks.cancelInvite).toHaveBeenCalledWith({
        environmentId: "primary",
        input: { id: "invite-1" },
      }),
    );
  });

  it("says the server cannot be reached once the last sync is minutes old, though it is still fresh", async () => {
    using _bridge = setup({
      status: status({ fetchedAt: Math.floor(NOW / 1000) - 10 * 60, staleness: "fresh" }),
    });
    await using _screen = await render(ui(), { router: false });
    await expect
      .element(page.getByText("Can't reach your server right now. Last synced 10 minutes ago."))
      .toBeVisible();
  });

  it("shows the unreachable notice by itself once the page has sat idle past three minutes", async () => {
    using _bridge = setup({
      status: status({ fetchedAt: Math.floor(NOW / 1000) - 100, staleness: "fresh" }),
    });
    using timers = fakeTimers({ now: NOW });
    await using _screen = await render(ui(), { router: false });
    await expect.element(page.getByText("Connected to t3.example.com.")).toBeVisible();
    expect(page.getByText(/Can't reach your server/).elements()).toHaveLength(0);

    // Nothing else re-renders the page: the notice arrives on its own timer, 80 seconds later.
    vi.advanceTimersByTime(80_000);
    await expect
      .element(page.getByText("Can't reach your server right now. Last synced 3 minutes ago."))
      .toBeVisible();
    vi.advanceTimersByTime(60_000);
    await expect
      .element(page.getByText("Can't reach your server right now. Last synced 4 minutes ago."))
      .toBeVisible();
    void timers;
  });

  it("stays quiet while the last sync is recent", async () => {
    using _bridge = setup({
      status: status({ fetchedAt: Math.floor(NOW / 1000) - 30, staleness: "fresh" }),
    });
    await using _screen = await render(ui(), { router: false });
    await expect.element(page.getByText("Connected to t3.example.com.")).toBeVisible();
    expect(page.getByText(/Can't reach your server/).elements()).toHaveLength(0);
  });

  it("leaves the server after a confirmation", async () => {
    using _bridge = setup();
    await using _screen = await render(ui(), { router: false });
    await userEvent.click(page.getByRole("button", { name: "Leave this server" }));
    await expect.element(page.getByText("Leave your server?")).toBeVisible();
    expect(mocks.leave).not.toHaveBeenCalled();
    await userEvent.click(page.getByRole("button", { name: "Leave", exact: true }));
    await vi.waitFor(() => expect(mocks.leave).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(mocks.refreshStatus).toHaveBeenCalled());
  });
});

describe("Your server settings, elsewhere", () => {
  it("shows nothing of the new section where there is no desktop app", async () => {
    using _bridge = setup({ desktop: false });
    await using screen = await render(ui(), { router: false });
    expect(screen.container.textContent).not.toContain("Your server");
  });

  it("keeps the public addresses and the tunnel command under Advanced", async () => {
    using _bridge = setup();
    const bridge = {
      getState: async () => selfHostState,
      setPublicUrls: async () => selfHostState,
      setTunnel: async () => selfHostState,
      restartTunnel: async () => selfHostState,
      onState: () => () => {},
    };
    using _selfHost = stubGlobal("t3xSelfHostBridge", bridge);
    await using _screen = await render(ui(), { router: false });
    await userEvent.click(page.getByText("Advanced"));
    await expect.element(page.getByText("Public addresses")).toBeVisible();
    await expect.element(page.getByText("Tunnel command", { exact: true })).toBeVisible();
    await expect.element(page.getByText("https://t3.example.net")).toBeVisible();
  });
});

const selfHostState = {
  publicUrls: ["https://t3.example.net"],
  environmentPublicUrls: [],
  tunnel: {
    command: "frpc -c ~/frpc.toml",
    enabled: false,
    status: "stopped" as const,
    pid: null,
    restarts: 0,
    lastError: null,
    lastExit: null,
    recentOutput: [],
  },
};
