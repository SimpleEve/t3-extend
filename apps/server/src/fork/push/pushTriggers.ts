// @effect-diagnostics nodeBuiltinImport:off -- A short stable digest for alert ids, not random bytes.
import * as NodeCrypto from "node:crypto";

import type {
  PushNotificationKind,
  PushNotificationPayload,
  PushNotificationPreferences,
} from "@t3tools/contracts";
import type { RelayAgentActivityState } from "@t3tools/contracts/relay";

// fork: mirrors which agent states the relay notifies about (infra/relay agentActivityAlerts.ts),
// so a push means the same thing here as it does through T3 Connect.

type AwarenessPhase = RelayAgentActivityState["phase"];

/** What the thread was last seen as; `none` for no state, as when idle or settled. */
export type PhaseMemory = AwarenessPhase | "none";

/** A finished run older than this is history, not news: same window as the relay. */
export const TERMINAL_NOTIFICATION_FRESHNESS_MS = 2 * 60 * 1_000;
/** A completion is held this long first, as on the relay path: a continuation may follow it. */
export const COMPLETION_CONFIRMATION_MS = 5_000;

function pushKindForPhase(phase: AwarenessPhase | null): PushNotificationKind | null {
  switch (phase) {
    case "waiting_for_approval":
      return "approval";
    case "waiting_for_input":
      return "input";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    default:
      return null;
  }
}

export function preferenceAllows(
  preferences: PushNotificationPreferences,
  kind: PushNotificationKind,
): boolean {
  if (kind === "test") return true;
  if (!preferences.notificationsEnabled) return false;
  switch (kind) {
    case "approval":
      return preferences.notifyOnApproval;
    case "input":
      return preferences.notifyOnInput;
    case "completed":
      return preferences.notifyOnCompletion;
    case "failed":
      return preferences.notifyOnFailure;
  }
}

function isFreshTerminal(updatedAt: string, nowMs: number): boolean {
  const timestamp = Date.parse(updatedAt);
  return Number.isFinite(timestamp) && nowMs - timestamp <= TERMINAL_NOTIFICATION_FRESHNESS_MS;
}

/**
 * An alert is a thread moving into approval, input, completion or failure from
 * something else. Staying in the phase, or a replay of it after a restart,
 * does not alert again.
 */
export function decideThreadAlert(input: {
  readonly previous: PhaseMemory;
  readonly next: Pick<RelayAgentActivityState, "phase" | "updatedAt"> | null;
  readonly nowMs: number;
}): { readonly memory: PhaseMemory; readonly kind: PushNotificationKind | null } {
  const phase = input.next?.phase ?? null;
  const memory: PhaseMemory = phase ?? "none";
  const kind = pushKindForPhase(phase);
  if (kind === null || input.next === null || memory === input.previous) {
    return { memory, kind: null };
  }
  if (
    (kind === "completed" || kind === "failed") &&
    !isFreshTerminal(input.next.updatedAt, input.nowMs)
  ) {
    return { memory, kind: null };
  }
  return { memory, kind };
}

const clip = (value: string, max: number) =>
  value.length <= max ? value : `${value.slice(0, max - 1)}…`;

export function buildPushPayload(input: {
  readonly kind: PushNotificationKind;
  readonly environmentId: string;
  readonly environmentLabel: string;
  readonly threadId: string;
  readonly threadTitle: string;
  readonly projectTitle: string;
  readonly updatedAt: string;
  readonly nowMs: number;
}): PushNotificationPayload {
  const at = Date.parse(input.updatedAt);
  return {
    v: 1,
    id: NodeCrypto.createHash("sha256")
      .update(JSON.stringify([input.environmentId, input.threadId, input.kind, input.updatedAt]))
      .digest("hex")
      .slice(0, 32),
    kind: input.kind,
    environmentId: input.environmentId,
    environmentLabel: clip(input.environmentLabel, 100),
    threadId: input.threadId,
    threadTitle: clip(input.threadTitle, 120),
    projectTitle: clip(input.projectTitle, 120),
    at: Number.isFinite(at) ? at : input.nowMs,
  };
}
