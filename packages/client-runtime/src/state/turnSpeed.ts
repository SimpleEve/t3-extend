import type { OrchestrationV2ProviderTurn, TurnTokenUsage } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

/**
 * Output speed of one finished turn, read the way DeepSeek Harness reads its steps: the provider's
 * reported output tokens over the time from the first output to the end of the turn, minus time
 * spent in tools or waiting on the user. Output tokens include tool arguments and hidden thinking,
 * which no reply item spans, so only counting reply items' own time reads about three times high.
 */
export interface TurnSpeed {
  readonly providerTurnId: string;
  readonly outputTokens: number;
  readonly decodeMs: number;
  readonly tokensPerSecond: number;
  readonly turnMs: number | null;
  /** From the turn's start to the first reply or reasoning item. */
  readonly firstTokenMs: number | null;
}

export interface TurnSpeedTurn {
  readonly id: string;
  readonly status: OrchestrationV2ProviderTurn["status"];
  readonly startedAt: DateTime.Utc | null;
  readonly completedAt: DateTime.Utc | null;
  readonly turnTokenUsage?: TurnTokenUsage | undefined;
}

export interface TurnSpeedItem {
  readonly type: string;
  readonly providerTurnId: string | null;
  readonly startedAt: DateTime.Utc | null;
  readonly completedAt: DateTime.Utc | null;
  readonly updatedAt?: DateTime.Utc | undefined;
}

// A reply that lands in one piece spans almost no time; dividing by it would report thousands.
const MIN_DECODE_MS = 500;

const DECODE_ITEM_TYPES: ReadonlySet<string> = new Set(["assistant_message", "reasoning"]);

// Time inside these belongs to tools or the user, even when a writing item stays open across it.
const NON_DECODE_ITEM_TYPES: ReadonlySet<string> = new Set([
  "command_execution",
  "file_change",
  "file_search",
  "web_search",
  "dynamic_tool",
  "subagent",
  "approval_request",
  "user_input_request",
]);

type Interval = readonly [start: number, end: number];

function mergeIntervals(intervals: ReadonlyArray<Interval>): ReadonlyArray<Interval> {
  const sorted = [...intervals].sort((left, right) => left[0] - right[0]);
  const merged: Array<[number, number]> = [];
  for (const [start, end] of sorted) {
    const last = merged.at(-1);
    if (last !== undefined && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

function subtractIntervals(
  from: ReadonlyArray<Interval>,
  remove: ReadonlyArray<Interval>,
): ReadonlyArray<Interval> {
  return from.flatMap(([start, end]) => {
    const pieces: Array<Interval> = [];
    let cursor = start;
    for (const [removeStart, removeEnd] of remove) {
      if (removeEnd <= cursor || removeStart >= end) continue;
      if (removeStart > cursor) pieces.push([cursor, removeStart]);
      cursor = Math.max(cursor, removeEnd);
    }
    if (cursor < end) pieces.push([cursor, end]);
    return pieces;
  });
}

/** The tokens of one finished turn. Only the provider's per-turn report counts, never a thread total. */
function turnOutputTokens(turn: TurnSpeedTurn): number | null {
  const usage = turn.turnTokenUsage;
  if (
    usage === undefined ||
    usage.usageStatus !== "complete" ||
    usage.localCommand === true ||
    usage.outputTokens <= 0
  ) {
    return null;
  }
  return usage.outputTokens;
}

export function deriveTurnSpeed(
  turn: TurnSpeedTurn,
  items: ReadonlyArray<TurnSpeedItem>,
): TurnSpeed | null {
  if (turn.status !== "completed" || turn.startedAt === null) return null;
  const outputTokens = turnOutputTokens(turn);
  if (outputTokens === null) return null;

  const turnStart = DateTime.toEpochMillis(turn.startedAt);
  const turnEnd = turn.completedAt === null ? null : DateTime.toEpochMillis(turn.completedAt);
  const blocked: Array<Interval> = [];
  let firstOutputAt: number | null = null;
  let lastOutputAt: number | null = null;
  for (const item of items) {
    if (item.providerTurnId !== turn.id || item.startedAt === null) continue;
    const isDecode = DECODE_ITEM_TYPES.has(item.type);
    if (!isDecode && !NON_DECODE_ITEM_TYPES.has(item.type)) continue;
    const endTime = item.completedAt ?? item.updatedAt;
    const rawEnd =
      endTime === undefined || endTime === null ? turnEnd : DateTime.toEpochMillis(endTime);
    if (rawEnd === null) continue;
    // A provider can stamp an item outside its own turn; only the part inside counts.
    const start = Math.max(DateTime.toEpochMillis(item.startedAt), turnStart);
    const end = turnEnd === null ? rawEnd : Math.min(rawEnd, turnEnd);
    if (end <= start) continue;
    if (isDecode) {
      firstOutputAt = firstOutputAt === null ? start : Math.min(firstOutputAt, start);
      lastOutputAt = lastOutputAt === null ? end : Math.max(lastOutputAt, end);
    } else {
      blocked.push([start, end]);
    }
  }
  if (firstOutputAt === null || lastOutputAt === null) return null;

  const window: Interval = [firstOutputAt, turnEnd ?? lastOutputAt];
  const decodeMs = subtractIntervals([window], mergeIntervals(blocked)).reduce(
    (total, [start, end]) => total + (end - start),
    0,
  );
  if (decodeMs < MIN_DECODE_MS) return null;

  return {
    providerTurnId: turn.id,
    outputTokens,
    decodeMs,
    tokensPerSecond: outputTokens / (decodeMs / 1000),
    turnMs: turnEnd === null ? null : Math.max(0, turnEnd - turnStart),
    firstTokenMs: firstOutputAt - turnStart,
  };
}

/**
 * The newest finished turn with a measurable speed. A running turn never changes the answer, so
 * the figure holds while the next reply streams and moves once, when that turn finishes.
 */
export function deriveLatestTurnSpeed(
  turns: ReadonlyArray<TurnSpeedTurn>,
  items: ReadonlyArray<TurnSpeedItem>,
): TurnSpeed | null {
  const finished = turns
    .filter((turn) => turn.status === "completed" && turn.completedAt !== null)
    .sort(
      (left, right) =>
        DateTime.toEpochMillis(right.completedAt!) - DateTime.toEpochMillis(left.completedAt!),
    );
  for (const turn of finished) {
    const speed = deriveTurnSpeed(turn, items);
    if (speed !== null) return speed;
  }
  return null;
}

/** Whole tokens from ten up, one decimal below, as DeepSeek Harness shows it. */
export function formatTokensPerSecond(tokensPerSecond: number): string {
  const clamped = Math.max(0, tokensPerSecond);
  return clamped >= 10 ? String(Math.round(clamped)) : String(Math.round(clamped * 10) / 10);
}

/** `1.2s` under ten seconds, `12s` to a minute, `1m 5s` after. */
export function formatTurnSeconds(ms: number): string {
  const tenths = Math.round(Math.max(0, ms) / 100);
  if (tenths < 100) return `${(tenths / 10).toFixed(1)}s`;
  const seconds = Math.round(Math.max(0, ms) / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

type TurnSpeedCache = {
  readonly key: string;
  readonly rows: ReadonlyArray<unknown>;
  readonly speed: TurnSpeed | null;
};

/**
 * `deriveLatestTurnSpeed` that scans items only when a turn finishes or reports new usage, not on
 * every streamed update. A turn only takes part once it is complete and carries a usable report,
 * so the key is the list of those; with none, nothing is scanned at all.
 */
export function createLastTurnSpeedSelector() {
  let cache: TurnSpeedCache | null = null;
  return (
    turns: ReadonlyArray<TurnSpeedTurn>,
    rows: ReadonlyArray<{ readonly item: TurnSpeedItem }>,
  ): TurnSpeed | null => {
    const key = turns
      .flatMap((turn) =>
        turn.status === "completed" && turn.completedAt !== null && turnOutputTokens(turn) !== null
          ? [`${turn.id}@${DateTime.toEpochMillis(turn.completedAt)}#${turnOutputTokens(turn)}`]
          : [],
      )
      .join("|");
    if (key === "") {
      cache = null;
      return null;
    }
    // A turn with no measurable speed is judged by its items, so a miss reads them again once they change.
    if (cache !== null && cache.key === key && (cache.speed !== null || cache.rows === rows)) {
      return cache.speed;
    }
    const speed = deriveLatestTurnSpeed(
      turns,
      rows.map(({ item }) => item),
    );
    cache = { key, rows, speed };
    return speed;
  };
}
