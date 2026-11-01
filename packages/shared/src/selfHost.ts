/**
 * Self-hosted connection: public HTTPS origins the owner puts in front of an
 * environment (for example frps + Caddy on their own VPS), and the desktop's
 * optional managed tunnel command. Shared by server, desktop main, and web.
 */

/**
 * A public URL is an HTTPS origin with no path, query, fragment, or
 * credentials. The environment must sit at an origin's root (pairing and
 * routes drop the path), and plain HTTP would send bearer tokens in the clear.
 */
export function normalizePublicUrl(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0 || !URL.canParse(trimmed)) return null;
  const url = new URL(trimmed);
  if (url.protocol !== "https:" || url.hostname.length === 0) return null;
  if (url.username !== "" || url.password !== "") return null;
  if ((url.pathname !== "" && url.pathname !== "/") || url.search !== "" || url.hash !== "") {
    return null;
  }
  return `${url.origin}/`;
}

/** Normalizes and dedupes, dropping entries that are not valid public URLs. */
export function normalizePublicUrls(values: Iterable<string>): ReadonlyArray<string> {
  const result: Array<string> = [];
  for (const value of values) {
    const normalized = normalizePublicUrl(value);
    if (normalized !== null && !result.includes(normalized)) result.push(normalized);
  }
  return result;
}

/** `T3CODE_PUBLIC_URLS`: comma- or whitespace-separated HTTPS origins. */
export const PUBLIC_URLS_ENV = "T3CODE_PUBLIC_URLS";
/** Where the server reads saved public URLs; desktop points it at its own settings file. */
export const PUBLIC_URLS_FILE_ENV = "T3CODE_PUBLIC_URLS_FILE";
export const PUBLIC_URLS_FILE_NAME = "public-urls.json";

export function parsePublicUrlList(value: string | undefined): ReadonlyArray<string> {
  return value === undefined ? [] : normalizePublicUrls(value.split(/[\s,]+/u));
}

/** The JSON document at `PUBLIC_URLS_FILE_ENV`; unreadable or invalid content means none. */
export function parsePublicUrlsDocument(raw: string): ReadonlyArray<string> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return [];
    const urls = (parsed as { readonly urls?: unknown }).urls;
    return Array.isArray(urls)
      ? normalizePublicUrls(urls.filter((url): url is string => typeof url === "string"))
      : [];
  } catch {
    return [];
  }
}

export function encodePublicUrlsDocument(urls: ReadonlyArray<string>): string {
  return `${JSON.stringify({ urls: normalizePublicUrls(urls) }, null, 2)}\n`;
}

export type ManagedTunnelStatus = "stopped" | "starting" | "running" | "backing-off" | "failed";

export interface ManagedTunnelState {
  readonly command: string;
  readonly enabled: boolean;
  readonly status: ManagedTunnelStatus;
  readonly pid: number | null;
  readonly restarts: number;
  /** Last error or exit reason, already bounded for display. */
  readonly lastError: string | null;
  /** Recent output lines, newest last. */
  readonly recentOutput: ReadonlyArray<string>;
}

export interface SelfHostState {
  readonly publicUrls: ReadonlyArray<string>;
  /** Origins from `T3CODE_DESKTOP_HTTPS_ENDPOINTS` / `T3CODE_PUBLIC_URLS`, read-only here. */
  readonly environmentPublicUrls: ReadonlyArray<string>;
  readonly tunnel: ManagedTunnelState;
}

/**
 * Exposed by the desktop preload as `window.t3xSelfHostBridge`. Only the local
 * desktop renderer has it; no RPC reaches the tunnel command, so a remote
 * client can never choose what runs on this machine.
 */
export interface SelfHostBridge {
  readonly getState: () => Promise<SelfHostState>;
  readonly setPublicUrls: (urls: ReadonlyArray<string>) => Promise<SelfHostState>;
  readonly setTunnel: (input: {
    readonly command: string;
    readonly enabled: boolean;
  }) => Promise<SelfHostState>;
  readonly restartTunnel: () => Promise<SelfHostState>;
  readonly onState: (listener: (state: SelfHostState) => void) => () => void;
}
