import * as Effect from "effect/Effect";
import { AsyncResult } from "effect/reactivity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { UnifiedPushNativeState, UnifiedPushSubscription } from "./unifiedPushTypes";

// fork: drives the registration controller against a fake distributor that behaves like the
// Kotlin module: unregistering forgets the saved distributor and the endpoint, and registering
// is only answered while a distributor is saved.
const fake = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const state = {
    enabled: false,
    distributors: [{ id: "io.heckel.ntfy", label: "ntfy" }],
    distributor: null as string | null,
    subscription: null as { endpoint: string; p256dh: string; auth: string } | null,
    failure: null as string | null,
    registerCalls: 0,
    catalog: new Map<string, unknown>(),
    connected: new Set<string>(),
    connectionListeners: new Set<() => void>(),
  };
  /** The supervisor's own signal: flipping it notifies whoever subscribed to the state atom. */
  const setConnected = (id: string, connected: boolean) => {
    if (connected) state.connected.add(id);
    else state.connected.delete(id);
    for (const listener of state.connectionListeners) listener();
  };
  return { listeners, state, setConnected, command: vi.fn() };
});

vi.mock("react-native", () => ({
  Platform: { OS: "android" },
  AppState: { addEventListener: () => ({ remove: () => {} }) },
}));
vi.mock("expo-constants", () => ({
  default: { expoConfig: { scheme: "t3extend" }, deviceName: "Test phone" },
}));
vi.mock("expo-notifications", () => ({
  getPermissionsAsync: async () => ({ granted: true }),
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
vi.mock("../../state/atom-registry", () => ({
  appAtomRegistry: {
    get: (atom: string) =>
      atom.startsWith("state:")
        ? AsyncResult.success({
            phase: fake.state.connected.has(atom.slice(6)) ? "connected" : "backoff",
          })
        : { entries: fake.state.catalog },
    subscribe: (atom: string, listener: () => void) => {
      if (!atom.startsWith("state:")) return () => {};
      fake.state.connectionListeners.add(listener);
      return () => void fake.state.connectionListeners.delete(listener);
    },
  },
}));
vi.mock("./pushCommands", () => ({
  pushEnvironment: { register: "register", unregister: "unregister", sendTest: "sendTest" },
}));
vi.mock("./unifiedPushNative", async () => {
  const { NO_NATIVE_STATE } =
    await vi.importActual<typeof import("./unifiedPushTypes")>("./unifiedPushTypes");
  const { state, listeners } = fake;
  const answer = () => {
    for (const listener of listeners) listener();
  };
  return {
    NO_NATIVE_STATE,
    supportsUnifiedPush: () => true,
    readUnifiedPushState: (): UnifiedPushNativeState => ({
      enabled: state.enabled,
      distributors: state.distributors,
      distributor: state.distributor,
      endpointHost: state.subscription === null ? null : "ntfy.example.com",
      hasKeys: state.subscription !== null,
      failure: state.failure,
    }),
    readUnifiedPushSubscription: (): UnifiedPushSubscription | null => state.subscription,
    setUnifiedPushEnabled: (enabled: boolean) => {
      state.enabled = enabled;
    },
    selectUnifiedPushDistributor: (distributor: string) => {
      state.distributor = distributor;
    },
    registerUnifiedPush: () => {
      state.registerCalls += 1;
      if (state.distributor === null) return;
      state.subscription = {
        endpoint: "https://ntfy.example.com/upTopic?up=1",
        p256dh:
          "BLn_9QJ0gS7yQmWbU3x8zL1vP4k6d2h7s9a0q1w2e3r4t5y6u7i8o9p0a1s2d3f4g5h6j7k8l9z0x1c2v3b4n",
        auth: "AbCdEfGhIjKlMnOpQrStUv",
      };
      answer();
    },
    unregisterUnifiedPush: () => {
      state.distributor = null;
      state.subscription = null;
    },
    setUnifiedPushTemplates: () => {},
    onUnifiedPushChange: (listener: () => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
});

import { getPushEnvironments } from "./pushStore";
import {
  chooseUnifiedPushDistributor,
  disableUnifiedPush,
  enableUnifiedPush,
  installUnifiedPushRegistration,
} from "./unifiedPushRegistration";

const settle = () => vi.advanceTimersByTimeAsync(1_000);

describe("UnifiedPush registration controller", () => {
  let dispose: () => void;

  beforeEach(async () => {
    vi.useFakeTimers();
    fake.state.enabled = false;
    fake.state.distributor = null;
    fake.state.subscription = null;
    fake.state.failure = null;
    fake.state.registerCalls = 0;
    fake.state.catalog = new Map();
    fake.state.connected = new Set();
    fake.state.connectionListeners = new Set();
    fake.command.mockReset();
    fake.command.mockResolvedValue({ _tag: "Success", value: { lastDelivery: null } });
    dispose = installUnifiedPushRegistration();
    await settle();
  });

  afterEach(() => {
    dispose();
    vi.useRealTimers();
  });

  it("asks the distributor for an endpoint again after push is switched off and on", async () => {
    await enableUnifiedPush();
    await settle();
    expect(fake.state.registerCalls).toBe(1);
    expect(fake.state.subscription).not.toBeNull();

    await disableUnifiedPush();
    await settle();
    expect(fake.state.subscription).toBeNull();

    await enableUnifiedPush();
    await settle();
    expect(fake.state.registerCalls).toBe(2);
    expect(fake.state.subscription).not.toBeNull();
  });

  it("registers again when the user picks the same push app after a failure", async () => {
    await enableUnifiedPush();
    await settle();
    expect(fake.state.registerCalls).toBe(1);

    fake.state.subscription = null;
    fake.state.failure = "NETWORK";
    chooseUnifiedPushDistributor("io.heckel.ntfy");
    await settle();
    expect(fake.state.registerCalls).toBe(2);
  });

  it("retries a registration that failed while the environment was unreachable", async () => {
    fake.state.catalog = new Map([
      ["env-1", { enabled: true, unsupportedReason: undefined, profile: { _tag: "None" } }],
    ]);
    fake.state.connected.add("env-1");
    fake.command
      .mockResolvedValueOnce({ _tag: "Failure", error: { _tag: "EnvironmentRpcUnavailableError" } })
      .mockResolvedValue({ _tag: "Success", value: { lastDelivery: null } });

    await enableUnifiedPush();
    await settle();
    expect(getPushEnvironments().map(({ state, failure }) => [state, failure])).toEqual([
      ["failed", "unreachable"],
    ]);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(fake.command).toHaveBeenCalledTimes(2);
    expect(getPushEnvironments().map(({ state }) => state)).toEqual(["registered"]);
  });

  it("does not retry what the environment refused", async () => {
    fake.state.catalog = new Map([
      ["env-1", { enabled: true, unsupportedReason: undefined, profile: { _tag: "None" } }],
    ]);
    fake.state.connected.add("env-1");
    fake.command.mockResolvedValue({ _tag: "Failure", error: { _tag: "PushRegistrationError" } });

    await enableUnifiedPush();
    await settle();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fake.command).toHaveBeenCalledTimes(1);
    expect(getPushEnvironments().map(({ failure }) => failure)).toEqual(["rejected"]);
  });

  it("waits for the connection instead of asking an environment that is not connected", async () => {
    fake.state.catalog = new Map([
      ["env-1", { enabled: true, unsupportedReason: undefined, profile: { _tag: "None" } }],
    ]);

    await enableUnifiedPush();
    await settle();
    expect(fake.command).not.toHaveBeenCalled();
    expect(getPushEnvironments().map(({ state, failure }) => [state, failure])).toEqual([
      ["waiting", undefined],
    ]);

    fake.setConnected("env-1", true);
    await settle();
    expect(fake.command).toHaveBeenCalledTimes(1);
    expect(getPushEnvironments().map(({ state }) => state)).toEqual(["registered"]);
  });

  it("does not report a dropped connection as a permission problem, and registers on reconnect", async () => {
    fake.state.catalog = new Map([
      ["env-1", { enabled: true, unsupportedReason: undefined, profile: { _tag: "None" } }],
    ]);
    fake.state.connected.add("env-1");
    // The connection drops while the request waits for the session's grants.
    fake.command
      .mockImplementationOnce(async () => {
        fake.setConnected("env-1", false);
        return { _tag: "Failure", error: { _tag: "EnvironmentAuthorizationError" } };
      })
      .mockResolvedValue({ _tag: "Success", value: { lastDelivery: null } });

    await enableUnifiedPush();
    await settle();
    expect(getPushEnvironments().map(({ state, failure }) => [state, failure])).toEqual([
      ["waiting", undefined],
    ]);

    // No timer is needed: the next session registers it.
    fake.setConnected("env-1", true);
    await settle();
    expect(getPushEnvironments().map(({ state }) => state)).toEqual(["registered"]);
  });
});
