import type { EnvironmentId } from "@t3tools/contracts";

interface RunningThreadInput {
  readonly environmentId: EnvironmentId;
  readonly runtime?: { readonly status: string } | null | undefined;
}

// A thread waiting on the user, queued, or settled does not need the computer awake.
const RUNNING_STATUSES: ReadonlySet<string> = new Set(["preparing", "starting", "running"]);

/** Whether any thread of the computer's own environment is running; remote environments never count. */
export function hasRunningLocalThread(
  threads: readonly RunningThreadInput[],
  localEnvironmentId: EnvironmentId | null,
): boolean {
  return (
    localEnvironmentId !== null &&
    threads.some(
      (thread) =>
        thread.environmentId === localEnvironmentId &&
        RUNNING_STATUSES.has(thread.runtime?.status ?? ""),
    )
  );
}

export function shouldKeepAwake(input: {
  readonly enabled: boolean;
  readonly hasBridge: boolean;
  readonly localThreadRunning: boolean;
}): boolean {
  return input.enabled && input.hasBridge && input.localThreadRunning;
}
