// fork: the terminal shells that are running right now, so a terminal's services are not taken
// for T3's own processes. Event driven: it follows `TerminalManager.subscribeMetadata`, whose snapshot and
// started/restarted/exited/closed/error events carry each shell's pid, and keeps no timer. A
// shell is recorded with its start time, so a reused pid is not mistaken for it.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import type { TerminalMetadataStreamEvent, TerminalSummary } from "@t3tools/contracts";

import * as TerminalManager from "../../terminal/Manager.ts";
import type { ShellEntry } from "./ExclusionRules.ts";
import * as ProcessInspector from "./ProcessInspector.ts";

export class TerminalShellRegistry extends Context.Service<
  TerminalShellRegistry,
  { readonly shells: Effect.Effect<ReadonlyMap<number, ShellEntry>> }
>()("t3/fork/tunnelExclusions/TerminalShellRegistry") {}

const key = (summary: { readonly threadId: string; readonly terminalId: string }) =>
  `${summary.threadId}\u0000${summary.terminalId}`;

const isLive = (terminal: TerminalSummary): terminal is TerminalSummary & { pid: number } =>
  (terminal.status === "running" || terminal.status === "starting") && terminal.pid !== null;

/** Folds one metadata event into the table of live shells (pure, for tests). */
export const applyTerminalMetadata = (
  current: ReadonlyMap<string, number>,
  event: TerminalMetadataStreamEvent,
): ReadonlyMap<string, number> => {
  const next = new Map(event.type === "snapshot" ? [] : current);
  if (event.type === "snapshot") {
    for (const terminal of event.terminals)
      if (isLive(terminal)) next.set(key(terminal), terminal.pid);
  } else if (event.type === "upsert") {
    if (isLive(event.terminal)) next.set(key(event.terminal), event.terminal.pid);
    else next.delete(key(event.terminal));
  } else {
    next.delete(key(event));
  }
  return next;
};

export const layer = Layer.effect(
  TerminalShellRegistry,
  Effect.gen(function* () {
    const terminals = yield* TerminalManager.TerminalManager;
    const inspector = yield* ProcessInspector.ProcessInspector;
    // Updated only from the listener below, in event order; `startTimes` is filled in behind it.
    let byTerminal: ReadonlyMap<string, number> = new Map();
    const startTimes = new Map<number, string | null>();
    // Reads in flight: `shells` waits for them, so a shell that has just started is not refused as
    // unknown for the length of one `ps`.
    const pending = new Set<Fiber.Fiber<void>>();
    const remember = (pid: number) =>
      inspector.startTime(pid).pipe(
        Effect.orElseSucceed(() => null),
        Effect.tap((startTime) => Effect.sync(() => startTimes.set(pid, startTime))),
        Effect.asVoid,
      );
    const unsubscribe = yield* terminals.subscribeMetadata((event) =>
      Effect.gen(function* () {
        byTerminal = applyTerminalMetadata(byTerminal, event);
        const live = new Set(byTerminal.values());
        for (const pid of Array.from(startTimes.keys())) if (!live.has(pid)) startTimes.delete(pid);
        for (const pid of live)
          if (!startTimes.has(pid)) {
            startTimes.set(pid, null);
            const reading = yield* Effect.forkDetach(remember(pid));
            pending.add(reading);
            reading.addObserver(() => pending.delete(reading));
          }
      }),
    );
    yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
    return TerminalShellRegistry.of({
      shells: Effect.suspend(() => Effect.forEach(pending, Fiber.await, { discard: true })).pipe(
        Effect.map(
          () =>
            new Map(
              [...new Set(byTerminal.values())].map((pid) => [
                pid,
                { startTime: startTimes.get(pid) ?? null },
              ]),
            ),
        ),
      ),
    });
  }),
);
