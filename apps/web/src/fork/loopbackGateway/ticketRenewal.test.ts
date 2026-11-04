import { describe, expect, it } from "vite-plus/test";

import {
  MAX_TIMER_MS,
  localTicketExpiry,
  planTicketRenewal,
  type TicketRenewalPlan,
} from "./ticketRenewal";

const SECOND = 1_000;
const MINUTE = 60_000;

describe("local ticket expiry", () => {
  // Received at 1,000,000 on this computer's clock; the server's expiry is on its own clock.
  const receivedAt = 1_000_000;
  const rows: ReadonlyArray<readonly [string, number, number]> = [
    ["a normal five-minute ticket", receivedAt + 5 * MINUTE, receivedAt + 5 * MINUTE],
    ["a shorter ticket counts as it is", receivedAt + MINUTE, receivedAt + MINUTE],
    ["less than 30 seconds counts as 30", receivedAt + 5 * SECOND, receivedAt + 30 * SECOND],
    ["longer than five minutes counts as five", receivedAt + 20 * MINUTE, receivedAt + 5 * MINUTE],
    [
      "server clock behind: already expired on arrival",
      receivedAt - 10 * MINUTE,
      receivedAt + 5 * MINUTE,
    ],
    ["expiry exactly at arrival", receivedAt, receivedAt + 5 * MINUTE],
    ["server clock ahead by ten minutes", receivedAt + 15 * MINUTE, receivedAt + 5 * MINUTE],
  ];
  it.each(rows)("%s", (_name, serverExpiresAt, expected) => {
    expect(localTicketExpiry({ receivedAt, serverExpiresAt })).toBe(expected);
  });
});

describe("ticket renewal plan", () => {
  // A five-minute ticket received at time 0 renews with 40% left, which is 3 minutes in.
  const rows: ReadonlyArray<
    readonly [string, { now: number; receivedAt: number; expiresAt: number }, TicketRenewalPlan]
  > = [
    [
      "just received",
      { now: 0, receivedAt: 0, expiresAt: 5 * MINUTE },
      { action: "wait", delayMs: 3 * MINUTE },
    ],
    [
      "part way",
      { now: MINUTE, receivedAt: 0, expiresAt: 5 * MINUTE },
      { action: "wait", delayMs: 2 * MINUTE },
    ],
    [
      "exactly 40% left",
      { now: 3 * MINUTE, receivedAt: 0, expiresAt: 5 * MINUTE },
      { action: "renew-now" },
    ],
    [
      "less than 40% left",
      { now: 4 * MINUTE, receivedAt: 0, expiresAt: 5 * MINUTE },
      { action: "renew-now" },
    ],
    [
      "already expired",
      { now: 9 * MINUTE, receivedAt: 0, expiresAt: 5 * MINUTE },
      { action: "renew-now" },
    ],
    [
      "a thirty-second ticket",
      { now: 0, receivedAt: 0, expiresAt: 30 * SECOND },
      { action: "wait", delayMs: 18 * SECOND },
    ],
    [
      "a fraction of a millisecond rounds up",
      { now: 0, receivedAt: 0, expiresAt: 3 },
      { action: "wait", delayMs: 2 },
    ],
  ];
  it.each(rows)("%s", (_name, input, expected) => {
    expect(planTicketRenewal(input)).toEqual(expected);
  });

  it("never asks for a timer the platform cannot set", () => {
    const year = 365 * 24 * 60 * MINUTE;
    expect(planTicketRenewal({ now: 0, receivedAt: 0, expiresAt: year })).toEqual({
      action: "wait",
      delayMs: MAX_TIMER_MS,
    });
  });
});
