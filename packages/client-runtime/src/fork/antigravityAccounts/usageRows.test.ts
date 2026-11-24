import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { collectLimitAccounts, collectLimitPools } from "@t3tools/shared/usageLimits";

import { accountUsageRows, listsAccountUsage } from "./usageRows.ts";

const now = Date.parse("2026-09-03T12:00:00.000Z");
const window = (id: string, label: string, usedPercent: number, resetsAt: string) => ({
  id,
  kind: "session" as const,
  label,
  usedPercent,
  resetsAt,
  windowDurationMins: 300,
});

const provider: ServerProvider = {
  instanceId: ProviderInstanceId.make("antigravity"),
  driver: ProviderDriverKind.make("antigravity"),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: {
    status: "authenticated",
    accounts: [
      {
        id: "aaaaaaaaaaaaaaaa",
        email: "far@example.com",
        current: false,
        usageLimits: {
          checkedAt: "2026-09-03T09:00:00.000Z",
          windows: [window("gemini-5h", "Gemini · 5-hour", 10, "2026-09-03T16:00:00.000Z")],
        },
      },
      { id: "bbbbbbbbbbbbbbbb", email: "never@example.com", current: false },
      {
        id: "cccccccccccccccc",
        email: "soon@example.com",
        current: false,
        usageLimits: {
          checkedAt: "2026-09-03T11:00:00.000Z",
          windows: [window("gemini-5h", "Gemini · 5-hour", 50, "2026-09-03T13:00:00.000Z")],
        },
      },
      { id: "dddddddddddddddd", email: "live@example.com", current: true },
    ],
  },
  checkedAt: "2026-09-03T11:59:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
  usageLimits: {
    checkedAt: "2026-09-03T11:59:00.000Z",
    windows: [window("gemini-5h", "Gemini · 5-hour", 30, "2026-09-03T15:00:00.000Z")],
  },
};

const [pool] = collectLimitPools(
  collectLimitAccounts(
    new Map([
      [
        EnvironmentId.make("env"),
        { entry: { target: { label: "Laptop" } }, serverConfig: { providers: [provider] } },
      ],
    ]),
  ),
  now,
);

describe("account usage rows", () => {
  it("lists the account in use first, then the others by whose quota comes back soonest", () => {
    const { rows, columns } = accountUsageRows(pool!, now);
    expect(columns.map((column) => column.id)).toEqual(["gemini-5h"]);
    expect(rows.map((row) => row.account.email)).toEqual([
      "live@example.com",
      "soon@example.com",
      "far@example.com",
      "never@example.com",
    ]);
  });

  it("says how old a remembered reading is, and nothing for a live one or an unread account", () => {
    const rows = accountUsageRows(pool!, now).rows;
    const by = (email: string) => rows.find((row) => row.account.email === email)!;
    expect(by("live@example.com")).toMatchObject({ current: true, readAgoMs: null, unread: false });
    expect(by("far@example.com").readAgoMs).toBe(3 * 3_600_000);
    expect(by("never@example.com")).toMatchObject({ unread: true, readAgoMs: null });
    expect(by("never@example.com").cells).toEqual([null]);
  });

  it("lists an Antigravity pool of two or more, and nothing else", () => {
    expect(listsAccountUsage(pool!)).toBe(true);
    expect(listsAccountUsage({ ...pool!, accounts: pool!.accounts.slice(0, 1) })).toBe(false);
    expect(listsAccountUsage({ ...pool!, driver: ProviderDriverKind.make("codex") })).toBe(false);
  });
});
