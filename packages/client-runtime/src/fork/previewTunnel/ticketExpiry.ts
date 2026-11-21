// fork: when a preview tunnel ticket stops being good, on this device's clock. The environment
// states its expiry on its own clock, which may be minutes off: read as-is, a slow device keeps
// using an expired ticket and every tunnel fails, and a fast one mints a ticket per connection.

/** The server's default WebSocket ticket lifetime (`DEFAULT_WEBSOCKET_TOKEN_TTL`, 5 minutes). */
const NOMINAL_TICKET_LIFETIME_MS = 5 * 60_000;
const MIN_TICKET_LIFETIME_MS = 30_000;

/**
 * A fresh ticket cannot already have expired, so a server expiry at or before `receivedAt` means
 * the clocks differ and the nominal lifetime applies; otherwise the server's lifetime counts, from
 * 30 seconds to 5 minutes.
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
