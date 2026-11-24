import { describe, expect, it } from "@effect/vitest";
import { ProviderDriverKind } from "@t3tools/contracts";

import {
  antigravityAccountLowest,
  antigravityAccountRows,
  formatAntigravityReset,
  maskAntigravityAccountEmail,
} from "./accounts.ts";

const antigravity = ProviderDriverKind.make("antigravity");
const accounts = [
  { id: "a", email: "a@example.com", current: true },
  { id: "b", current: false, exhaustedUntil: "2026-11-21T20:00:00.000Z" },
];

describe("Antigravity account rows", () => {
  it("lists a separate sign-in's accounts in order, with the position for an account without an email", () => {
    const rows = antigravityAccountRows({
      driver: antigravity,
      auth: { status: "authenticated", accounts },
    });
    expect(rows).toEqual([
      {
        id: "a",
        email: "a@example.com",
        current: true,
        exhaustedUntil: null,
        usageLimits: null,
        position: 1,
      },
      {
        id: "b",
        email: null,
        current: false,
        exhaustedUntil: "2026-11-21T20:00:00.000Z",
        usageLimits: null,
        position: 2,
      },
    ]);
  });

  it("lists nothing for other providers or an instance with no saved account", () => {
    expect(
      antigravityAccountRows({
        driver: ProviderDriverKind.make("codex"),
        auth: { status: "authenticated", accounts },
      }),
    ).toEqual([]);
    expect(
      antigravityAccountRows({ driver: antigravity, auth: { status: "authenticated" } }),
    ).toEqual([]);
  });

  it("formats a reset time and leaves text that is not a time alone", () => {
    expect(formatAntigravityReset("2026-11-21T20:00:00.000Z", "en")).toMatch(/Nov 2[12]/);
    expect(formatAntigravityReset("soon", "en")).toBe("soon");
  });

  it("masks the local part of an email and keeps the domain", () => {
    expect(maskAntigravityAccountEmail("someone@example.com")).toBe("s•••@example.com");
    expect(maskAntigravityAccountEmail("not-an-email")).toBe("•••");
  });

  it("names the lowest window of a remembered reading, counting a window past its reset as full", () => {
    const now = Date.parse("2026-11-21T12:00:00.000Z");
    const window = (id: string, usedPercent: number, resetsAt?: string) => ({
      id,
      kind: "session" as const,
      label: id,
      usedPercent,
      ...(resetsAt ? { resetsAt } : {}),
    });
    const limits = (windows: ReturnType<typeof window>[]) => ({
      checkedAt: "2026-11-21T09:00:00.000Z",
      windows,
    });
    expect(
      antigravityAccountLowest(
        limits([window("a", 30, "2026-11-21T15:00:00.000Z"), window("b", 80)]),
        now,
      ),
    ).toEqual({ remaining: 20, readAgoMs: 3 * 3_600_000 });
    expect(
      antigravityAccountLowest(limits([window("a", 95, "2026-11-21T10:00:00.000Z")]), now)
        ?.remaining,
    ).toBe(100);
    expect(antigravityAccountLowest(limits([]), now)).toBeNull();
    expect(antigravityAccountLowest(null, now)).toBeNull();
  });
});
