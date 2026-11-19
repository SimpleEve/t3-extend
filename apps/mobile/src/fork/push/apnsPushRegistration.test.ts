import type { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import * as Effect from "effect/Effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

// fork: drives the iPhone registration controller against fakes for the native token, the
// connection state and the servers' capabilities.
const fake = vi.hoisted(() => {
  const state = {
    token: "ab".repeat(32) as string | null,
    catalog: new Map<string, unknown>(),
    connected: new Set<string>(),
    capabilities: new Map<string, { apnsPush?: boolean }>(),
    connectionListeners: new Set<() => void>(),
    configListeners: new Map<string, Set<() => void>>(),
    secure: new Map<string, string>(),
  };
  const setConnected = (id: string, connected: boolean) => {
    if (connected) state.connected.add(id);
    else state.connected.delete(id);
    for (const listener of state.connectionListeners) listener();
  };
  /** The server's capabilities arrive or change: whoever watches its config is told. */
  const setCapabilities = (id: string, capabilities: { apnsPush?: boolean } | null) => {
    if (capabilities === null) state.capabilities.delete(id);
    else state.capabilities.set(id, capabilities);
    for (const listener of state.configListeners.get(id) ?? []) listener();
  };
  const watchers = () =>
    state.connectionListeners.size +
    [...state.configListeners.values()].reduce((total, set) => total + set.size, 0);
  return { state, setConnected, setCapabilities, watchers, command: vi.fn() };
});

vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  AppState: { addEventListener: () => ({ remove: () => {} }) },
}));
vi.mock("expo-constants", () => ({
  default: {
    expoConfig: { ios: { bundleIdentifier: "com.example.app" }, extra: {} },
    deviceName: "Test phone",
  },
}));
vi.mock("expo-notifications", () => ({
  getPermissionsAsync: async () => ({ granted: true }),
  getDevicePushTokenAsync: async () => {
    if (fake.state.token === null) throw new Error("no token");
    return { type: "ios", data: fake.state.token };
  },
  addPushTokenListener: () => ({ remove: () => {} }),
}));
vi.mock("expo-secure-store", () => ({
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 0,
  getItemAsync: async (key: string) => fake.state.secure.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => void fake.state.secure.set(key, value),
  deleteItemAsync: async (key: string) => void fake.state.secure.delete(key),
}));
vi.mock("@t3tools/client-runtime/i18n", async () => ({
  ...(await vi.importActual<object>("@t3tools/client-runtime/i18n")),
  getUiLocale: () => "en",
  subscribeUiLocale: () => () => {},
}));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  runAtomCommand: (_registry: unknown, command: unknown, input: unknown) =>
    fake.command(command, input),
  squashAtomCommandFailure: (result: { readonly error: unknown }) => result.error,
}));
vi.mock("../../features/agent-awareness/notificationPermissions", () => ({
  requestAgentNotificationPermission: Effect.succeed({ type: "granted" as const }),
}));
vi.mock("../../persistence/imperative", () => ({
  loadOrCreateAgentAwarenessDeviceId: async () => "device-1",
}));
vi.mock("../../connection/catalog", () => ({
  environmentCatalog: { catalogValueAtom: "catalog", stateAtom: (id: string) => `state:${id}` },
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: { configValueAtom: (id: string) => `config:${id}` },
}));
vi.mock("../../state/atom-registry", () => ({
  appAtomRegistry: {
    get: (atom: string) => {
      if (atom.startsWith("state:")) {
        return AsyncResult.success({
          phase: fake.state.connected.has(atom.slice(6)) ? "connected" : "backoff",
        });
      }
      if (atom.startsWith("config:")) {
        const capabilities = fake.state.capabilities.get(atom.slice(7));
        return capabilities === undefined ? undefined : { environment: { capabilities } };
      }
      return { entries: fake.state.catalog };
    },
    subscribe: (atom: string, listener: () => void) => {
      if (atom.startsWith("state:")) {
        fake.state.connectionListeners.add(listener);
        return () => void fake.state.connectionListeners.delete(listener);
      }
      if (atom.startsWith("config:")) {
        const id = atom.slice(7);
        const set = fake.state.configListeners.get(id) ?? new Set();
        fake.state.configListeners.set(id, set.add(listener));
        return () => void set.delete(listener);
      }
      return () => {};
    },
  },
}));
vi.mock("./pushCommands", () => ({
  pushEnvironment: { register: "register", unregister: "unregister", sendTest: "sendTest" },
}));
vi.mock("./unifiedPushNative", async () => {
  const { NO_NATIVE_STATE } =
    await vi.importActual<typeof import("./unifiedPushTypes")>("./unifiedPushTypes");
  return {
    NO_NATIVE_STATE,
    supportsUnifiedPush: () => false,
    readUnifiedPushState: () => NO_NATIVE_STATE,
  };
});

import { getApnsPushState } from "./apnsPushStore";
import {
  disableApnsPush,
  enableApnsPush,
  installApnsPushRegistration,
} from "./apnsPushRegistration";

const settle = () => vi.advanceTimersByTimeAsync(1_000);

const ENVIRONMENT = { enabled: true, unsupportedReason: undefined, profile: { _tag: "None" } };
const OK = { _tag: "Success", value: { lastDelivery: null } };
const REFUSED = { _tag: "Failure", error: { _tag: "PushRegistrationError", reason: "too_many" } };
const sentCommands = () => fake.command.mock.calls.map(([command]) => command as string);
const unregisteredFrom = () =>
  fake.command.mock.calls
    .filter(([command]) => command === "unregister")
    .map(([, input]) => (input as { environmentId: EnvironmentId }).environmentId);
const statesOf = () =>
  getApnsPushState().environments.map(({ state, failure }) => [state, failure]);

describe("iPhone push registration controller", () => {
  let dispose: () => void;

  beforeEach(async () => {
    vi.useFakeTimers();
    fake.state.token = "ab".repeat(32);
    fake.state.catalog = new Map([["env-1", ENVIRONMENT]]);
    fake.state.connected = new Set(["env-1"]);
    fake.state.capabilities = new Map([["env-1", { apnsPush: true }]]);
    fake.state.connectionListeners = new Set();
    fake.state.configListeners = new Map();
    fake.state.secure = new Map();
    fake.command.mockReset();
    fake.command.mockResolvedValue(OK);
    dispose = installApnsPushRegistration();
    await settle();
  });

  afterEach(() => {
    dispose();
    vi.useRealTimers();
  });

  it("still withdraws a registration the server holds when the token goes missing before push is switched off", async () => {
    await enableApnsPush();
    await settle();
    expect(statesOf()).toEqual([["registered", undefined]]);

    // Apple hands out no token for a while: the screen forgets, the server still has the phone.
    fake.state.token = null;
    fake.setConnected("env-1", false);
    fake.setConnected("env-1", true);
    await settle();
    expect(getApnsPushState().tokenFailed).toBe(true);
    expect(getApnsPushState().environments).toEqual([]);

    await disableApnsPush();
    expect(unregisteredFrom()).toEqual(["env-1"]);
  });

  it("asks a server again once its capabilities settle what it refused before they were known", async () => {
    // The capabilities have not arrived, so the first registration goes out and is refused.
    fake.state.capabilities = new Map();
    fake.command.mockResolvedValue(REFUSED);
    await enableApnsPush();
    await settle();
    expect(statesOf()).toEqual([["failed", "rejected"]]);

    fake.setCapabilities("env-1", { apnsPush: false });
    await settle();
    expect(statesOf()).toEqual([["failed", "server-outdated"]]);

    // The server is updated and has a key now: the same registration is sent again.
    fake.command.mockResolvedValue(OK);
    fake.setCapabilities("env-1", { apnsPush: true });
    await settle();
    expect(statesOf()).toEqual([["registered", undefined]]);
  });

  it("leaves no subscription behind when push is switched off while a registration is in flight", async () => {
    let release: (result: unknown) => void = () => {};
    fake.command.mockImplementation((command: string) =>
      command === "register"
        ? new Promise((resolve) => {
            release = resolve;
          })
        : Promise.resolve({ _tag: "Success", value: { removed: true } }),
    );
    await enableApnsPush();
    await settle();
    expect(fake.watchers()).toBe(2);

    const disabling = disableApnsPush();
    release(OK);
    await disabling;
    await settle();
    expect(fake.watchers()).toBe(0);
    expect(sentCommands()).toEqual(["register", "unregister"]);
  });
});
