import { useAtomValue } from "@effect/atom-react";
import { EMPTY_RUN_OUTPUTS, type RunOutputs } from "@t3tools/client-runtime/outputs/run";
import { EMPTY_THREAD_OUTPUTS, type ThreadOutputs } from "@t3tools/client-runtime/outputs/thread";
import type { RunId, ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { environmentThreadDetails } from "./threads";

const NO_THREAD_OUTPUTS_ATOM = Atom.make<ThreadOutputs>(EMPTY_THREAD_OUTPUTS).pipe(
  Atom.withLabel("mobile-thread-outputs:empty"),
);
const NO_RUN_OUTPUTS_ATOM = Atom.make<RunOutputs>(EMPTY_RUN_OUTPUTS).pipe(
  Atom.withLabel("mobile-run-outputs:empty"),
);

/** Every finished run's files and links, newest first. Streamed text never changes it. */
export function useThreadOutputs(
  ref: ScopedThreadRef | null,
  cwd: string | null | undefined,
): ThreadOutputs {
  return useAtomValue(
    ref === null
      ? NO_THREAD_OUTPUTS_ATOM
      : environmentThreadDetails.outputsAtom(ref, cwd ?? undefined),
  );
}

/** One run's own outputs; its object is replaced only when they change. */
export function useRunOutputs(
  ref: ScopedThreadRef | null,
  cwd: string | null | undefined,
  runId: RunId | null | undefined,
): RunOutputs {
  return useAtomValue(
    ref === null || runId == null
      ? NO_RUN_OUTPUTS_ATOM
      : environmentThreadDetails.runOutputsAtom(ref, cwd ?? undefined, runId),
  );
}
