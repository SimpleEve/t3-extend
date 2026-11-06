// Which shells are live follows the terminal metadata stream: the snapshot, a restart that changes
// the pid, an exit, and a removal (design 5.3).
import { assert, describe, it } from "@effect/vitest";
import type { TerminalMetadataStreamEvent, TerminalSummary } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as TerminalManager from "../../terminal/Manager.ts";
import * as ProcessInspector from "./ProcessInspector.ts";
import * as TerminalShellRegistry from "./TerminalShellRegistry.ts";

const summary = (
  terminalId: string,
  pid: number | null,
  status: TerminalSummary["status"] = "running",
): TerminalSummary => ({
  threadId: "thread-1",
  terminalId,
  cwd: "/tmp",
  worktreePath: null,
  status,
  pid,
  exitCode: null,
  exitSignal: null,
  hasRunningSubprocess: false,
  label: terminalId,
  updatedAt: "2026-11-04T00:00:00.000Z",
});

const fold = (events: ReadonlyArray<TerminalMetadataStreamEvent>) =>
  [
    ...events
      .reduce(
        (current, event) => TerminalShellRegistry.applyTerminalMetadata(current, event),
        new Map<string, number>() as ReadonlyMap<string, number>,
      )
      .values(),
  ].toSorted((a, b) => a - b);

describe("applyTerminalMetadata", () => {
  it("a snapshot replaces everything and keeps only live shells with a pid", () => {
    assert.deepEqual(
      fold([
        { type: "snapshot", terminals: [summary("a", 10)] },
        {
          type: "snapshot",
          terminals: [
            summary("b", 20),
            summary("c", 30, "exited"),
            summary("d", null, "starting"),
            summary("e", 40, "starting"),
          ],
        },
      ]),
      [20, 40],
    );
  });

  it("a restart replaces the pid, an exit and a removal drop the shell", () => {
    assert.deepEqual(
      fold([
        { type: "snapshot", terminals: [summary("a", 10), summary("b", 20)] },
        { type: "upsert", terminal: summary("a", 11) },
      ]),
      [11, 20],
    );
    assert.deepEqual(
      fold([
        { type: "snapshot", terminals: [summary("a", 10), summary("b", 20)] },
        { type: "upsert", terminal: summary("a", 10, "exited") },
      ]),
      [20],
    );
    assert.deepEqual(
      fold([
        { type: "snapshot", terminals: [summary("a", 10), summary("b", 20)] },
        { type: "remove", threadId: "thread-1", terminalId: "b" },
      ]),
      [10],
    );
  });
});

describe("TerminalShellRegistry", () => {
  it.effect("records each live shell with its start time and forgets it when it ends", () =>
    Effect.gen(function* () {
      let listener: ((event: TerminalMetadataStreamEvent) => Effect.Effect<void>) | undefined;
      let unsubscribed = false;
      const manager = {
        subscribeMetadata: (next: typeof listener) =>
          Effect.sync(() => {
            listener = next;
            return () => {
              unsubscribed = true;
            };
          }),
      } as unknown as TerminalManager.TerminalManager["Service"];
      const inspector = {
        startTime: (pid: number) => Effect.succeed(`start-${pid}`),
      } as unknown as ProcessInspector.ProcessInspector["Service"];

      yield* Effect.gen(function* () {
        const registry = yield* TerminalShellRegistry.TerminalShellRegistry;
        assert.equal((yield* registry.shells).size, 0);
        yield* listener!({ type: "snapshot", terminals: [summary("a", 10)] });
        assert.deepEqual([...(yield* registry.shells)], [[10, { startTime: "start-10" }]]);
        yield* listener!({ type: "upsert", terminal: summary("a", 10, "exited") });
        assert.equal((yield* registry.shells).size, 0);
      }).pipe(
        Effect.provide(TerminalShellRegistry.layer),
        Effect.provideService(TerminalManager.TerminalManager, manager),
        Effect.provideService(ProcessInspector.ProcessInspector, inspector),
        Effect.scoped,
      );
      assert.isTrue(unsubscribed);
    }),
  );
});
