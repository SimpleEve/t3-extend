// fork: keeps the desktop main process's gateway in step with what the app knows about each remote
// environment (research/remote-loopback-forwarding.md 4.2, 10): registers it, fetches and renews its
// ticket, and tells it when the environment goes away or comes back. No React and no atoms: the
// manager feeds it targets, so the whole thing runs against a fake bridge in a test.
import type { LoopbackGatewayBridge } from "@t3tools/shared/forkLoopbackGateway/bridge";

import type { GatewayRegistration } from "./gatewayStore";
import { MAX_TIMER_MS, localTicketExpiry, planTicketRenewal } from "./ticketRenewal";

/** A ticket is fetched at most this often, whoever asks: the main process's ask is every 2 seconds. */
export const MIN_TICKET_INTERVAL_MS = 3_000;
/** After a failed fetch nobody asks again for this long. */
export const TICKET_FAILURE_COOLDOWN_MS = 10_000;

export interface GatewayTarget {
  /** The route in use; a different one is a different ticket. */
  readonly httpBaseUrl: string;
  /** `false` when the user stopped forwarding for this environment. */
  readonly enabled: boolean;
  /** The app is connected to the environment. */
  readonly reachable: boolean;
}

export interface GatewayControllerDeps {
  readonly bridge: Pick<
    LoopbackGatewayBridge,
    "register" | "updateTicket" | "unregister" | "setReachable"
  >;
  /** `null` when no ticket could be had. The ticket is a secret: it goes to the bridge and nowhere else. */
  readonly issueTicket: (
    environmentId: string,
  ) => Promise<{ readonly ticket: string; readonly expiresAt: Date } | null>;
  readonly now: () => number;
  /** Runs `run` once after `delayMs`; returns the function that cancels it. */
  readonly schedule: (run: () => void, delayMs: number) => () => void;
  readonly onRegistration: (environmentId: string, value: GatewayRegistration | null) => void;
  readonly onTicketDelivered: (environmentId: string) => void;
}

interface Entry {
  target: GatewayTarget;
  removed: boolean;
  registered: boolean;
  /** The last registration did not go through, and nothing has tried again. */
  registrationFailed: boolean;
  /** Registered again because the main process had lost it, and no ticket has been accepted since. */
  reregistered: boolean;
  /** Bumped when the route changes; a ticket fetched before that is not delivered. */
  routeGeneration: number;
  ticketQueued: boolean;
  lastAttemptAt: number;
  lastFailureAt: number;
  /** When this computer received the current ticket, and when it stops being good, both on its clock. */
  receivedAt: number;
  expiresAt: number | null;
  cancelRenewal: (() => void) | null;
  /** Bridge calls for one environment run one after another, in the order they were made. */
  chain: Promise<void>;
}

export interface GatewayController {
  /** Applies what is now true of an environment; `null` when it should not be forwarded at all. */
  readonly sync: (environmentId: string, target: GatewayTarget | null) => void;
  /** The main process asked for a ticket. */
  readonly ticketNeeded: (environmentId: string) => void;
  /** Tries again to register an environment whose registration failed. */
  readonly retry: (environmentId: string) => void;
  readonly dispose: () => void;
  /** Resolves when every bridge call made so far has finished. */
  readonly idle: () => Promise<void>;
}

export const makeGatewayController = (deps: GatewayControllerDeps): GatewayController => {
  const entries = new Map<string, Entry>();
  const chains = new Set<Promise<void>>();

  const enqueue = (entry: Entry, work: () => Promise<void>): void => {
    const next = entry.chain.then(work).catch(() => undefined);
    entry.chain = next;
    chains.add(next);
    void next.then(() => chains.delete(next));
  };

  const fetchTicket = (environmentId: string, entry: Entry, force: boolean): void => {
    const { target } = entry;
    if (entry.removed || !target.enabled || !target.reachable || entry.ticketQueued) return;
    const time = deps.now();
    const wait = Math.max(
      entry.lastFailureAt + TICKET_FAILURE_COOLDOWN_MS - time,
      force ? 0 : entry.lastAttemptAt + MIN_TICKET_INTERVAL_MS - time,
    );
    if (wait > 0) {
      // A fetch the throttle holds back is not dropped: it is asked for again when the window ends.
      armFetch(environmentId, entry, wait);
      return;
    }
    entry.ticketQueued = true;
    enqueue(entry, async () => {
      entry.ticketQueued = false;
      if (entry.removed || !entry.registered || !entry.target.enabled || !entry.target.reachable) {
        return;
      }
      const generation = entry.routeGeneration;
      entry.lastAttemptAt = deps.now();
      try {
        const issued = await deps.issueTicket(environmentId);
        if (issued === null) return failed(environmentId, entry);
        if (entry.removed || entry.routeGeneration !== generation) return;
        const receivedAt = deps.now();
        // The main process gets the expiry on this computer's clock, not the environment's: it only
        // uses it to time its own reminder, and the environment decides whether a ticket is good.
        const expiresAt = localTicketExpiry({
          receivedAt,
          serverExpiresAt: issued.expiresAt.getTime(),
        });
        const status = await deps.bridge.updateTicket({
          environmentId,
          credential: { ticket: issued.ticket, expiresAt: new Date(expiresAt).toISOString() },
        });
        if (entry.removed) return;
        if (status === null) return notRegistered(environmentId, entry);
        entry.reregistered = false;
        entry.receivedAt = receivedAt;
        entry.expiresAt = expiresAt;
      } catch {
        return failed(environmentId, entry);
      }
      deps.onTicketDelivered(environmentId);
      scheduleRenewal(environmentId, entry);
    });
  };

  /** One timer per environment: the next renewal, or the fetch the throttle is holding back. */
  const armFetch = (environmentId: string, entry: Entry, delayMs: number): void => {
    entry.cancelRenewal?.();
    entry.cancelRenewal = deps.schedule(
      () => {
        entry.cancelRenewal = null;
        fetchTicket(environmentId, entry, false);
      },
      Math.min(Math.ceil(delayMs), MAX_TIMER_MS),
    );
  };

  const failed = (environmentId: string, entry: Entry): void => {
    const time = deps.now();
    entry.lastFailureAt = time;
    // A ticket still in hand keeps being renewed until it runs out; with none, or an expired one,
    // the main process asks when a request needs it.
    if (entry.expiresAt !== null && time + TICKET_FAILURE_COOLDOWN_MS < entry.expiresAt) {
      armFetch(environmentId, entry, TICKET_FAILURE_COOLDOWN_MS);
    }
  };

  /**
   * The main process does not know this environment (`updateTicket` answered `null`), so another
   * ticket would not help: register it again. If a registration that just went through is not known
   * either, stop and let the user retry, rather than going round again.
   */
  const notRegistered = (environmentId: string, entry: Entry): void => {
    entry.registered = false;
    entry.expiresAt = null;
    entry.cancelRenewal?.();
    entry.cancelRenewal = null;
    if (entry.reregistered) {
      entry.registrationFailed = true;
      deps.onRegistration(environmentId, "failed");
      return;
    }
    entry.reregistered = true;
    deps.onRegistration(environmentId, "pending");
    register(environmentId, entry);
  };

  const scheduleRenewal = (environmentId: string, entry: Entry): void => {
    entry.cancelRenewal?.();
    entry.cancelRenewal = null;
    if (entry.removed || entry.expiresAt === null) return;
    const plan = planTicketRenewal({
      now: deps.now(),
      receivedAt: entry.receivedAt,
      expiresAt: entry.expiresAt,
    });
    if (plan.action === "renew-now") {
      fetchTicket(environmentId, entry, false);
      return;
    }
    // Planning again when the timer fires keeps a long wait, or a laptop's sleep, honest.
    entry.cancelRenewal = deps.schedule(() => {
      entry.cancelRenewal = null;
      scheduleRenewal(environmentId, entry);
    }, plan.delayMs);
  };

  const register = (environmentId: string, entry: Entry): void => {
    enqueue(entry, async () => {
      if (entry.removed) return;
      const { target } = entry;
      try {
        await deps.bridge.register({
          environmentId,
          httpBaseUrl: target.httpBaseUrl,
          enabled: target.enabled,
        });
        if (!target.reachable) await deps.bridge.setReachable({ environmentId, reachable: false });
      } catch {
        if (entry.removed) return;
        entry.registrationFailed = true;
        deps.onRegistration(environmentId, "failed");
        return;
      }
      if (entry.removed) return;
      entry.registered = true;
      entry.registrationFailed = false;
      deps.onRegistration(environmentId, "registered");
      fetchTicket(environmentId, entry, true);
    });
  };

  const remove = (environmentId: string, entry: Entry): void => {
    entry.removed = true;
    entry.cancelRenewal?.();
    entry.cancelRenewal = null;
    entries.delete(environmentId);
    deps.onRegistration(environmentId, null);
    enqueue(entry, async () => {
      if (entry.registered) await deps.bridge.unregister({ environmentId });
    });
  };

  return {
    sync: (environmentId, target) => {
      const entry = entries.get(environmentId);
      if (target === null) {
        if (entry !== undefined) remove(environmentId, entry);
        return;
      }
      if (entry === undefined) {
        const created: Entry = {
          target,
          removed: false,
          registered: false,
          registrationFailed: false,
          reregistered: false,
          routeGeneration: 0,
          ticketQueued: false,
          lastAttemptAt: Number.NEGATIVE_INFINITY,
          lastFailureAt: Number.NEGATIVE_INFINITY,
          receivedAt: 0,
          expiresAt: null,
          cancelRenewal: null,
          chain: Promise.resolve(),
        };
        entries.set(environmentId, created);
        deps.onRegistration(environmentId, "pending");
        register(environmentId, created);
        return;
      }
      const previous = entry.target;
      entry.target = target;
      if (previous.httpBaseUrl !== target.httpBaseUrl) {
        // The main process drops the old ticket; so does the timer that would have renewed it.
        entry.routeGeneration += 1;
        entry.expiresAt = null;
        entry.cancelRenewal?.();
        entry.cancelRenewal = null;
        register(environmentId, entry);
      } else if (previous.enabled !== target.enabled) {
        register(environmentId, entry);
      } else if (previous.reachable !== target.reachable) {
        enqueue(entry, async () => {
          if (entry.removed || !entry.registered) return;
          await deps.bridge.setReachable({ environmentId, reachable: target.reachable });
          if (target.reachable) fetchTicket(environmentId, entry, true);
        });
      }
    },
    ticketNeeded: (environmentId) => {
      const entry = entries.get(environmentId);
      if (entry !== undefined) fetchTicket(environmentId, entry, false);
    },
    retry: (environmentId) => {
      const entry = entries.get(environmentId);
      if (entry === undefined || !entry.registrationFailed) return;
      entry.registrationFailed = false;
      entry.reregistered = false;
      deps.onRegistration(environmentId, "pending");
      register(environmentId, entry);
    },
    dispose: () => {
      for (const [environmentId, entry] of entries) remove(environmentId, entry);
    },
    idle: async () => {
      while (chains.size > 0) await Promise.all(chains);
    },
  };
};
