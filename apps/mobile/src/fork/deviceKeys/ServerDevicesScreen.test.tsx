import type { RegistryDevice } from "@t3tools/contracts";
import { encodeInvite } from "@t3tools/shared/forkDeviceKeys/invite";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { DeviceSyncState } from "./deviceSync";

const { Children, mocks } = vi.hoisted(() => ({
  Children: ({ children }: { children?: ReactNode }) => children,
  mocks: {
    state: { _tag: "loading" } as unknown,
    join: vi.fn(),
    leave: vi.fn(),
    refresh: vi.fn(),
    alert: vi.fn(),
    confirm: vi.fn(),
    prompt: vi.fn(),
    waiting: new Set<string>(),
  },
}));

vi.mock("react-native", () => ({
  View: Children,
  Modal: () => null,
  RefreshControl: () => null,
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("expo-camera", () => ({
  CameraView: () => null,
  useCameraPermissions: () => [{ granted: false }, () => {}],
}));
vi.mock("expo-device", () => ({ deviceName: "Pixel 9", modelName: "Pixel 9" }));
vi.mock("../../components/ui/ScreenScrollView", () => ({ ScreenScrollView: Children }));
vi.mock("../../components/ui/AppText", () => ({ AppText: Children }));
vi.mock("../../components/ui/Dialog", () => ({
  alert: mocks.alert,
  confirm: mocks.confirm,
  prompt: mocks.prompt,
}));
vi.mock("../../components/ui/Notice", () => ({
  Notice: ({ message }: { message: string }) => <p role="status">{message}</p>,
}));
vi.mock("../../components/ui/ListActionRow", () => ({
  ListActionRow: ({ label, onPress }: { label: string; onPress: () => void }) => (
    <button onClick={onPress}>{label}</button>
  ),
}));
vi.mock("../../components/ui/ListRowLayout", () => ({
  ListRowLayout: ({ label, description }: { label: string; description?: string }) => (
    <li>
      {label}
      <small>{description}</small>
    </li>
  ),
}));
vi.mock("../../features/settings/components/SettingsScreen", () => ({ SettingsScreen: Children }));
vi.mock("../../features/settings/components/SettingsSection", () => ({
  SettingsSection: ({ children, footer }: { children?: ReactNode; footer?: string }) => (
    <section>
      {children}
      <footer>{footer}</footer>
    </section>
  ),
}));
// The clock is the upstream minute tick; pinning it keeps the labels exact.
vi.mock("../../lib/clock", () => ({
  useNowMinuteMs: () => Date.parse("2026-11-03T12:00:00.000Z"),
}));
vi.mock("./deviceKeysStore", () => ({
  deviceSync: { join: mocks.join, leave: mocks.leave, refresh: mocks.refresh },
  useDeviceSyncState: () => mocks.state,
}));
vi.mock("./deviceKeysRuntime", () => ({
  peerWait: {
    subscribe: () => () => {},
    snapshot: () => mocks.waiting,
  },
  deviceEnvironmentIndex: { get: (environmentId: string) => environmentId.replace("env-", "") },
}));

import { ServerDevicesScreen } from "./ServerDevicesScreen";

const NOW = Date.parse("2026-11-03T12:00:00.000Z");
const seconds = (ms: number) => Math.floor(ms / 1000);

const device = (overrides: Partial<RegistryDevice>): RegistryDevice => ({
  id: "d",
  name: "Device",
  kind: "computer",
  jwk: { kty: "EC", crv: "P-256", x: "x", y: "y" },
  createdAt: 1,
  lastSeenAt: seconds(NOW) - 3600,
  ...overrides,
});

const joined = (overrides: Partial<Extract<DeviceSyncState, { _tag: "joined" }>> = {}) =>
  ({
    _tag: "joined",
    membership: {
      v: 1,
      origin: "https://t3.example.com",
      registryId: "abcdefgh",
      deviceId: "me",
      name: "Pixel",
      joinedAt: 1,
    },
    devices: [
      device({ id: "me", name: "Pixel", kind: "phone" }),
      device({ id: "mini", name: "Mac mini", online: true }),
    ],
    rev: 1,
    fetchedAt: seconds(NOW),
    unreachable: false,
    ...overrides,
  }) satisfies DeviceSyncState;

const inviteText = (origin: string, kind: "computer" | "phone" = "phone") =>
  encodeInvite({
    origin,
    registryId: "abcdefgh",
    id: "AAAAAAAAAAA",
    secret: "B".repeat(22),
    kind,
    expiresAt: seconds(NOW) + 900,
  });

let host: HTMLElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  for (const mock of [
    mocks.join,
    mocks.leave,
    mocks.refresh,
    mocks.alert,
    mocks.confirm,
    mocks.prompt,
  ]) {
    mock.mockReset();
  }
  mocks.waiting = new Set();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const render = () => act(() => root.render(<ServerDevicesScreen />));
const press = (label: string) =>
  act(() => {
    [...host.querySelectorAll("button")].find((b) => b.textContent === label)!.click();
  });

describe("the phone's server page, not joined", () => {
  beforeEach(() => {
    mocks.state = { _tag: "not-joined", removed: false } satisfies DeviceSyncState;
  });

  it("asks for an invite, then asks which server it names before anything is sent", () => {
    render();
    press("Paste invite");
    const prompt = mocks.prompt.mock.calls[0]![0] as { onConfirm: (text: string) => void };
    prompt.onConfirm(inviteText("https://t3.example.com"));

    const confirm = mocks.confirm.mock.calls[0]![0] as { title: string; onConfirm: () => void };
    expect(confirm.title).toBe("Join t3.example.com?");
    expect(mocks.join).not.toHaveBeenCalled();
    mocks.join.mockResolvedValue({ ok: true });
    confirm.onConfirm();
    expect(mocks.join).toHaveBeenCalledWith(expect.stringMatching(/^t3x1\./), "Pixel 9");
  });

  it("shows an address written with other letters next to its ASCII form", () => {
    render();
    press("Paste invite");
    (mocks.prompt.mock.calls[0]![0] as { onConfirm: (text: string) => void }).onConfirm(
      inviteText("https://tе.example.com"),
    );
    expect((mocks.confirm.mock.calls[0]![0] as { message: string }).message).toMatch(/xn--t-/);
  });

  it.each([
    ["not an invite", "hello", "That is not an invite from your server."],
    [
      "an invite for a computer",
      inviteText("https://t3.example.com", "computer"),
      "This invite is for a computer. Create one for a phone to join here.",
    ],
  ])("refuses %s without asking or sending", (_name, text, message) => {
    render();
    press("Paste invite");
    (mocks.prompt.mock.calls[0]![0] as { onConfirm: (text: string) => void }).onConfirm(text);
    expect(mocks.alert).toHaveBeenCalledWith("Can't join", message);
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.join).not.toHaveBeenCalled();
  });

  it("says why a join the server rejected failed", async () => {
    mocks.join.mockResolvedValue({ ok: false, failure: "invite-used" });
    render();
    press("Paste invite");
    (mocks.prompt.mock.calls[0]![0] as { onConfirm: (text: string) => void }).onConfirm(
      inviteText("https://t3.example.com"),
    );
    await act(async () =>
      (mocks.confirm.mock.calls[0]![0] as { onConfirm: () => void }).onConfirm(),
    );
    expect(mocks.alert).toHaveBeenCalledWith("Can't join", "This invite has already been used.");
  });

  it("tells a phone that was removed so", () => {
    mocks.state = { _tag: "not-joined", removed: true } satisfies DeviceSyncState;
    render();
    expect(host.textContent).toContain("This phone was removed from your server.");
  });
});

describe("the phone's server page, joined", () => {
  it("lists the devices read-only, marks this phone, and shows a computer being waited for", () => {
    mocks.state = joined();
    mocks.waiting = new Set(["env-mini"]);
    render();
    expect(host.textContent).toContain("Pixel (this phone)");
    expect(host.textContent).toContain("Waiting for that computer to confirm…");
    expect(host.textContent).toContain("Connected to t3.example.com.");
    // A phone does not invite or remove: the only action is leaving.
    expect([...host.querySelectorAll("button")].map((b) => b.textContent)).toEqual([
      "Leave this server",
    ]);
  });

  it("says the server cannot be reached when the last refresh failed", () => {
    mocks.state = joined({ unreachable: true, fetchedAt: seconds(NOW) - 600 });
    render();
    expect(host.querySelector("[role=status]")!.textContent).toBe(
      "Can't reach your server right now. Last synced 10 minutes ago.",
    );
  });

  it("leaves only after a confirmation", () => {
    mocks.state = joined();
    render();
    press("Leave this server");
    expect(mocks.leave).not.toHaveBeenCalled();
    (mocks.confirm.mock.calls[0]![0] as { onConfirm: () => void }).onConfirm();
    expect(mocks.leave).toHaveBeenCalledTimes(1);
  });
});

describe("the phone's server page, when the stored key cannot be read", () => {
  it("offers to leave and join again", () => {
    mocks.state = { _tag: "damaged" } satisfies DeviceSyncState;
    render();
    expect(host.textContent).toContain("The device key on this phone cannot be read.");
    press("Leave this server");
    expect(mocks.confirm).toHaveBeenCalled();
  });
});
