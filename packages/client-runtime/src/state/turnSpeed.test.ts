import type { TurnTokenUsage } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  createLastTurnSpeedSelector,
  deriveLatestTurnSpeed,
  deriveTurnSpeed,
  formatTokensPerSecond,
  formatTurnSeconds,
  type TurnSpeedItem,
  type TurnSpeedTurn,
} from "./turnSpeed.ts";

const T0 = Date.parse("2026-11-15T10:00:00.000Z");
const at = (seconds: number) => DateTime.makeUnsafe(T0 + seconds * 1000);

const complete = (outputTokens: number, extra: Partial<TurnTokenUsage> = {}): TurnTokenUsage =>
  ({
    usageScope: "main_agent",
    usageStatus: "complete",
    inputTokens: 5000,
    outputTokens,
    hasSubagents: false,
    ...extra,
  }) as TurnTokenUsage;

const turn = (overrides: Partial<TurnSpeedTurn> = {}): TurnSpeedTurn => ({
  id: "turn-1",
  status: "completed",
  startedAt: at(0),
  completedAt: at(20),
  turnTokenUsage: complete(400),
  ...overrides,
});

const item = (
  type: string,
  start: number | null,
  end: number | null,
  overrides: Partial<TurnSpeedItem> = {},
): TurnSpeedItem => ({
  type,
  providerTurnId: "turn-1",
  startedAt: start === null ? null : at(start),
  completedAt: end === null ? null : at(end),
  ...overrides,
});

describe("deriveTurnSpeed", () => {
  it("divides the turn's output tokens by the time spent writing, minus tool calls", () => {
    // Writes 1-4s and 12-20s; a command runs 4-12s. Decode is 3 + 8 = 11s, not the 20s wall time.
    const speed = deriveTurnSpeed(turn(), [
      item("user_message", 0, 0),
      item("assistant_message", 1, 4),
      item("command_execution", 4, 12),
      item("assistant_message", 12, 20),
    ]);
    expect(speed).toMatchObject({
      outputTokens: 400,
      decodeMs: 11_000,
      tokensPerSecond: 400 / 11,
      turnMs: 20_000,
      firstTokenMs: 1000,
    });
  });

  it("does not count the tool time an open writing item spans", () => {
    // The assistant item stays open from 1s to 20s while a command runs 5-15s inside it.
    const speed = deriveTurnSpeed(turn(), [
      item("assistant_message", 1, 20),
      item("command_execution", 5, 15),
    ]);
    expect(speed?.decodeMs).toBe(9000);
    expect(speed?.tokensPerSecond).toBeCloseTo(400 / 9);
  });

  it("counts reasoning, and counts time where reasoning and the reply overlap once", () => {
    const speed = deriveTurnSpeed(turn({ turnTokenUsage: complete(300) }), [
      item("reasoning", 2, 6),
      item("assistant_message", 5, 9),
    ]);
    expect(speed?.decodeMs).toBe(7000);
    expect(speed?.firstTokenMs).toBe(2000);
  });

  it("does not count time spent waiting on the user", () => {
    const speed = deriveTurnSpeed(turn(), [
      item("assistant_message", 1, 11),
      item("approval_request", 3, 9),
    ]);
    expect(speed?.decodeMs).toBe(4000);
  });

  it("ignores items of other provider turns", () => {
    const speed = deriveTurnSpeed(turn(), [
      item("assistant_message", 1, 11),
      item("assistant_message", 11, 19, { providerTurnId: "turn-2" }),
    ]);
    expect(speed?.decodeMs).toBe(10_000);
  });

  it("closes a writing item left open at the end of the turn", () => {
    const speed = deriveTurnSpeed(turn(), [item("assistant_message", 10, null)]);
    expect(speed?.decodeMs).toBe(10_000);
  });

  it("uses the turn's own usage, never the cumulative thread snapshot", () => {
    const speed = deriveTurnSpeed(
      {
        ...turn(),
        // Pi and Codex thread snapshots carry session totals here.
        tokenUsage: { usedTokens: 90_000, outputTokens: 99_999 },
      } as TurnSpeedTurn,
      [item("assistant_message", 0, 10)],
    );
    expect(speed?.outputTokens).toBe(400);
  });

  it.each([
    ["has no per-turn usage", { turnTokenUsage: undefined }],
    [
      "reports usage as unavailable",
      { turnTokenUsage: { ...complete(400), usageStatus: "unavailable" } as TurnTokenUsage },
    ],
    [
      "reports usage as partial",
      { turnTokenUsage: { ...complete(400), usageStatus: "partial" } as TurnTokenUsage },
    ],
    ["reported no output tokens", { turnTokenUsage: complete(0) }],
    [
      "was a local command",
      { turnTokenUsage: complete(400, { localCommand: true }) as TurnTokenUsage },
    ],
    ["did not complete", { status: "interrupted" as const }],
    ["has no start time", { startedAt: null }],
  ])("is null when the turn %s", (_name, overrides) => {
    expect(deriveTurnSpeed(turn(overrides), [item("assistant_message", 0, 10)])).toBeNull();
  });

  it("is null without a measurable writing time", () => {
    expect(deriveTurnSpeed(turn(), [])).toBeNull();
    expect(deriveTurnSpeed(turn(), [item("command_execution", 0, 10)])).toBeNull();
    // A reply that arrived in one piece says nothing about speed.
    expect(deriveTurnSpeed(turn(), [item("assistant_message", 3, 3.2)])).toBeNull();
  });
});

describe("items outside the turn", () => {
  it("counts only the part of an item inside the turn", () => {
    // The turn runs 0-20s; a reply stamped -5..8s and one stamped 15..40s each lose their overhang.
    const speed = deriveTurnSpeed(turn(), [
      item("assistant_message", -5, 8),
      item("assistant_message", 15, 40),
    ]);
    expect(speed?.decodeMs).toBe(13_000);
    expect(speed?.firstTokenMs).toBe(0);
  });

  it("drops items wholly outside the turn or with reversed times", () => {
    const speed = deriveTurnSpeed(turn(), [
      item("assistant_message", 1, 11),
      item("assistant_message", 25, 40),
      item("assistant_message", -9, -3),
      item("assistant_message", 14, 12),
      item("reasoning", 30, 31),
    ]);
    expect(speed?.decodeMs).toBe(10_000);
    expect(speed?.firstTokenMs).toBe(1000);
  });

  it("clips tool time the same way, so it never removes more than the turn held", () => {
    // A command stamped 5..60s removes only 5..20s; the reply 1..20s keeps 1..5s.
    const speed = deriveTurnSpeed(turn(), [
      item("assistant_message", 1, 20),
      item("command_execution", 5, 60),
    ]);
    expect(speed?.decodeMs).toBe(4000);
  });
});

const row = (value: TurnSpeedItem) => ({ item: value });

describe("createLastTurnSpeedSelector", () => {
  it("scans items once per finished turn and keeps the result while a turn streams", () => {
    const select = createLastTurnSpeedSelector();
    const done = turn();
    const items = [row(item("assistant_message", 0, 10))];
    const first = select([done], items);
    expect(first?.providerTurnId).toBe("turn-1");
    const running = turn({
      id: "turn-2",
      status: "running",
      startedAt: at(30),
      completedAt: null,
      turnTokenUsage: complete(80),
    });
    // New items and a new live report for the running turn leave the answer, by identity, alone.
    const second = select(
      [done, running],
      [...items, row(item("assistant_message", 31, null, { providerTurnId: "turn-2" }))],
    );
    expect(second).toBe(first);
  });

  it("moves when a newer turn finishes, and is null with no reported turn", () => {
    const select = createLastTurnSpeedSelector();
    expect(
      select([turn({ turnTokenUsage: undefined })], [row(item("assistant_message", 0, 10))]),
    ).toBeNull();
    const first = select([turn()], [row(item("assistant_message", 0, 10))]);
    const next = turn({ id: "turn-2", startedAt: at(30), completedAt: at(50) });
    const second = select(
      [turn(), next],
      [
        row(item("assistant_message", 0, 10)),
        row(item("assistant_message", 31, 41, { providerTurnId: "turn-2" })),
      ],
    );
    expect(second?.providerTurnId).toBe("turn-2");
    expect(second).not.toBe(first);
  });

  it("reads items again after a miss, since they may have been what was missing", () => {
    const select = createLastTurnSpeedSelector();
    expect(select([turn()], [])).toBeNull();
    expect(select([turn()], [row(item("assistant_message", 0, 10))])?.decodeMs).toBe(10_000);
  });
});

describe("deriveLatestTurnSpeed", () => {
  it("reads the newest completed turn that has data", () => {
    const older = turn({ id: "turn-1", completedAt: at(20), turnTokenUsage: complete(200) });
    const newerWithoutData = turn({
      id: "turn-2",
      startedAt: at(30),
      completedAt: at(50),
      turnTokenUsage: undefined,
    });
    const running = turn({ id: "turn-3", status: "running", startedAt: at(60), completedAt: null });
    const speed = deriveLatestTurnSpeed(
      [older, newerWithoutData, running],
      [
        item("assistant_message", 1, 11),
        item("assistant_message", 31, 41, { providerTurnId: "turn-2" }),
        item("assistant_message", 61, 70, { providerTurnId: "turn-3" }),
      ],
    );
    expect(speed?.providerTurnId).toBe("turn-1");
    expect(speed?.tokensPerSecond).toBe(20);
  });

  it("stays on the last finished turn while the next one streams", () => {
    const done = turn();
    const running = turn({
      id: "turn-2",
      status: "running",
      startedAt: at(30),
      completedAt: null,
      turnTokenUsage: complete(50),
    });
    const items = [item("assistant_message", 0, 10)];
    const before = deriveLatestTurnSpeed([done, running], items);
    const more = deriveLatestTurnSpeed(
      [done, running],
      [...items, item("assistant_message", 31, null, { providerTurnId: "turn-2" })],
    );
    expect(more).toEqual(before);
    expect(before?.providerTurnId).toBe("turn-1");
  });

  it("is null when no turn qualifies", () => {
    expect(deriveLatestTurnSpeed([], [])).toBeNull();
    expect(deriveLatestTurnSpeed([turn({ turnTokenUsage: undefined })], [])).toBeNull();
  });
});

describe("formatTokensPerSecond", () => {
  it.each([
    [0, "0"],
    [-3, "0"],
    [0.04, "0"],
    [9.94, "9.9"],
    [9.96, "10"],
    [10, "10"],
    [10.4, "10"],
    [10.5, "11"],
    [123.456, "123"],
  ])("%s -> %s", (value, expected) => {
    expect(formatTokensPerSecond(value)).toBe(expected);
  });
});

describe("formatTurnSeconds", () => {
  it.each([
    [0, "0.0s"],
    [1000, "1.0s"],
    [850, "0.9s"],
    [1234, "1.2s"],
    [9949, "9.9s"],
    [9950, "10s"],
    [12_400, "12s"],
    [59_400, "59s"],
    [59_600, "1m 0s"],
    [65_000, "1m 5s"],
    [3_725_000, "62m 5s"],
  ])("%s ms -> %s", (ms, expected) => {
    expect(formatTurnSeconds(ms)).toBe(expected);
  });
});
