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

function harness(options: { tickets?: Array<{ ticket: string; lifetimeMs: number } | null> } = {}) {
  let clock = 1_000_000;
  const calls: string[] = [];
  const registrations: Array<GatewayRegistration | null> = [];
  const delivered: string[] = [];
  const timers: Array<{ run: () => void; delayMs: number; cancelled: boolean }> = [];
  const tickets = options.tickets ?? [];
  let issued = 0;
  const bridge: Pick<
    LoopbackGatewayBridge,
    "register" | "updateTicket" | "unregister" | "setReachable"
  > = {
    register: async (input) => {
      calls.push(`register ${input.httpBaseUrl} enabled=${input.enabled}`);
      return { state: "pending" };
    },
    updateTicket: async (input) => {
      calls.push(`updateTicket ${input.credential.ticket}`);
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
      const scripted = tickets[issued];
      issued += 1;
      const next =
        scripted === undefined ? { ticket: `ticket-${issued}`, lifetimeMs: 5 * MINUTE } : scripted;
      return next === null
        ? null
        : { ticket: next.ticket, expiresAt: new Date(clock + next.lifetimeMs) };
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

  it("does not fetch again within the minimum interval", async () => {
    const h = harness();
    h.controller.sync(ENV, TARGET);
    await h.controller.idle();
    h.advance(MIN_TICKET_INTERVAL_MS - 1);
    h.controller.ticketNeeded(ENV);
    await h.controller.idle();
    expect(h.calls.filter((call) => call === "issue")).toHaveLength(1);
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
