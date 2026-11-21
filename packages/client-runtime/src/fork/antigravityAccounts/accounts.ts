import type { ServerProvider } from "@t3tools/contracts";

// fork: the saved Google accounts of a separate Antigravity sign-in, as web and mobile list them.

export interface AntigravityAccountRow {
  readonly id: string;
  /** Absent when the saved sign-in carries no email; the caller labels it by position. */
  readonly email: string | null;
  readonly current: boolean;
  /** When the account's quota is back, as an ISO time; null while it has quota. */
  readonly exhaustedUntil: string | null;
  readonly position: number;
}

/** Nothing for other providers, and nothing before an instance has a saved account. */
export function antigravityAccountRows(
  provider: Pick<ServerProvider, "driver" | "auth">,
): ReadonlyArray<AntigravityAccountRow> {
  if (provider.driver !== "antigravity") return [];
  return (provider.auth.accounts ?? []).map((account, index) => ({
    id: account.id,
    email: account.email ?? null,
    current: account.current,
    exhaustedUntil: account.exhaustedUntil ?? null,
    position: index + 1,
  }));
}

/** A short local date and time for when quota returns, in the language the caller names. */
export function formatAntigravityReset(iso: string, locale: string | undefined): string {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return iso;
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(time);
}

/** `someone@example.com` as `s•••@example.com`, for screens that hide an email until it is tapped. */
export function maskAntigravityAccountEmail(email: string): string {
  const at = email.lastIndexOf("@");
  return at < 1 ? "•••" : `${email.slice(0, 1)}•••${email.slice(at)}`;
}
