import {
  type EnvironmentId,
  isProviderAvailable,
  type ServerProvider,
  type ServerProviderUsageLimits,
  type ServerProviderUsageWindow,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import type { LimitAccount, LimitPresentations } from "../usageLimits.ts";

// fork: an Antigravity instance can keep several Google accounts. Only the one in use is read live;
// the rest carry the last reading taken while they were in use. Everything that turns that into
// per-account limits lives here, so `usageLimits.ts` only calls in.

/** The reading time of an account that was never read; any real reading of it wins a merge. */
const UNREAD_AT = "1970-01-01T00:00:00.000Z";

type Reading = ServerProviderUsageLimits;

const readable = (limits: Reading | undefined): Reading | undefined =>
  limits !== undefined && limits.unavailable === undefined && limits.windows.length > 0
    ? limits
    : undefined;

/** Two readings of one account share a fingerprint; a reading without one cannot disagree. */
const sameCredential = (left: Reading | undefined, right: Reading | undefined) =>
  left?.credentialFingerprint === undefined ||
  right?.credentialFingerprint === undefined ||
  left.credentialFingerprint === right.credentialFingerprint;

const savedAccounts = (provider: ServerProvider) =>
  provider.driver === "antigravity" ? (provider.auth.accounts ?? []) : [];

/**
 * The providers `collectLimitAccounts` goes through: those with limits, plus Antigravity instances
 * that have saved accounts but no live reading right now (just after a switch, or just started),
 * which still have snapshots to show.
 */
export function antigravityProvidersWithLimits(
  providers: readonly ServerProvider[],
  withLimits: readonly ServerProvider[],
): readonly ServerProvider[] {
  return providers.filter(
    (provider) =>
      withLimits.includes(provider) ||
      (provider.usageLimits === undefined &&
        savedAccounts(provider).length > 0 &&
        provider.enabled &&
        provider.installed &&
        isProviderAvailable(provider)),
  );
}

interface KeyedReport {
  readonly driver: ServerProvider["driver"];
  readonly email?: string | undefined;
  readonly usageLimits?: Reading | undefined;
}

/**
 * Antigravity never reports an e-mail for a plain or shared-login instance, only a fingerprint of
 * the Google account, while saved accounts are known by e-mail. The saved readings say which
 * fingerprint belongs to which e-mail, so a report with only a fingerprint resolves to the same
 * account key as the saved account it belongs to.
 */
export function withAntigravityAliases<R extends KeyedReport>(
  presentations: LimitPresentations,
  resolveKey: (report: R) => string | null,
): (report: R) => string | null {
  const emails = new Map<string, string>();
  for (const { serverConfig } of presentations.values()) {
    for (const provider of serverConfig?.providers ?? []) {
      if (!provider.enabled) continue;
      const live = readable(provider.usageLimits);
      for (const account of savedAccounts(provider)) {
        if (!account.email) continue;
        const remembered = account.usageLimits?.credentialFingerprint;
        if (remembered) emails.set(remembered, account.email);
        const fingerprint = live?.credentialFingerprint;
        if (fingerprint && account.current && sameCredential(live, account.usageLimits)) {
          emails.set(fingerprint, account.email);
        }
      }
    }
  }
  return (report) => {
    const email =
      report.driver === "antigravity" && !report.email
        ? emails.get(report.usageLimits?.credentialFingerprint ?? "")
        : undefined;
    return resolveKey(email === undefined ? report : { ...report, email });
  };
}

/**
 * Adds the accounts of an Antigravity instance that keeps saved accounts, and says whether it was
 * one. Several accounts become one entry each; a lone account stays the instance's own entry, named
 * by its e-mail. The account in use takes the live reading when it is its own, else its snapshot.
 */
export function mergeAntigravityAccounts(input: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly provider: ServerProvider;
  readonly resolveKey: (report: KeyedReport) => string | null;
  readonly merge: (key: string, account: LimitAccount) => void;
}): boolean {
  const { environmentId, label, provider, resolveKey, merge } = input;
  const saved = savedAccounts(provider);
  if (saved.length === 0) return false;
  const live = readable(provider.usageLimits);
  const environments = [{ environmentId, label }];
  const lone = saved.length === 1;
  for (const account of saved) {
    const liveReading =
      (account.current || lone) && sameCredential(live, account.usageLimits) ? live : undefined;
    const snapshot = readable(account.usageLimits);
    const limits = liveReading ?? snapshot;
    if (limits === undefined && lone) continue;
    const reading = limits ?? { checkedAt: UNREAD_AT, windows: [] };
    const exhaustedUntil = account.exhaustedUntil ? Date.parse(account.exhaustedUntil) : Number.NaN;
    const key = lone
      ? `${environmentId}:${provider.instanceId}`
      : `${environmentId}:${provider.instanceId}:${account.id}`;
    const email = provider.auth.email ?? account.email;
    merge(resolveKey({ driver: provider.driver, email, usageLimits: reading }) ?? key, {
      key,
      driver: provider.driver,
      displayName: lone ? provider.displayName?.trim() || null : null,
      email,
      plan: provider.auth.label,
      accentColor: provider.accentColor,
      environments,
      sourceLabel: null,
      redeem: lone ? { environmentId, input: { instanceId: provider.instanceId } } : null,
      limits: reading,
      snapshot: liveReading === undefined ? true : undefined,
      current: account.current,
      exhaustedUntil: Number.isFinite(exhaustedUntil) ? exhaustedUntil : undefined,
    });
  }
  return true;
}

/**
 * What `merge` keeps of an account seen twice: the later exhaustion mark, so another environment's
 * fresher reading does not hide that the account is spent, and the current flag if either side has it.
 */
export function mergedAntigravityFields(
  previous: LimitAccount,
  next: LimitAccount,
  winner: LimitAccount,
): Pick<LimitAccount, "snapshot" | "current" | "exhaustedUntil"> {
  const marks = [previous.exhaustedUntil, next.exhaustedUntil].filter(
    (mark): mark is number => mark !== undefined,
  );
  return {
    snapshot: winner.snapshot,
    current: previous.current === true || next.current === true ? true : winner.current,
    exhaustedUntil: marks.length > 0 ? Math.max(...marks) : undefined,
  };
}

const resetMillis = (window: ServerProviderUsageWindow): number | null => {
  const at = window.resetsAt === undefined ? Number.NaN : Date.parse(window.resetsAt);
  return Number.isFinite(at) ? at : null;
};

/**
 * What a window of an account stands for at `now`. Only a remembered reading is reinterpreted: a
 * spent account is empty until it is back, and a window whose reset has passed has refilled, with
 * its next reset unknown until the account is used again. A live reading is the truth as it is.
 */
export function antigravityWindowAt(
  account: LimitAccount,
  window: ServerProviderUsageWindow,
  now: number,
): ServerProviderUsageWindow {
  if (!account.snapshot) return window;
  const reset = resetMillis(window);
  const exhaustedUntil = account.exhaustedUntil;
  if (exhaustedUntil !== undefined && exhaustedUntil > now) {
    if (window.usedPercent >= 100 && reset !== null && reset > exhaustedUntil) return window;
    return {
      ...window,
      usedPercent: 100,
      resetsAt: DateTime.formatIso(DateTime.makeUnsafe(exhaustedUntil)),
      windowDurationMins: undefined,
    };
  }
  if (reset !== null && reset <= now) {
    return { ...window, usedPercent: 0, resetsAt: undefined, windowDurationMins: undefined };
  }
  return window;
}
