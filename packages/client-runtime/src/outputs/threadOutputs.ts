import type {
  OrchestrationV2Run,
  OrchestrationV2ThreadProjection,
  RunId,
} from "@t3tools/contracts";

import { outputPathKey } from "./paths.ts";
import {
  type CheckpointOutputFile,
  deriveRunOutputs,
  EMPTY_RUN_OUTPUTS,
  type OutputFile,
  type OutputLink,
  type RunOutputs,
  sameRunOutputs,
} from "./runOutputs.ts";

export interface ThreadOutputFile extends OutputFile {
  readonly runId: RunId;
}

export interface ThreadOutputLink extends OutputLink {
  readonly runId: RunId;
}

export interface ThreadOutputs {
  /** Newest run first; inside a run, files its reply links to come first. */
  readonly files: ReadonlyArray<ThreadOutputFile>;
  readonly links: ReadonlyArray<ThreadOutputLink>;
  /** Every finished run's own outputs, for the strip under its reply. */
  readonly byRunId: ReadonlyMap<RunId, RunOutputs>;
}

export const EMPTY_THREAD_OUTPUTS: ThreadOutputs = Object.freeze({
  files: Object.freeze([]),
  links: Object.freeze([]),
  byRunId: new Map<RunId, RunOutputs>(),
});

/** The conversation's lists stop here; a run that rewrote a tree is already capped per run. */
const MAX_THREAD_OUTPUT_FILES = 300;
const MAX_THREAD_OUTPUT_LINKS = 100;

type OutputRunStatus = OrchestrationV2Run["status"];

// A rolled-back run's files were reverted, and a queued or running one has no final reply yet.
const FINISHED_RUN_STATUSES: ReadonlySet<OutputRunStatus> = new Set([
  "completed",
  "interrupted",
  "failed",
  "cancelled",
]);

function isOutputRunFinished(status: OutputRunStatus): boolean {
  return FINISHED_RUN_STATUSES.has(status);
}

/** Runs oldest to newest in, newest to oldest out, each output kept where it first appears. */
export function mergeThreadOutputs(
  runs: ReadonlyArray<{ readonly runId: RunId; readonly outputs: RunOutputs }>,
): ThreadOutputs {
  const files = new Map<string, ThreadOutputFile>();
  const links = new Map<string, ThreadOutputLink>();
  const byRunId = new Map<RunId, RunOutputs>();
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    const { runId, outputs } = runs[index]!;
    if (outputs !== EMPTY_RUN_OUTPUTS) byRunId.set(runId, outputs);
    for (const file of outputs.files) {
      const key = outputPathKey(file.path);
      if (!files.has(key) && files.size < MAX_THREAD_OUTPUT_FILES) {
        files.set(key, { ...file, runId });
      }
    }
    for (const link of outputs.links) {
      if (!links.has(link.url) && links.size < MAX_THREAD_OUTPUT_LINKS) {
        links.set(link.url, { ...link, runId });
      }
    }
  }
  if (files.size === 0 && links.size === 0) return EMPTY_THREAD_OUTPUTS;
  return { files: [...files.values()], links: [...links.values()], byRunId };
}

export interface ThreadOutputsSource {
  readonly runs: OrchestrationV2ThreadProjection["runs"];
  readonly turnItems: OrchestrationV2ThreadProjection["turnItems"];
  readonly checkpointFilesByRunId: ReadonlyMap<RunId, ReadonlyArray<CheckpointOutputFile>>;
  readonly cwd: string | undefined;
}

type SourceItem = OrchestrationV2ThreadProjection["turnItems"][number];

interface RunCacheEntry {
  readonly status: OutputRunStatus;
  readonly items: ReadonlyArray<SourceItem>;
  readonly replyItem: SourceItem | undefined;
  readonly checkpointFiles: ReadonlyArray<CheckpointOutputFile> | undefined;
  readonly cwd: string | undefined;
  readonly outputs: RunOutputs;
}

function sameItems(left: ReadonlyArray<SourceItem>, right: ReadonlyArray<SourceItem>): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

/**
 * Keeps each finished run's outputs between calls, so a thread that gains items recomputes only
 * the run that changed. The result keeps its identity when nothing in it changed.
 */
export function createThreadOutputsDeriver() {
  const cache = new Map<RunId, RunCacheEntry>();
  let previous: ThreadOutputs = EMPTY_THREAD_OUTPUTS;
  let previousRunOrder: ReadonlyArray<RunId> = [];

  return (source: ThreadOutputsSource): ThreadOutputs => {
    const itemsByRunId = new Map<RunId, SourceItem[]>();
    for (const item of source.turnItems) {
      if (item.runId === null) continue;
      const items = itemsByRunId.get(item.runId);
      if (items === undefined) itemsByRunId.set(item.runId, [item]);
      else items.push(item);
    }

    const finished: Array<{ runId: RunId; outputs: RunOutputs }> = [];
    const seen = new Set<RunId>();
    for (const run of [...source.runs].sort((a, b) => a.ordinal - b.ordinal)) {
      if (!isOutputRunFinished(run.status)) continue;
      seen.add(run.id);
      const items = itemsByRunId.get(run.id) ?? [];
      let replyItem: SourceItem | undefined;
      for (const item of items) {
        if (item.type === "assistant_message" && item.text.length > 0) {
          if (replyItem === undefined || item.ordinal >= replyItem.ordinal) replyItem = item;
        }
      }
      const checkpointFiles = source.checkpointFilesByRunId.get(run.id);
      const cached = cache.get(run.id);
      if (
        cached !== undefined &&
        cached.status === run.status &&
        cached.replyItem === replyItem &&
        cached.checkpointFiles === checkpointFiles &&
        cached.cwd === source.cwd &&
        sameItems(cached.items, items)
      ) {
        finished.push({ runId: run.id, outputs: cached.outputs });
        continue;
      }
      let outputs = deriveRunOutputs({
        replyText: replyItem?.type === "assistant_message" ? replyItem.text : undefined,
        items,
        checkpointFiles,
        cwd: source.cwd,
      });
      if (cached !== undefined && sameRunOutputs(cached.outputs, outputs)) outputs = cached.outputs;
      cache.set(run.id, {
        status: run.status,
        items,
        replyItem,
        checkpointFiles,
        cwd: source.cwd,
        outputs,
      });
      finished.push({ runId: run.id, outputs });
    }
    for (const runId of cache.keys()) {
      if (!seen.has(runId)) cache.delete(runId);
    }

    const runOrder = finished.map((entry) => entry.runId);
    const unchanged =
      runOrder.length === previousRunOrder.length &&
      finished.every(
        (entry, index) =>
          entry.runId === previousRunOrder[index] &&
          previous.byRunId.get(entry.runId) ===
            (entry.outputs === EMPTY_RUN_OUTPUTS ? undefined : entry.outputs),
      );
    if (unchanged) return previous;
    previousRunOrder = runOrder;
    previous = mergeThreadOutputs(finished);
    return previous;
  };
}
