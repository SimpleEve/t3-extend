import { it as effectIt } from "@effect/vitest";
import { INCOGNITO_BROWSER_PROFILE_ID } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as Electron from "electron";
import { describe, expect, vi } from "vite-plus/test";

import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as ElectronApp from "../../electron/ElectronApp.ts";
import { getDesktopUrl } from "../../electron/ElectronProtocol.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as IpcChannels from "../../ipc/channels.ts";
import * as DesktopIpc from "../../ipc/DesktopIpc.ts";
import * as PreviewIpc from "../../ipc/methods/preview.ts";
import * as PreviewManager from "../../preview/Manager.ts";
import {
  LOOPBACK_GATEWAY_GET_STATUS_CHANNEL,
  LOOPBACK_GATEWAY_REGISTER_CHANNEL,
} from "./channels.ts";
import { installLoopbackGatewayIpc } from "./loopbackGatewayIpc.ts";

vi.mock("electron", () => ({
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  session: { fromPartition: vi.fn() },
  webContents: { fromId: vi.fn(() => null) },
}));

interface FakeSession {
  readonly session: Electron.Session;
  readonly calls: Array<string>;
  gate: Promise<void> | undefined;
  failWith: Error | undefined;
}

const fakeSession = (): FakeSession => {
  const fake: FakeSession = {
    session: undefined as unknown as Electron.Session,
    calls: [],
    gate: undefined,
    failWith: undefined,
  };
  const session = {
    setProxy: async (config: Electron.ProxyConfig) => {
      await fake.gate;
      if (fake.failWith !== undefined) throw fake.failWith;
      fake.calls.push(`setProxy:${config.mode}`);
    },
    closeAllConnections: async () => {},
    webRequest: { onHeadersReceived: () => {} },
  } as unknown as Electron.Session;
  return Object.assign(fake, { session });
};

const getPreviewConfig = PreviewIpc.methods.find(
  (method) => method.channel === IpcChannels.PREVIEW_GET_CONFIG_CHANNEL,
)! as DesktopIpc.DesktopIpcMethod<unknown, PreviewManager.PreviewManager>;

/** Runs `body` with the gateway IPC installed, the way startup installs it, and a preview manager. */
const withGateway = <A>(
  sessions: Map<string, FakeSession>,
  body: (
    invoke: (channel: string, payload: unknown, sender?: "main" | "guest") => Promise<unknown>,
  ) => Effect.Effect<A>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const listeners = new Map<string, DesktopIpc.DesktopIpcHandleListener>();
      const ipc = DesktopIpc.make({
        removeHandler: vi.fn(),
        handle: (channel, listener) => {
          listeners.set(channel, listener);
        },
        removeAllListeners: vi.fn(),
        on: vi.fn(),
      });
      const mainFrame = { url: getDesktopUrl(true) };
      const mainWindow = {
        webContents: { id: 1, isDestroyed: () => false, mainFrame },
      } as unknown as Electron.BrowserWindow;

      yield* installLoopbackGatewayIpc().pipe(
        Effect.provideService(DesktopIpc.DesktopIpc, ipc),
        Effect.provideService(ElectronApp.ElectronApp, {
          on: () => Effect.void,
        } as unknown as ElectronApp.ElectronApp["Service"]),
        Effect.provideService(ElectronWindow.ElectronWindow, {
          main: Effect.succeedSome(mainWindow),
          sendAll: () => Effect.void,
        } as unknown as ElectronWindow.ElectronWindow["Service"]),
      );
      const manager = {
        getBrowserSession: (scope?: string) => {
          const fake = sessions.get(scope ?? "shared") ?? fakeSession();
          sessions.set(scope ?? "shared", fake);
          return Effect.succeed(fake.session);
        },
        getBrowserPartition: (scope?: string) => Effect.succeed(`persist:test-${scope}`),
      } as unknown as PreviewManager.PreviewManager["Service"];

      yield* ipc
        .handle(getPreviewConfig)
        .pipe(Effect.provideService(PreviewManager.PreviewManager, manager));

      const invoke = (channel: string, payload: unknown, sender: "main" | "guest" = "main") =>
        listeners.get(channel)!(
          (sender === "main"
            ? { sender: { id: 1 }, senderFrame: mainFrame }
            : { sender: { id: 2 }, senderFrame: { url: "https://evil.example/" } }) as never,
          payload,
        ) as Promise<unknown>;
      return yield* body(invoke).pipe(
        Effect.provideService(DesktopEnvironment.DesktopEnvironment, {
          isDevelopment: true,
        } as unknown as DesktopEnvironment.DesktopEnvironment["Service"]),
        Effect.provideService(PreviewManager.PreviewManager, manager),
      );
    }).pipe(
      Effect.provideService(DesktopEnvironment.DesktopEnvironment, {
        isDevelopment: true,
      } as unknown as DesktopEnvironment.DesktopEnvironment["Service"]),
    ),
  );

const register = {
  environmentId: "env-b",
  httpBaseUrl: "https://b.example.com",
  enabled: true,
  credential: { ticket: "ticket-body.signature", expiresAt: "2100-01-01T00:00:00.000Z" },
};

describe("getPreviewConfig hands sessions to the gateway", () => {
  effectIt.effect(
    "has the proxy set before it returns, for the default profile, a new profile and incognito",
    () => {
      const sessions = new Map<string, FakeSession>();
      return withGateway(sessions, (invoke) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => invoke(LOOPBACK_GATEWAY_REGISTER_CHANNEL, register));

          const profiles = [undefined, "work-profile", INCOGNITO_BROWSER_PROFILE_ID];
          const scopes = [
            "env-b",
            JSON.stringify(["env-b", "work-profile"]),
            JSON.stringify(["env-b", INCOGNITO_BROWSER_PROFILE_ID]),
          ];
          for (const [index, profileId] of profiles.entries()) {
            const gate = Promise.withResolvers<void>();
            const fake = fakeSession();
            fake.gate = gate.promise;
            sessions.set(scopes[index]!, fake);

            let returned = false;
            const pending = invoke(IpcChannels.PREVIEW_GET_CONFIG_CHANNEL, {
              environmentId: "env-b",
              ...(profileId === undefined ? {} : { profileId }),
            }).then((config) => {
              returned = true;
              return config;
            });
            yield* Effect.promise(() => Promise.resolve());
            expect(returned).toBe(false);
            gate.resolve();
            const config = (yield* Effect.promise(() => pending)) as { partition: string };
            expect(config.partition).toContain("persist:test-");
            expect(fake.calls).toEqual(["setProxy:fixed_servers"]);
          }
        }),
      );
    },
  );

  effectIt.effect("leaves the sessions of an environment that is not registered alone", () => {
    const sessions = new Map<string, FakeSession>();
    return withGateway(sessions, (invoke) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          invoke(IpcChannels.PREVIEW_GET_CONFIG_CHANNEL, { environmentId: "env-local" }),
        );
        expect(sessions.get("env-local")!.calls).toEqual([]);
      }),
    );
  });

  effectIt.effect(
    "fails instead of returning a webview configuration when the proxy cannot be set",
    () => {
      const sessions = new Map<string, FakeSession>();
      return withGateway(sessions, (invoke) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => invoke(LOOPBACK_GATEWAY_REGISTER_CHANNEL, register));
          const fake = fakeSession();
          fake.failWith = new Error("setProxy failed");
          sessions.set("env-b", fake);
          const outcome = yield* Effect.promise(() =>
            invoke(IpcChannels.PREVIEW_GET_CONFIG_CHANNEL, { environmentId: "env-b" }).then(
              () => "returned",
              () => "failed",
            ),
          );
          expect(outcome).toBe("failed");
        }),
      );
    },
  );

  effectIt.effect("answers the gateway IPC only to the main window's own top frame", () => {
    const sessions = new Map<string, FakeSession>();
    return withGateway(sessions, (invoke) =>
      Effect.gen(function* () {
        const outcome = yield* Effect.promise(() =>
          invoke(LOOPBACK_GATEWAY_REGISTER_CHANNEL, register, "guest").then(
            () => "answered",
            (error: Error) => String(error.message),
          ),
        );
        expect(outcome).toContain("only available to the app window");
        // Nothing was registered: the guest's call did not reach the host.
        const status = yield* Effect.promise(() =>
          invoke(LOOPBACK_GATEWAY_GET_STATUS_CHANNEL, { environmentId: "env-b" }),
        );
        expect(status).toBeNull();
      }),
    );
  });
});
