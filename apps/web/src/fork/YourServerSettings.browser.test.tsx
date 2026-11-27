import { encodeInvite } from "@t3tools/shared/forkDeviceKeys/invite";
import { DeviceKeysError } from "@t3tools/contracts";
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
  setVisibility: vi.fn(),
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
    setVisibility: "setVisibility",
  } as never,
  refreshDevicesStatus: mocks.refreshStatus,
}));
vi.mock(import("~/state/environments"), async (original) => ({
  ...(await original()),
  usePrimaryEnvironmentId: (() => "primary") as never,
}));
vi.mock(import("~/state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((
    command: "join" | "leave" | "invite" | "cancelInvite" | "remove" | "setVisibility",
  ) => mocks[command]) as never,
}));

import { peerWait } from "~/fork/deviceKeysRuntime";
import { YourServerSettings } from "./YourServerSettings";
import { LocalVisibilityMark } from "./VisibilityMark";

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
    mocks.setVisibility,
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
  mocks.setVisibility.mockResolvedValue(success(status()));
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

describe("Your server settings, visibility", () => {
  const visible = (
    mode: NonNullable<DevicesStatus["visibility"]>["mode"],
    deviceIds: ReadonlyArray<string> = [],
    registry: NonNullable<DevicesStatus["visibility"]>["registry"] = "synced",
  ) => status({ visibility: { mode, deviceIds, registry } });

  it("says everyone can see this computer until told otherwise", async () => {
    using _bridge = setup({ status: visible("visible_to_all") });
    await using _screen = await render(ui(), { router: false });
    // The current choice sits right beside the title, with no marks anywhere else.
    await expect
      .element(page.getByRole("heading", { name: "Visibility Visible to all devices" }))
      .toBeVisible();
    expect(page.getByText("Can't see this computer").elements()).toHaveLength(0);
    expect(page.getByText("Visible to all devices.").elements()).toHaveLength(0);
  });

  it("reads the active mode beside the title in each of the four modes", async () => {
    const heading = (name: string) => page.getByRole("heading", { name: `Visibility ${name}` });
    {
      using _bridge = setup({ status: visible("hidden_from_all") });
      await using _screen = await render(ui(), { router: false });
      await expect.element(heading("Hidden from all devices")).toBeVisible();
    }
    {
      using _bridge = setup({ status: visible("hidden_from_selected", ["mac-mini", "phone"]) });
      await using _screen = await render(ui(), { router: false });
      await expect.element(heading("Hidden from Mac mini, Pixel")).toBeVisible();
      await expect.element(page.getByText("Hidden from Mac mini, Pixel.")).toBeVisible();
    }
    {
      using _bridge = setup({ status: visible("visible_to_selected", ["phone"]) });
      await using _screen = await render(ui(), { router: false });
      await expect.element(heading("Visible only to Pixel")).toBeVisible();
    }
    {
      using _bridge = setup({
        status: visible("hidden_from_selected", ["mac-mini", "phone", "x"]),
      });
      await using _screen = await render(ui(), { router: false });
      await expect.element(heading("Hidden from 3 devices")).toBeVisible();
    }
  });

  it("marks this computer and the devices that cannot see it in the list, and no one else", async () => {
    using _bridge = setup({ status: visible("hidden_from_selected", ["mac-mini"]) });
    await using _screen = await render(ui(), { router: false });
    // This computer's own row says the mode; only the device it hides from gets the second mark.
    await expect.element(page.getByText("Can't see this computer")).toBeVisible();
    expect(page.getByText("Can't see this computer").elements()).toHaveLength(1);
    expect(page.getByText("Hidden from Mac mini", { exact: true }).elements()).toHaveLength(2);
  });

  it("marks every other device when hidden from all, and the ones left out when visible to selected", async () => {
    {
      using _bridge = setup({ status: visible("hidden_from_all") });
      await using _screen = await render(ui(), { router: false });
      await expect.element(page.getByText("Can't see this computer").first()).toBeVisible();
      expect(page.getByText("Can't see this computer").elements()).toHaveLength(2);
    }
    {
      using _bridge = setup({ status: visible("visible_to_selected", ["phone"]) });
      await using _screen = await render(ui(), { router: false });
      await expect.element(page.getByText("Can't see this computer")).toBeVisible();
      expect(page.getByText("Can't see this computer").elements()).toHaveLength(1);
    }
  });

  it("shows the environment lists' mark only for this computer, and only when it is limited", async () => {
    const mark = (environmentId: string) => (
      <AppAtomRegistryProvider>
        <LocalVisibilityMark environmentId={environmentId as never} />
      </AppAtomRegistryProvider>
    );
    {
      using _bridge = setup({ status: visible("visible_to_all") });
      await using screen = await render(mark("primary"), { router: false });
      expect(screen.container.querySelector("svg")).toBeNull();
    }
    {
      using _bridge = setup({ status: visible("hidden_from_all") });
      await using screen = await render(mark("remote"), { router: false });
      expect(screen.container.querySelector("svg")).toBeNull();
    }
    {
      using _bridge = setup({ status: visible("hidden_from_all") });
      await using _screen = await render(mark("primary"), { router: false });
      await expect
        .element(
          page.getByRole("img", {
            name: "Hidden from all devices, including ones that join later.",
          }),
        )
        .toBeVisible();
    }
    {
      using _bridge = setup({ desktop: false, status: visible("hidden_from_all") });
      await using screen = await render(mark("primary"), { router: false });
      expect(screen.container.querySelector("svg")).toBeNull();
    }
  });

  it("lists the other devices for the two modes that name devices, and saves the pick", async () => {
    using _bridge = setup({ status: visible("visible_to_all") });
    await using _screen = await render(ui(), { router: false });
    await userEvent.click(page.getByRole("button", { name: "Change" }));
    await expect.element(page.getByText("Who can see this computer").first()).toBeVisible();
    // No list while the mode names nobody.
    expect(page.getByRole("list", { name: "Devices" }).elements()).toHaveLength(0);

    await userEvent.click(page.getByRole("radio", { name: /Hidden from selected devices/ }));
    const list = page.getByRole("list", { name: "Devices" });
    await expect.element(list).toBeVisible();
    // This computer is not offered; the others are, computers first.
    expect(list.getByRole("checkbox").elements()).toHaveLength(2);
    await expect.element(list.getByText("Mac", { exact: true })).not.toBeInTheDocument();
    await expect.element(list.getByText("Mac mini")).toBeVisible();
    // Nothing picked yet: saving would mean "hidden from nobody".
    await expect.element(page.getByRole("button", { name: "Save" })).toBeDisabled();

    await userEvent.click(list.getByRole("checkbox", { name: /Pixel/ }));
    await userEvent.click(page.getByRole("button", { name: "Save" }));
    await vi.waitFor(() => expect(mocks.setVisibility).toHaveBeenCalledTimes(1));
    expect(mocks.setVisibility.mock.calls[0]![0]).toEqual({
      environmentId: "primary",
      input: { mode: "hidden_from_selected", deviceIds: ["phone"] },
    });
  });

  it("sends no list for the modes that name nobody, and saves nothing when nothing changed", async () => {
    using _bridge = setup({ status: visible("hidden_from_selected", ["phone"]) });
    await using _screen = await render(ui(), { router: false });
    await expect.element(page.getByText("Hidden from Pixel.")).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Change" }));
    await expect.element(page.getByRole("button", { name: "Save" })).toBeDisabled();
    await userEvent.click(page.getByRole("radio", { name: /Hidden from all devices/ }));
    await userEvent.click(page.getByRole("button", { name: "Save" }));
    await vi.waitFor(() => expect(mocks.setVisibility).toHaveBeenCalledTimes(1));
    expect(mocks.setVisibility.mock.calls[0]![0].input).toEqual({
      mode: "hidden_from_all",
      deviceIds: [],
    });
  });

  describe("with a device this computer cannot see", () => {
    // Hidden from Pixel and from a computer that hides from this one, so it is not on the list.
    const UNSEEN = "unseen-0123456789abcdefghijklmnopqrstuvwxyzABC";

    it("counts it in the row, keeps it selected in the dialog and does not offer a save that changes nothing", async () => {
      using _bridge = setup({ status: visible("hidden_from_selected", ["phone", UNSEEN]) });
      await using _screen = await render(ui(), { router: false });
      await expect.element(page.getByText("Hidden from Pixel, unseen-0….")).toBeVisible();
      await userEvent.click(page.getByRole("button", { name: "Change" }));
      await userEvent.click(page.getByRole("radio", { name: /Hidden from selected devices/ }));
      await expect.element(page.getByRole("button", { name: "Save" })).toBeDisabled();
      const unseen = page.getByRole("checkbox", { name: /unseen-0/ });
      await expect.element(unseen).toBeChecked();
      await expect.element(page.getByText("Not on your list")).toBeVisible();
    });

    it("saves the id along with another change", async () => {
      using _bridge = setup({ status: visible("hidden_from_selected", ["phone", UNSEEN]) });
      await using _screen = await render(ui(), { router: false });
      await userEvent.click(page.getByRole("button", { name: "Change" }));
      const list = page.getByRole("list", { name: "Devices" });
      await userEvent.click(list.getByRole("checkbox", { name: /Mac mini/ }));
      await userEvent.click(page.getByRole("button", { name: "Save" }));
      await vi.waitFor(() => expect(mocks.setVisibility).toHaveBeenCalledTimes(1));
      expect(mocks.setVisibility.mock.calls[0]![0].input).toEqual({
        mode: "hidden_from_selected",
        deviceIds: ["mac-mini", "phone", UNSEEN].toSorted(),
      });
    });

    it("drops the id only when the user unchecks it", async () => {
      using _bridge = setup({ status: visible("hidden_from_selected", ["phone", UNSEEN]) });
      await using _screen = await render(ui(), { router: false });
      await userEvent.click(page.getByRole("button", { name: "Change" }));
      await userEvent.click(
        page.getByRole("list", { name: "Devices" }).getByRole("checkbox", { name: /unseen-0/ }),
      );
      await userEvent.click(page.getByRole("button", { name: "Save" }));
      await vi.waitFor(() => expect(mocks.setVisibility).toHaveBeenCalledTimes(1));
      expect(mocks.setVisibility.mock.calls[0]![0].input.deviceIds).toEqual(["phone"]);
    });
  });

  it("says the saved setting could not be read, instead of showing a guess as the choice", async () => {
    using _bridge = setup({
      status: status({
        visibility: {
          mode: "hidden_from_all",
          deviceIds: [],
          registry: "synced",
          unreadable: true,
        },
      }),
    });
    await using _screen = await render(ui(), { router: false });
    await expect.element(page.getByText(/saved setting could not be read/).first()).toBeVisible();
    expect(
      page.getByText("Hidden from all devices, including ones that join later.").elements(),
    ).toHaveLength(0);
    await userEvent.click(page.getByRole("button", { name: "Change" }));
    // Saving writes a readable file, so it is offered even though the options look unchanged.
    await expect.element(page.getByRole("button", { name: "Save" })).toBeEnabled();
  });

  it("tells the user a computer it hides from must be updated too", async () => {
    using _bridge = setup({ status: visible("visible_to_all") });
    await using _screen = await render(ui(), { router: false });
    await userEvent.click(page.getByRole("button", { name: "Change" }));
    const note = page.getByText(/Update every computer you hide this one from/);
    expect(note.elements()).toHaveLength(0);
    await userEvent.click(page.getByRole("radio", { name: /Hidden from all devices/ }));
    await expect.element(note).toBeVisible();
  });

  it("says plainly when the server is too old, in the row and in the dialog", async () => {
    using _bridge = setup({ status: visible("hidden_from_all", [], "unsupported") });
    await using _screen = await render(ui(), { router: false });
    const notice = page.getByText(/needs an update before it can hide this computer/);
    await expect.element(notice).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Change" }));
    expect(
      page.getByText(/needs an update before it can hide this computer/).elements(),
    ).toHaveLength(2);
  });

  it("says a setting the server has not received yet is already applied here", async () => {
    using _bridge = setup({ status: visible("hidden_from_all", [], "pending") });
    await using _screen = await render(ui(), { router: false });
    await expect.element(page.getByText(/has not received this setting yet/)).toBeVisible();
  });

  it("shows a refusal from this computer in the dialog and keeps it open", async () => {
    using _bridge = setup({ status: visible("visible_to_all") });
    mocks.setVisibility.mockResolvedValue(
      AsyncResult.fail(
        new DeviceKeysError({ reason: "registry_unreachable", message: "x" }),
      ) as never,
    );
    await using _screen = await render(ui(), { router: false });
    await userEvent.click(page.getByRole("button", { name: "Change" }));
    await userEvent.click(page.getByRole("radio", { name: /Hidden from all devices/ }));
    await userEvent.click(page.getByRole("button", { name: "Save" }));
    await expect.element(page.getByText("Can't reach your server.")).toBeVisible();
    await expect.element(page.getByText("Who can see this computer").first()).toBeVisible();
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
