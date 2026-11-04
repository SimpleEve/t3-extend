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

/** A fixed message: what Electron said about the failure is of no use to the caller. */
class LoopbackGatewaySessionError extends Error {
  override readonly name = "LoopbackGatewaySessionError";

  constructor() {
    super("A browser session could not be switched to or from the loopback gateway proxy.");
  }
}

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

  /**
   * What each session has been moved to. A session is recorded only after every step succeeded;
   * `dirty` marks one that a step was started on, so a failure half way is finished by the next
   * call instead of being taken for done. Untouched sessions count as `null` (normal networking).
   */
  const settledPort = new WeakMap<Electron.Session, number | null>();
  const dirty = new WeakSet<Electron.Session>();
  const isSettledAt = (session: Electron.Session, port: number | null): boolean =>
    !dirty.has(session) && (settledPort.get(session) ?? null) === port;

  const applyToSession = async (
    environmentId: string,
    session: Electron.Session,
    port: number | null,
  ): Promise<void> => {
    if (isSettledAt(session, port)) return;
    dirty.add(session);
    if (port !== null) {
      await session.setProxy(proxyConfig(port));
      session.webRequest.onHeadersReceived(headerListener(environmentId));
    } else {
      await session.setProxy(RESTORED_PROXY_CONFIG);
      session.webRequest.onHeadersReceived(null);
    }
    // Connections made under the old setting must not carry a loopback request to the wrong place.
    await session.closeAllConnections();
    settledPort.set(session, port);
    dirty.delete(session);
  };

  const applyToEnvironment = async (environmentId: string, port: number | null): Promise<void> => {
    const results = await Promise.allSettled(
      [...(sessionsByEnvironment.get(environmentId) ?? [])].map((session) =>
        applyToSession(environmentId, session, port),
      ),
    );
    if (results.some((result) => result.status === "rejected")) {
      throw new LoopbackGatewaySessionError();
    }
  };

  const environmentFor = (environmentId: string): GatewayEnvironment | undefined =>
    environments.get(environmentId);

  /**
   * Operations on one environment id run one after another, in the order they were called, so an
   * unregister that is still restoring sessions cannot interleave with a register of the same id.
   * A failed operation does not hold up the next. Other ids do not wait for each other.
   */
  const tails = new Map<string, Promise<unknown>>();
  const exclusive = <T>(environmentId: string, work: () => Promise<T>): Promise<T> => {
    const result = (tails.get(environmentId) ?? Promise.resolve()).then(work, work);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    tails.set(environmentId, tail);
    void tail.then(() => {
      if (tails.get(environmentId) === tail) tails.delete(environmentId);
    });
    return result;
  };

  /** Back to normal networking for every session of the id; rejects if any could not be moved. */
  const restoreSessions = (environmentId: string): Promise<void> =>
    applyToEnvironment(environmentId, null);

  const unregisterNow = async (environmentId: string): Promise<void> => {
    const environment = environments.get(environmentId);
    environments.delete(environmentId);
    await environment?.close();
    // Also when the environment is already gone: a failed restore is retried by calling again.
    await restoreSessions(environmentId);
  };

  return {
    register: (input) =>
      exclusive(input.environmentId, async () => {
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
      }),
    updateTicket: (environmentId, credential) =>
      exclusive(
        environmentId,
        async () => environmentFor(environmentId)?.updateTicket(credential) ?? null,
      ),
    unregister: (environmentId) => exclusive(environmentId, () => unregisterNow(environmentId)),
    setEnabled: (environmentId, enabled) =>
      exclusive(
        environmentId,
        async () => environmentFor(environmentId)?.setEnabled(enabled) ?? null,
      ),
    setReachable: (environmentId, reachable) =>
      exclusive(
        environmentId,
        async () => environmentFor(environmentId)?.setReachable(reachable) ?? null,
      ),
    getStatus: (environmentId) => environmentFor(environmentId)?.status() ?? null,
    installSession: (environmentId, session) =>
      exclusive(environmentId, async () => {
        let sessions = sessionsByEnvironment.get(environmentId);
        if (sessions === undefined) {
          sessions = new Set();
          sessionsByEnvironment.set(environmentId, sessions);
        }
        sessions.add(session);
        environmentBySession.set(session, environmentId);
        const environment = environmentFor(environmentId);
        if (environment === undefined) {
          // Not registered (or unregistered and the restore failed): the session must be on normal
          // networking before a webview attaches. Untouched sessions need no call.
          await restoreSessions(environmentId).catch(() => undefined);
          if (!isSettledAt(session, null)) throw new LoopbackGatewaySessionError();
          return;
        }
        await environment.syncSessions();
        // Fail closed: a webview must not attach to a session that is not where it should be.
        if (!isSettledAt(session, environment.proxyPort())) throw new LoopbackGatewaySessionError();
      }),
    answerProxyLogin: ({ isProxy, host, port, session }) => {
      if (!isProxy || host !== "127.0.0.1") return null;
      const answer = (credentials: { username: string; password: string; port: number } | null) =>
        credentials === null || credentials.port !== port
          ? null
          : { username: credentials.username, password: credentials.password };
      if (session !== undefined) {
        const environmentId = environmentBySession.get(session);
        return environmentId === undefined
          ? null
          : answer(environmentFor(environmentId)?.proxyCredentials() ?? null);
      }
      // A request with no webContents (a service worker, `session.fetch`, a download) has no
      // session to look up. Each environment's proxy has a port of its own, which names it.
      for (const environment of environments.values()) {
        const credentials = answer(environment.proxyCredentials());
        if (credentials !== null) return credentials;
      }
      return null;
    },
    dispose: async () => {
      await Promise.allSettled(
        [...environments.keys()].map((id) => exclusive(id, () => unregisterNow(id))),
      );
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
