// fork: when to fetch the next gateway ticket (research/remote-loopback-forwarding.md 4.2). The
// desktop main process asks too, within a minute of expiry; this is the early, quiet renewal.

/** Renew once this fraction of the ticket's lifetime is left. */
const TICKET_RENEW_REMAINING_FRACTION = 0.4;
/** The longest delay `setTimeout` accepts; a longer wait is planned again when it elapses. */
export const MAX_TIMER_MS = 2 ** 31 - 1;

export type TicketRenewalPlan =
  | { readonly action: "renew-now" }
  | { readonly action: "wait"; readonly delayMs: number };

export const planTicketRenewal = (input: {
  readonly now: number;
  /** When this computer received the ticket; its clock, not the server's. */
  readonly issuedAt: number;
  readonly expiresAt: number;
}): TicketRenewalPlan => {
  const lifetime = input.expiresAt - input.issuedAt;
  if (lifetime <= 0) return { action: "renew-now" };
  const renewAt = input.expiresAt - lifetime * TICKET_RENEW_REMAINING_FRACTION;
  const wait = renewAt - input.now;
  return wait <= 0
    ? { action: "renew-now" }
    : { action: "wait", delayMs: Math.min(Math.ceil(wait), MAX_TIMER_MS) };
};
