// fork: when to fetch the next gateway ticket (research/remote-loopback-forwarding.md 4.2). The
// desktop main process asks too, within a minute of expiry; this is the early, quiet renewal.
// Everything here is on this computer's clock: the environment's clock may be minutes off, and
// whether a ticket is still good is the environment's call, not ours.

/** Renew once this fraction of the ticket's lifetime is left. */
const TICKET_RENEW_REMAINING_FRACTION = 0.4;
/** The server's default WebSocket ticket lifetime (`DEFAULT_WEBSOCKET_TOKEN_TTL`, 5 minutes). */
const NOMINAL_TICKET_LIFETIME_MS = 5 * 60_000;
const MIN_TICKET_LIFETIME_MS = 30_000;
/** The longest delay `setTimeout` accepts; a longer wait is planned again when it elapses. */
export const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * When a ticket received at `receivedAt` stops being good, on this computer's clock. A fresh ticket
 * cannot already have expired, so a server expiry at or before `receivedAt` means the clocks differ
 * and the nominal lifetime applies; otherwise the server's lifetime counts, from 30 seconds to 5
 * minutes. This is also what the main process is told, so its own reminder is not thrown off.
 */
export const localTicketExpiry = (input: {
  readonly receivedAt: number;
  readonly serverExpiresAt: number;
}): number => {
  const raw = input.serverExpiresAt - input.receivedAt;
  const lifetime =
    raw <= 0
      ? NOMINAL_TICKET_LIFETIME_MS
      : Math.min(Math.max(raw, MIN_TICKET_LIFETIME_MS), NOMINAL_TICKET_LIFETIME_MS);
  return input.receivedAt + lifetime;
};

export type TicketRenewalPlan =
  | { readonly action: "renew-now" }
  | { readonly action: "wait"; readonly delayMs: number };

export const planTicketRenewal = (input: {
  readonly now: number;
  readonly receivedAt: number;
  /** `localTicketExpiry` of the same ticket. */
  readonly expiresAt: number;
}): TicketRenewalPlan => {
  const lifetime = input.expiresAt - input.receivedAt;
  const wait = input.expiresAt - lifetime * TICKET_RENEW_REMAINING_FRACTION - input.now;
  return wait <= 0
    ? { action: "renew-now" }
    : { action: "wait", delayMs: Math.min(Math.ceil(wait), MAX_TIMER_MS) };
};
