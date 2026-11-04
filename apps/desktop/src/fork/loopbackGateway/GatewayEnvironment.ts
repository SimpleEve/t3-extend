// @effect-diagnostics nodeBuiltinImport:off -- Owns a local proxy server and the secret that guards it.
// @effect-diagnostics globalTimers:off -- The ticket-renewal reminder is a one-shot timer outside any Effect fiber.
// @effect-diagnostics globalDate:off -- Ticket expiry is compared with the wall clock at a native boundary.
// fork: everything the main process keeps for one remote environment: where its gateway is, the
// ticket for it, whether the user turned forwarding off, and the proxy that serves Chromium while
// all of that allows it (research/remote-loopback-forwarding.md 2.3, 3.6, 4.2, 4.7, 10).
import * as NodeCrypto from "node:crypto";
import type * as NodeStream from "node:stream";

import type {
  LoopbackGatewayCredential,
  LoopbackGatewayEvent,
  LoopbackGatewayStatus,
} from "@t3tools/shared/forkLoopbackGateway/bridge";
import {
  formatLoopbackGatewayAuthorization,
  parseLoopbackGatewayAuthorization,
  type LoopbackGatewayErrorCode,
} from "@t3tools/shared/forkLoopbackGateway/protocol";
import { checkLoopbackGatewayTransport } from "@t3tools/shared/forkLoopbackGateway/transport";
import * as DateTime from "effect/DateTime";
import * as Redacted from "effect/Redacted";

import { PROXY_USERNAME, startLoopbackProxy, type LoopbackProxy } from "./LoopbackProxy.ts";
import { openLoopbackTunnel, type OpenLoopbackTunnelInput } from "./TunnelClient.ts";
import { GatewayTunnelError } from "./tunnelErrors.ts";

/** A ticket this close to expiry is renewed (design 4.2). */
const RENEW_BEFORE_EXPIRY_MS = 60_000;
/** Longest single timer: `setTimeout` overflows beyond 2^31 - 1 milliseconds. */
const MAX_TIMER_MS = 2 ** 31 - 1;
/** A request that finds no usable ticket asks for one at most this often. */
const TICKET_REQUEST_INTERVAL_MS = 2_000;

/** Failures that say something about the whole environment, not about one port. */
const ENVIRONMENT_REJECTIONS: ReadonlySet<LoopbackGatewayErrorCode> = new Set([
  "unauthorized",
  "forbidden",
  "tls-untrusted",
  "unexpected-redirect",
  "unsupported-server",
  "discovery-disabled",
]);

export class GatewayInvalidTicketError extends Error {
  override readonly name = "GatewayInvalidTicketError";

  constructor() {
    super("The loopback gateway ticket has an unexpected shape.");
  }
}

export interface GatewayEnvironmentOptions {
  readonly environmentId: string;
  readonly emit: (event: LoopbackGatewayEvent) => void;
  /**
   * Moves every browser session of the environment to `proxy` (`null`: back to normal
   * networking), before the call that caused it returns. It is idempotent, and rejects when any
   * session could not be moved; the environment then reports `internal` and calls it again before
   * its next operation, until it succeeds.
   */
  readonly onProxyChange: (proxy: { readonly port: number } | null) => Promise<void>;
  readonly openTunnel?: (input: OpenLoopbackTunnelInput) => Promise<NodeStream.Duplex>;
  readonly renderErrorPage?: (input: { code: LoopbackGatewayErrorCode; port: number }) => string;
  readonly now?: () => number;
  /** Runs `callback` once after `milliseconds`; returns the function that cancels it. */
  readonly schedule?: (callback: () => void, milliseconds: number) => () => void;
}

export interface RegisterGatewayEnvironment {
  readonly httpBaseUrl: string;
  readonly enabled: boolean;
  readonly credential?: LoopbackGatewayCredential;
}

export interface GatewayEnvironment {
  readonly environmentId: string;
  readonly register: (input: RegisterGatewayEnvironment) => Promise<LoopbackGatewayStatus>;
  readonly updateTicket: (credential: LoopbackGatewayCredential) => Promise<LoopbackGatewayStatus>;
  readonly setEnabled: (enabled: boolean) => Promise<LoopbackGatewayStatus>;
  readonly setReachable: (reachable: boolean) => Promise<LoopbackGatewayStatus>;
  /** Moves all sessions to the state the environment wants now (a new session was added). */
  readonly syncSessions: () => Promise<LoopbackGatewayStatus>;
  readonly status: () => LoopbackGatewayStatus;
  readonly proxyPort: () => number | null;
  /** The answer to Chromium's proxy challenge; only for `app.on("login")`. */
  readonly proxyCredentials: () => {
    readonly username: string;
    readonly password: string;
    readonly port: number;
  } | null;
  readonly close: () => Promise<void>;
}

interface Failure {
  readonly code: LoopbackGatewayErrorCode;
}

const defaultSchedule = (callback: () => void, milliseconds: number): (() => void) => {
  const timer = setTimeout(callback, milliseconds);
  timer.unref();
  return () => clearTimeout(timer);
};

export const makeGatewayEnvironment = (options: GatewayEnvironmentOptions): GatewayEnvironment => {
  const now = options.now ?? Date.now;
  const schedule = options.schedule ?? defaultSchedule;
  const openTunnel = options.openTunnel ?? openLoopbackTunnel;
  const { environmentId } = options;

  let baseUrl: string | undefined;
  let enabled = true;
  let reachable = true;
  let credential: LoopbackGatewayCredential | undefined;
  let failure: Failure | undefined;
  let proxy: LoopbackProxy | undefined;
  let password: string | undefined;
  let cancelRenewal: (() => void) | undefined;
  let lastTicketRequest = Number.NEGATIVE_INFINITY;
  let lastStatus = "";
  let closed = false;
  /** False after `onProxyChange` failed, until a later call succeeds. */
  let sessionsInSync = true;
  // Changes are applied one at a time, so a proxy is never started twice or stopped while starting.
  let queue: Promise<unknown> = Promise.resolve();
  const serialized = <T>(work: () => Promise<T>): Promise<T> => {
    const result = queue.then(work, work);
    queue = result.catch(() => undefined);
    return result;
  };

  const transport = () =>
    baseUrl === undefined
      ? ({ ok: false, reason: "invalid-url" } as const)
      : checkLoopbackGatewayTransport(baseUrl);

  const computeStatus = (): LoopbackGatewayStatus => {
    if (!sessionsInSync) return { state: "rejected", code: "internal" };
    if (!enabled) return { state: "disabled-by-user" };
    const route = transport();
    if (!route.ok) {
      return {
        state: "unsupported-route",
        code: route.reason === "invalid-url" ? "unsupported-route" : "insecure-transport",
        ...(route.hint === undefined ? {} : { hint: route.hint }),
      };
    }
    if (!reachable) return { state: "offline" };
    if (credential === undefined) return { state: "pending" };
    if (failure === undefined) return { state: "active" };
    return failure.code === "offline"
      ? { state: "offline", code: "offline" }
      : { state: "rejected", code: failure.code };
  };

  const publishStatus = (): LoopbackGatewayStatus => {
    const status = computeStatus();
    const serial = JSON.stringify(status);
    if (serial !== lastStatus) {
      lastStatus = serial;
      options.emit({ type: "status", environmentId, status });
    }
    return status;
  };

  const requestTicket = (): void => {
    const time = now();
    if (time - lastTicketRequest < TICKET_REQUEST_INTERVAL_MS) return;
    lastTicketRequest = time;
    options.emit({ type: "ticket-needed", environmentId });
  };

  const scheduleRenewal = (): void => {
    cancelRenewal?.();
    cancelRenewal = undefined;
    if (credential === undefined) return;
    const wait = DateTime.toEpochMillis(credential.expiresAt) - now() - RENEW_BEFORE_EXPIRY_MS;
    if (wait <= 0) {
      requestTicket();
      return;
    }
    // Deciding again when the timer fires keeps a distant expiry from overflowing the timer.
    cancelRenewal = schedule(scheduleRenewal, Math.min(wait, MAX_TIMER_MS));
  };

  const wantsProxy = (): boolean => enabled && transport().ok;

  const applySessions = async (): Promise<void> => {
    try {
      await options.onProxyChange(proxy === undefined ? null : { port: proxy.port });
      sessionsInSync = true;
    } catch {
      sessionsInSync = false;
    }
  };

  const converge = async (): Promise<void> => {
    if (!sessionsInSync) await applySessions();
  };

  const startProxy = async (): Promise<void> => {
    const secret = NodeCrypto.randomBytes(32).toString("hex");
    const started = await startLoopbackProxy({
      password: secret,
      openTunnel: openTunnelForPort,
      onDenied: (denial) => {
        if (denial.via === "connect") {
          options.emit({
            type: "denied",
            environmentId,
            code: denial.code,
            port: denial.port,
            mainFrame: false,
          });
        }
      },
      ...(options.renderErrorPage === undefined
        ? {}
        : { renderErrorPage: options.renderErrorPage }),
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    proxy = started;
    password = secret;
    await applySessions();
  };

  const stopProxy = async (): Promise<void> => {
    const stopping = proxy;
    proxy = undefined;
    password = undefined;
    // Sessions go back to normal networking before the proxy goes, so nothing is left aimed at it.
    // One that cannot be moved keeps pointing at a proxy that no longer listens: its loopback
    // requests fail, and the next operation tries again.
    await applySessions();
    await stopping?.close();
  };

  const reconcile = async (): Promise<LoopbackGatewayStatus> => {
    if (closed) return computeStatus();
    if (wantsProxy() && proxy === undefined) await startProxy();
    else if (!wantsProxy() && proxy !== undefined) await stopProxy();
    return publishStatus();
  };

  const openTunnelForPort = async (port: number): Promise<NodeStream.Duplex> => {
    if (baseUrl === undefined || !wantsProxy()) throw new GatewayTunnelError("unsupported-route");
    if (!reachable) throw new GatewayTunnelError("offline");
    const current = credential;
    if (current === undefined) {
      requestTicket();
      throw new GatewayTunnelError("unauthorized");
    }
    try {
      const tunnel = await openTunnel({ baseUrl, ticket: current.ticket, port });
      // The ticket this tunnel used is still the one in force: the environment accepted it.
      if (failure !== undefined && credential === current) {
        failure = undefined;
        publishStatus();
      }
      return tunnel;
    } catch (error) {
      if (error instanceof GatewayTunnelError && credential === current) {
        if (ENVIRONMENT_REJECTIONS.has(error.code) || error.code === "offline") {
          failure = { code: error.code };
          publishStatus();
        }
        if (error.code === "unauthorized") requestTicket();
      }
      throw error;
    }
  };

  const setCredential = (next: LoopbackGatewayCredential | undefined): void => {
    if (next !== undefined) {
      const ticket = Redacted.value(next.ticket);
      if (parseLoopbackGatewayAuthorization(formatLoopbackGatewayAuthorization(ticket)) === null) {
        throw new GatewayInvalidTicketError();
      }
    }
    credential = next;
    failure = undefined;
    scheduleRenewal();
  };

  const dropTunnels = (): void => proxy?.closeTunnels();

  return {
    environmentId,
    register: (input) =>
      serialized(async () => {
        await converge();
        const routeChanged = baseUrl !== undefined && baseUrl !== input.httpBaseUrl;
        const enabledChanged = enabled !== input.enabled;
        // A ticket belongs to the route it was fetched over (design 3.6): a new route needs a new one.
        if (routeChanged) {
          dropTunnels();
          setCredential(undefined);
        }
        baseUrl = input.httpBaseUrl;
        enabled = input.enabled;
        if (input.credential !== undefined) setCredential(input.credential);
        else if (routeChanged || credential === undefined) setCredential(undefined);
        if (enabledChanged && !enabled) dropTunnels();
        const status = await reconcile();
        if (status.state === "pending") requestTicket();
        return status;
      }),
    updateTicket: (next) =>
      serialized(async () => {
        await converge();
        setCredential(next);
        return publishStatus();
      }),
    setEnabled: (value) =>
      serialized(async () => {
        await converge();
        enabled = value;
        if (!value) dropTunnels();
        const status = await reconcile();
        if (status.state === "pending") requestTicket();
        return status;
      }),
    setReachable: (value) =>
      serialized(async () => {
        await converge();
        reachable = value;
        if (value) failure = failure?.code === "offline" ? undefined : failure;
        return publishStatus();
      }),
    syncSessions: () =>
      serialized(async () => {
        if (!closed) await applySessions();
        return publishStatus();
      }),
    status: computeStatus,
    proxyPort: () => proxy?.port ?? null,
    proxyCredentials: () =>
      proxy === undefined || password === undefined
        ? null
        : { username: PROXY_USERNAME, password, port: proxy.port },
    close: () =>
      serialized(async () => {
        closed = true;
        cancelRenewal?.();
        if (proxy !== undefined) await stopProxy();
      }),
  };
};
