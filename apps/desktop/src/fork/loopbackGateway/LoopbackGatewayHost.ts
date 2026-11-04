// fork: the Electron side of the gateway: which environments have a proxy, which browser sessions
// belong to which environment, and what each of those sessions is told to do
// (research/remote-loopback-forwarding.md 2.3, 4.7, 7.2, 10). Electron objects arrive as
// arguments, so the whole thing runs under test with fake sessions.
import type {
  LoopbackGatewayCredential,
  LoopbackGatewayEvent,
  LoopbackGatewayStatus,
} from "@t3tools/shared/forkLoopbackGateway/bridge";
import { isLoopbackGatewayHost } from "@t3tools/shared/forkLoopbackGateway/hosts";
import {
  LoopbackGatewayErrorCode,
  parseLoopbackGatewayPort,
} from "@t3tools/shared/forkLoopbackGateway/protocol";
import * as Schema from "effect/Schema";
import type * as Electron from "electron";

import {
  makeGatewayEnvironment,
  type GatewayEnvironment,
  type GatewayEnvironmentOptions,
} from "./GatewayEnvironment.ts";
import { GATEWAY_ERROR_HEADER } from "./LoopbackProxy.ts";

/** Chromium's loopback is the only traffic that goes to the proxy; everything else stays direct. */
const proxyConfig = (port: number): Electron.ProxyConfig => ({
  mode: "fixed_servers",
  proxyRules: `http://127.0.0.1:${port}`,
  proxyBypassRules: "*;<-loopback>",
});

/** What a session had before it was pointed at a proxy: the app never sets another proxy mode. */
const RESTORED_PROXY_CONFIG: Electron.ProxyConfig = { mode: "system" };

const isGatewayErrorCode = Schema.is(LoopbackGatewayErrorCode);

export interface LoopbackGatewayHostOptions {
  readonly emit: (event: LoopbackGatewayEvent) => void;
  readonly renderErrorPage?: GatewayEnvironmentOptions["renderErrorPage"];
  readonly makeEnvironment?: typeof makeGatewayEnvironment;
}

export interface ProxyLogin {
  readonly isProxy: boolean;
  readonly host: string;
  readonly port: number;
  readonly session: Electron.Session | undefined;
}

export interface LoopbackGatewayHost {
  readonly register: (input: {
    readonly environmentId: string;
    readonly httpBaseUrl: string;
    readonly enabled: boolean;
    readonly credential?: LoopbackGatewayCredential;
  }) => Promise<LoopbackGatewayStatus>;
  /** The `null` results are for an environment that is not registered. */
  readonly updateTicket: (
    environmentId: string,
    credential: LoopbackGatewayCredential,
  ) => Promise<LoopbackGatewayStatus | null>;
  readonly unregister: (environmentId: string) => Promise<void>;
  readonly setEnabled: (
    environmentId: string,
    enabled: boolean,
  ) => Promise<LoopbackGatewayStatus | null>;
  readonly setReachable: (
    environmentId: string,
    reachable: boolean,
  ) => Promise<LoopbackGatewayStatus | null>;
  readonly getStatus: (environmentId: string) => LoopbackGatewayStatus | null;
  /**
   * Records `session` as one of the environment's browser sessions and, if the environment has a
   * proxy, points the session at it. Resolves before the first webview can attach to the session.
   */
  readonly installSession: (environmentId: string, session: Electron.Session) => Promise<void>;
  /** The answer to a proxy challenge, or `null` when it is not ours to answer (design 4.7). */
  readonly answerProxyLogin: (
    login: ProxyLogin,
  ) => { readonly username: string; readonly password: string } | null;
  readonly dispose: () => Promise<void>;
}

export const makeLoopbackGatewayHost = (
  options: LoopbackGatewayHostOptions,
): LoopbackGatewayHost => {
  const makeEnvironment = options.makeEnvironment ?? makeGatewayEnvironment;
  const environments = new Map<string, GatewayEnvironment>();
  const sessionsByEnvironment = new Map<string, Set<Electron.Session>>();
  const environmentBySession = new WeakMap<Electron.Session, string>();
  /** The proxy port each session is pointed at right now. */
  const proxiedPort = new WeakMap<Electron.Session, number>();

  /** A refused top-level navigation: the proxy's error page carries the code in a header. */
  const headerListener =
    (environmentId: string) =>
    (
      details: Electron.OnHeadersReceivedListenerDetails,
      callback: (response: Electron.HeadersReceivedResponse) => void,
    ): void => {
      callback({});
      if (details.resourceType !== "mainFrame") return;
      const headers = details.responseHeaders ?? {};
      const name = Object.keys(headers).find(
        (key) => key.toLowerCase() === GATEWAY_ERROR_HEADER.toLowerCase(),
      );
      const code = name === undefined ? undefined : headers[name]?.[0];
      if (code === undefined || !isGatewayErrorCode(code)) return;
      let url: URL;
      try {
        url = new URL(details.url);
      } catch {
        return;
      }
      // Only what the proxy answered counts: every loopback request in the session goes to it,
      // and a page from anywhere else can send any header it likes.
      const port = parseLoopbackGatewayPort(url.port === "" ? "80" : url.port);
      if (port === null || !isLoopbackGatewayHost(url.hostname)) return;
      options.emit({
        type: "denied",
        environmentId,
        code,
        port,
        mainFrame: true,
        url: details.url,
        ...(details.webContentsId === undefined ? {} : { webContentsId: details.webContentsId }),
      });
    };

  const applyToSession = async (
    environmentId: string,
    session: Electron.Session,
    port: number | null,
  ): Promise<void> => {
    const current = proxiedPort.get(session);
    if (port !== null) {
      if (current === port) return;
      await session.setProxy(proxyConfig(port));
      session.webRequest.onHeadersReceived(headerListener(environmentId));
      proxiedPort.set(session, port);
      // A connection made before the proxy was set must not be reused for a loopback request.
      if (current !== undefined) await session.closeAllConnections();
      return;
    }
    if (current === undefined) return;
    proxiedPort.delete(session);
    await session.setProxy(RESTORED_PROXY_CONFIG);
    session.webRequest.onHeadersReceived(null);
    await session.closeAllConnections();
  };

  const applyToEnvironment = (environmentId: string, port: number | null): Promise<void> =>
    Promise.all(
      [...(sessionsByEnvironment.get(environmentId) ?? [])].map((session) =>
        applyToSession(environmentId, session, port),
      ),
    ).then(() => undefined);

  const environmentFor = (environmentId: string): GatewayEnvironment | undefined =>
    environments.get(environmentId);

  return {
    register: async (input) => {
      let environment = environments.get(input.environmentId);
      if (environment === undefined) {
        environment = makeEnvironment({
          environmentId: input.environmentId,
          emit: options.emit,
          onProxyChange: (proxy) => applyToEnvironment(input.environmentId, proxy?.port ?? null),
          ...(options.renderErrorPage === undefined
            ? {}
            : { renderErrorPage: options.renderErrorPage }),
        });
        environments.set(input.environmentId, environment);
      }
      return environment.register({
        httpBaseUrl: input.httpBaseUrl,
        enabled: input.enabled,
        ...(input.credential === undefined ? {} : { credential: input.credential }),
      });
    },
    updateTicket: async (environmentId, credential) => {
      const environment = environmentFor(environmentId);
      return environment?.updateTicket(credential) ?? null;
    },
    unregister: async (environmentId) => {
      const environment = environments.get(environmentId);
      environments.delete(environmentId);
      await environment?.close();
    },
    setEnabled: async (environmentId, enabled) => {
      const environment = environmentFor(environmentId);
      return environment?.setEnabled(enabled) ?? null;
    },
    setReachable: async (environmentId, reachable) => {
      const environment = environmentFor(environmentId);
      return environment?.setReachable(reachable) ?? null;
    },
    getStatus: (environmentId) => environmentFor(environmentId)?.status() ?? null,
    installSession: async (environmentId, session) => {
      let sessions = sessionsByEnvironment.get(environmentId);
      if (sessions === undefined) {
        sessions = new Set();
        sessionsByEnvironment.set(environmentId, sessions);
      }
      sessions.add(session);
      environmentBySession.set(session, environmentId);
      await applyToSession(
        environmentId,
        session,
        environmentFor(environmentId)?.proxyPort() ?? null,
      );
    },
    answerProxyLogin: ({ isProxy, host, port, session }) => {
      if (!isProxy || host !== "127.0.0.1" || session === undefined) return null;
      const environmentId = environmentBySession.get(session);
      const credentials =
        environmentId === undefined ? null : environmentFor(environmentId)?.proxyCredentials();
      if (credentials === null || credentials === undefined || credentials.port !== port) {
        return null;
      }
      return { username: credentials.username, password: credentials.password };
    },
    dispose: async () => {
      const all = [...environments.values()];
      environments.clear();
      await Promise.all(all.map((environment) => environment.close()));
    },
  };
};

/**
 * The `app.on("login")` listener. It answers a challenge only when the host answers it, and says
 * nothing otherwise: no `preventDefault`, no callback, so the system proxy, other listeners and
 * page authentication prompts behave as if it were not here.
 */
export const makeProxyLoginListener =
  (host: Pick<LoopbackGatewayHost, "answerProxyLogin">) =>
  (
    event: { readonly preventDefault: () => void },
    webContents: { readonly session: Electron.Session } | null | undefined,
    authInfo: Pick<Electron.AuthInfo, "isProxy" | "host" | "port">,
    callback: (username?: string, password?: string) => void,
  ): void => {
    const credentials = host.answerProxyLogin({
      isProxy: authInfo.isProxy,
      host: authInfo.host,
      port: authInfo.port,
      session: webContents?.session,
    });
    if (credentials === null) return;
    event.preventDefault();
    callback(credentials.username, credentials.password);
  };
