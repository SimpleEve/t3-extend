import { describe, expect, it } from "vite-plus/test";

import { localTicketExpiry } from "./ticketExpiry.ts";

const RECEIVED = 1_000_000;
const MINUTE = 60_000;

describe("localTicketExpiry", () => {
  it("counts the server's lifetime from when the ticket arrived here, at most 5 minutes", () => {
    expect(
      localTicketExpiry({ receivedAt: RECEIVED, serverExpiresAt: RECEIVED + 2 * MINUTE }),
    ).toBe(RECEIVED + 2 * MINUTE);
    // The environment's clock is ahead: its expiry looks far off here.
    expect(
      localTicketExpiry({ receivedAt: RECEIVED, serverExpiresAt: RECEIVED + 60 * MINUTE }),
    ).toBe(RECEIVED + 5 * MINUTE);
  });

  it("takes the nominal lifetime when the environment's clock is behind, and never below 30 s", () => {
    expect(
      localTicketExpiry({ receivedAt: RECEIVED, serverExpiresAt: RECEIVED - 10 * MINUTE }),
    ).toBe(RECEIVED + 5 * MINUTE);
    expect(localTicketExpiry({ receivedAt: RECEIVED, serverExpiresAt: RECEIVED + 1_000 })).toBe(
      RECEIVED + 30_000,
    );
  });
});
