import type { LoopbackGatewayBridge } from "@t3tools/shared/forkLoopbackGateway/bridge";
import { describe, expect, it } from "vite-plus/test";

import {
  type GatewayTarget,
  MIN_TICKET_INTERVAL_MS,
  TICKET_FAILURE_COOLDOWN_MS,
  makeGatewayController,
} from "./gatewayController";
import type { GatewayRegistration } from "./gatewayStore";

const MINUTE = 60_000;
const ENV = "env-1";
const TARGET: GatewayTarget = {
  httpBaseUrl: "https://box.example.com",
  enabled: true,
  reachable: true,
};

function harness(
  options: {
    tickets?: Array<{ ticket: string; lifetimeMs: number } | null>;
    hold?: boolean;
    /** How far the environment's clock is ahead of this computer's. */
    skewMs?: number;
    /** The first this many `register` calls throw. */
    registerFailures?: number;
    /** The first this many `updateTicket` calls answer `null`: the main process does not know the environment. */
    unknownTicketAnswers?: number;
  } = {},
) {
  let clock = 1_000_000;
  const calls: string[] = [];
  const handedExpiries: number[] = [];
  const registrations: Array<GatewayRegistration | null> = [];
  const delivered: string[] = [];
  const timers: Array<{ run: () => void; delayMs: number; cancelled: boolean }> = [];
  const tickets = options.tickets ?? [];
  let issued = 0;
  let registerCalls = 0;
  let ticketCalls = 0;
  // The first fetch can be held open: `started` says it began, `release` lets it finish.
  let release = () => {};
  let started = () => {};
  const held = {
    started: new Promise<void>((resolve) => (started = resolve)),
    release: () => release(),
  };
  const bridge: Pick<
    LoopbackGatewayBridge,
    "register" | "updateTicket" | "unregister" | "setReachable"
  > = {
    register: async (input) => {
      calls.push(`register ${input.httpBaseUrl} enabled=${input.enabled}`);
      registerCalls += 1;
      if (registerCalls <= (options.registerFailures ?? 0)) throw new Error("ipc closed");
      return { state: "pending" };
    },
    updateTicket: async (input) => {
      calls.push(`updateTicket ${input.credential.ticket}`);
      handedExpiries.push(Date.parse(input.credential.expiresAt));
      ticketCalls += 1;
      if (ticketCalls <= (options.unknownTicketAnswers ?? 0)) return null;
      return { state: "active" };
    },
    unregister: async () => {
      calls.push("unregister");
    },
    setReachable: async (input) => {
      calls.push(`setReachable ${input.reachable}`);
      return { state: "pending" };
    },
  };
  const controller = makeGatewayController({
    bridge,
    issueTicket: async () => {
      calls.push("issue");
      if (options.hold === true && issued === 0) {
        started();
        await new Promise<void>((resolve) => (release = resolve));
      }
      const scripted = tickets[issued];
      issued += 1;
      const next =
        scripted === undefined ? { ticket: `ticket-${issued}`, lifetimeMs: 5 * MINUTE } : scripted;
      return next === null
        ? null
        : {
            ticket: next.ticket,
            expiresAt: new Date(clock + (options.skewMs ?? 0) + next.lifetimeMs),
          };
    },
    now: () => clock,
    schedule: (run, delayMs) => {
      const timer = { run, delayMs, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    onRegistration: (_id, value) => registrations.push(value),
    onTicketDelivered: (id) => delivered.push(id),
  });
  return {
    held,
    handedExpiries,
    now: () => clock,
    controller,
    calls,
    registrations,
    delivered,
    advance: (ms: number) => {
      clock += ms;
    },
    liveTimers: () => timers.filter((timer) => !timer.cancelled),
    fire: (timer: { run: () => void; cancelled: boolean }) => {
      timer.cancelled = true;
      timer.run();
    },
  };
}

describe("gateway controller", () => {
  it("registers, fetches a ticket, delivers it and plans the renewal at 40% left", async () => {
    const h = harness();
    h.controller.sync(ENV, TARGET);
    await h.controller.idle();
    expect(h.calls).toEqual([
      "register https://box.example.com enabled=true",
      "issue",
      "updateTicket ticket-1",
    ]);
    expect(h.registrations).toEqual(["pending", "registered"]);
    expect(h.delivered).toEqual([ENV]);
    expect(h.liveTimers().map((timer) => timer.delayMs)).toEqual([3 * MINUTE]);
  });

  it("renews when the timer fires, then plans the next one", async () => {
    const h = harness();
    h.controller.sync(ENV, TARGET);
    await h.controller.idle();
    h.advance(3 * MINUTE);
    h.fire(h.liveTimers()[0]!);
    await h.controller.idle();
    expect(h.calls.filter((call) => call === "issue")).toHaveLength(2);
    expect(h.liveTimers().map((timer) => timer.delayMs)).toEqual([3 * MINUTE]);
  });

  // The environment's clock is not this computer's. A ticket is good for five minutes from the
  // moment it arrives, whatever the two clocks say, so the renewal comes three minutes later.
  describe.each([
    ["this computer's clock 10 minutes ahead", -10 * MINUTE],
    ["this computer's clock 10 minutes behind", 10 * MINUTE],
  ])("with %s", (_name, skewMs) => {
    it("plans one renewal at three minutes and hands over an expiry on this computer's clock", async () => {
      const h = harness({ skewMs });
      const start = h.now();
      h.controller.sync(ENV, TARGET);
      await h.controller.idle();
      expect(h.calls.filter((call) => call === "issue")).toHaveLength(1);
      expect(h.liveTimers().map((timer) => timer.delayMs)).toEqual([3 * MINUTE]);
      expect(h.handedExpiries).toEqual([start + 5 * MINUTE]);
    });

    it("keeps renewing about every three minutes, not every few seconds", async () => {
      const h = harness({ skewMs });
      h.controller.sync(ENV, TARGET);
      await h.controller.idle();
      const end = h.now() + 30 * MINUTE;
      while (h.liveTimers().length > 0 && h.now() < end) {
        const [timer] = h.liveTimers();
        h.advance(timer!.delayMs);
        h.fire(timer!);
        await h.controller.idle();
      }
      const fetches = h.calls.filter((call) => call === "issue").length;
      expect(fetches).toBeGreaterThanOrEqual(9);
      expect(fetches).toBeLessThanOrEqual(11);
      expect(h.liveTimers()).toHaveLength(1);
    });
  });

  it("re-arms a renewal that failed, for when the failure cool-down ends, and then renews", async () => {
    const h = harness({ tickets: [{ ticket: "first", lifetimeMs: 5 * MINUTE }, null] });
    h.controller.sync(ENV, TARGET);
    await h.controller.idle();
    h.advance(3 * MINUTE);
    h.fire(h.liveTimers()[0]!);
    await h.controller.idle();
    expect(h.calls.filter((call) => call === "issue")).toHaveLength(2);
    // The failed renewal is not dropped: one timer waits out the cool-down.
    expect(h.liveTimers().map((timer) => timer.delayMs)).toEqual([TICKET_FAILURE_COOLDOWN_MS]);

    h.advance(TICKET_FAILURE_COOLDOWN_MS);
    h.fire(h.liveTimers()[0]!);
    await h.controller.idle();
    expect(h.calls.filter((call) => call === "issue")).toHaveLength(3);
    expect(h.calls.filter((call) => call.startsWith("updateTicket"))).toEqual([
      "updateTicket first",
      "updateTicket ticket-3",
    ]);
    expect(h.liveTimers().map((timer) => timer.delayMs)).toEqual([3 * MINUTE]);
  });

  it("stops retrying a renewal once the ticket it was renewing has expired", async () => {
    const h = harness({
      tickets: [
        { ticket: "first", lifetimeMs: 5 * MINUTE },
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
      ],
    });
    h.controller.sync(ENV, TARGET);
    await h.controller.idle();
    const expiry = h.now() + 5 * MINUTE;
    let guard = 0;
    while (h.liveTimers().length > 0 && guard++ < 100) {
      const [timer] = h.liveTimers();
      h.advance(timer!.delayMs);
      h.fire(timer!);
      await h.controller.idle();
    }
    expect(guard).toBeLessThan(100);
    expect(h.now()).toBeGreaterThanOrEqual(expiry - TICKET_FAILURE_COOLDOWN_MS);
    // Nothing keeps asking; a request that finds no ticket asks through `ticketNeeded`.
    expect(h.liveTimers()).toEqual([]);
  });

  it("answers ticket-needed with one fetch, however many ask", async () => {
    const h = harness();
    h.controller.sync(ENV, TARGET);
    await h.controller.idle();
    h.advance(MIN_TICKET_INTERVAL_MS);
    h.controller.ticketNeeded(ENV);
    h.controller.ticketNeeded(ENV);
    h.controller.ticketNeeded(ENV);
    await h.controller.idle();
    expect(h.calls.filter((call) => call === "issue")).toHaveLength(2);
  });

  it("holds a fetch back inside the minimum interval and makes it when the window ends", async () => {
    const h = harness();
    h.controller.sync(ENV, TARGET);
    await h.controller.idle();
    h.advance(MIN_TICKET_INTERVAL_MS - 1_000);
    h.controller.ticketNeeded(ENV);
    await h.controller.idle();
    expect(h.calls.filter((call) => call === "issue")).toHaveLength(1);
    // One timer, set for the end of the window, stands in for the renewal timer.
    expect(h.liveTimers().map((timer) => timer.delayMs)).toEqual([1_000]);

    h.advance(1_000);
    h.fire(h.liveTimers()[0]!);
    await h.controller.idle();
    expect(h.calls.filter((call) => call === "issue")).toHaveLength(2);
    expect(h.liveTimers().map((timer) => timer.delayMs)).toEqual([3 * MINUTE]);
  });

  it("leaves a failed fetch alone until the cool-down passes", async () => {
    const h = harness({ tickets: [null] });
    h.controller.sync(ENV, TARGET);
    await h.controller.idle();
    expect(h.delivered).toEqual([]);
    expect(h.liveTimers()).toEqual([]);
    h.advance(TICKET_FAILURE_COOLDOWN_MS - 1);
    h.controller.ticketNeeded(ENV);
    await h.controller.idle();
    expect(h.calls.filter((call) => call === "issue")).toHaveLength(1);
    h.advance(1);
    h.controller.ticketNeeded(ENV);
    await h.controller.idle();
    expect(h.calls.filter((call) => call === "issue")).toHaveLength(2);
    expect(h.delivered).toEqual([ENV]);
  });

  it("marks the environment unreachable and fetches a new ticket when it comes back", async () => {
    const h = harness();
    h.controller.sync(ENV, TARGET);
    await h.controller.idle();
    h.calls.length = 0;

    h.controller.sync(ENV, { ...TARGET, reachable: false });
    await h.controller.idle();
    h.controller.ticketNeeded(ENV);
    await h.controller.idle();
    expect(h.calls).toEqual(["setReachable false"]);

    h.controller.sync(ENV, TARGET);
    await h.controller.idle();
    expect(h.calls).toEqual([
      "setReachable false",
      "setReachable true",
      "issue",
      "updateTicket ticket-2",
    ]);
  });

  it("registers an environment that is not connected yet as unreachable, without asking for a ticket", async () => {
    const h = harness();
    h.controller.sync(ENV, { ...TARGET, reachable: false });
    await h.controller.idle();
    expect(h.calls).toEqual([
      "register https://box.example.com enabled=true",
      "setReachable false",
    ]);
  });

  it("registers again on a new route, and a ticket fetched over the old one is not delivered", async () => {
    const h = harness();
    h.controller.sync(ENV, TARGET);
    await h.controller.idle();
    h.calls.length = 0;

    h.controller.sync(ENV, { ...TARGET, httpBaseUrl: "https://other.example.com" });
    await h.controller.idle();
    expect(h.calls).toEqual([
      "register https://other.example.com enabled=true",
      "issue",
      "updateTicket ticket-2",
    ]);
    // The renewal planned for the old ticket was cancelled with it.
    expect(h.liveTimers()).toHaveLength(1);
  });

  it("drops a ticket fetched over a route that was replaced while it was on its way", async () => {
    const h = harness({ hold: true });
    h.controller.sync(ENV, TARGET);
    await h.held.started;
    h.controller.sync(ENV, { ...TARGET, httpBaseUrl: "https://other.example.com" });
    h.held.release();
    await h.controller.idle();
    expect(h.calls.filter((call) => call.startsWith("updateTicket"))).toEqual([
      "updateTicket ticket-2",
    ]);
    expect(h.calls.filter((call) => call.startsWith("register"))).toEqual([
      "register https://box.example.com enabled=true",
      "register https://other.example.com enabled=true",
    ]);
  });

  it("registers disabled and fetches nothing, then resumes with a ticket", async () => {
    const h = harness();
    h.controller.sync(ENV, { ...TARGET, enabled: false });
    await h.controller.idle();
    expect(h.calls).toEqual(["register https://box.example.com enabled=false"]);

    h.controller.sync(ENV, TARGET);
    await h.controller.idle();
    expect(h.calls.slice(1)).toEqual([
      "register https://box.example.com enabled=true",
      "issue",
      "updateTicket ticket-1",
    ]);
    // Registered with forwarding off is not registered for forwarding: a gate must not take it for that.
    expect(h.registrations).toEqual(["pending", "stopped", "registered"]);
  });

  it("unregisters when the environment should no longer be forwarded, and cancels the renewal", async () => {
    const h = harness();
    h.controller.sync(ENV, TARGET);
    await h.controller.idle();
    h.controller.sync(ENV, null);
    await h.controller.idle();
    expect(h.calls.at(-1)).toBe("unregister");
    expect(h.registrations.at(-1)).toBeNull();
    expect(h.liveTimers()).toEqual([]);
    h.controller.ticketNeeded(ENV);
    await h.controller.idle();
    expect(h.calls.filter((call) => call === "issue")).toHaveLength(1);
  });

  it("says nothing to the main process about an environment it never registered", async () => {
    const h = harness();
    h.controller.sync(ENV, null);
    await h.controller.idle();
    expect(h.calls).toEqual([]);
  });

  it("reports a failed registration instead of waiting for it forever", async () => {
    const h = harness();
    const failing = makeGatewayController({
      bridge: {
        register: async () => {
          throw new Error("ipc closed");
        },
        updateTicket: async () => null,
        unregister: async () => undefined,
        setReachable: async () => null,
      },
      issueTicket: async () => null,
      now: () => 0,
      schedule: () => () => undefined,
      onRegistration: (_id, value) => h.registrations.push(value),
      onTicketDelivered: () => undefined,
    });
    failing.sync(ENV, TARGET);
    await failing.idle();
    expect(h.registrations).toEqual(["pending", "failed"]);
  });

  it("registers again when the main process does not know the environment a ticket was meant for", async () => {
    const h = harness({ unknownTicketAnswers: 1 });
    h.controller.sync(ENV, TARGET);
    await h.controller.idle();
    expect(h.calls).toEqual([
      "register https://box.example.com enabled=true",
      "issue",
      "updateTicket ticket-1",
      "register https://box.example.com enabled=true",
      "issue",
      "updateTicket ticket-2",
    ]);
    // The gate closes for new tabs while the environment is unregistered, and opens again after.
    expect(h.registrations).toEqual(["pending", "registered", "pending", "registered"]);
    expect(h.delivered).toEqual([ENV]);
    expect(h.liveTimers().map((timer) => timer.delayMs)).toEqual([3 * MINUTE]);
  });

  it("gives up quietly, with the gate closed, when a fresh registration is not known either", async () => {
    const h = harness({ unknownTicketAnswers: 2 });
    h.controller.sync(ENV, TARGET);
    await h.controller.idle();
    expect(h.calls.filter((call) => call.startsWith("register"))).toHaveLength(2);
    expect(h.registrations.at(-1)).toBe("failed");
    expect(h.delivered).toEqual([]);
  });

  it("registers again on retry after a failed registration, then fetches the ticket", async () => {
    const h = harness({ registerFailures: 1 });
    h.controller.sync(ENV, TARGET);
    await h.controller.idle();
    expect(h.registrations).toEqual(["pending", "failed"]);
    h.controller.retry(ENV);
    await h.controller.idle();
    expect(h.registrations).toEqual(["pending", "failed", "pending", "registered"]);
    expect(h.calls.at(-1)).toBe("updateTicket ticket-1");
    // Nothing to retry once it is registered.
    h.controller.retry(ENV);
    await h.controller.idle();
    expect(h.calls.filter((call) => call.startsWith("register"))).toHaveLength(2);
  });

  it("unregisters every environment on dispose", async () => {
    const h = harness();
    h.controller.sync("a", TARGET);
    h.controller.sync("b", TARGET);
    await h.controller.idle();
    h.controller.dispose();
    await h.controller.idle();
    expect(h.calls.filter((call) => call === "unregister")).toHaveLength(2);
  });
});
