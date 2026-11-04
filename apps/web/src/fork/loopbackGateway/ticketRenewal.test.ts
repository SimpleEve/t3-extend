import { describe, expect, it } from "vite-plus/test";

import { MAX_TIMER_MS, planTicketRenewal, type TicketRenewalPlan } from "./ticketRenewal";

const MINUTE = 60_000;

describe("ticket renewal plan", () => {
  // A five-minute ticket handed over at time 0 renews with 40% left, which is 3 minutes in.
  const rows: ReadonlyArray<
    readonly [string, { now: number; issuedAt: number; expiresAt: number }, TicketRenewalPlan]
  > = [
    [
      "just issued",
      { now: 0, issuedAt: 0, expiresAt: 5 * MINUTE },
      { action: "wait", delayMs: 3 * MINUTE },
    ],
    [
      "part way",
      { now: MINUTE, issuedAt: 0, expiresAt: 5 * MINUTE },
      { action: "wait", delayMs: 2 * MINUTE },
    ],
    [
      "exactly 40% left",
      { now: 3 * MINUTE, issuedAt: 0, expiresAt: 5 * MINUTE },
      { action: "renew-now" },
    ],
    [
      "less than 40% left",
      { now: 4 * MINUTE, issuedAt: 0, expiresAt: 5 * MINUTE },
      { action: "renew-now" },
    ],
    [
      "already expired",
      { now: 9 * MINUTE, issuedAt: 0, expiresAt: 5 * MINUTE },
      { action: "renew-now" },
    ],
    ["expiry not after issue", { now: 0, issuedAt: 0, expiresAt: 0 }, { action: "renew-now" }],
    [
      "a longer ticket scales",
      { now: 0, issuedAt: 0, expiresAt: 10 * MINUTE },
      { action: "wait", delayMs: 6 * MINUTE },
    ],
    [
      "a fraction of a millisecond rounds up",
      { now: 0, issuedAt: 0, expiresAt: 3 },
      { action: "wait", delayMs: 2 },
    ],
  ];
  it.each(rows)("%s", (_name, input, expected) => {
    expect(planTicketRenewal(input)).toEqual(expected);
  });

  it("never asks for a timer the platform cannot set", () => {
    const year = 365 * 24 * 60 * MINUTE;
    expect(planTicketRenewal({ now: 0, issuedAt: 0, expiresAt: year })).toEqual({
      action: "wait",
      delayMs: MAX_TIMER_MS,
    });
  });
});
