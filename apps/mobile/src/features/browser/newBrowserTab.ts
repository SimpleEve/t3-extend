import {
  CONFIGURED_LOCAL_SERVER_URLS_MAX_ITEMS,
  PREVIEW_URL_MAX_LENGTH,
  type DiscoveredLocalServerList,
  type ProjectScript,
} from "@t3tools/contracts";
import {
  isLoopbackHost,
  isPreviewUrlNormalizationError,
  resolveAddressBarInput,
} from "@t3tools/shared/preview";

export type BrowserAddress =
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly reason: "empty" | "invalid" | "unsupported" };

// Resolve through the address bar's search fallback, then treat a search as a typo.
const NO_SEARCH = "about:search?%s";

/**
 * Same rules as the web address bar, minus search: the page opens on the host,
 * so `localhost:5173` gets `http://`, other hosts get `https://`, and
 * non-web schemes such as `file:` and `javascript:` are refused.
 */
export function resolveBrowserAddress(input: string): BrowserAddress {
  const trimmed = input.trim();
  if (trimmed.length === 0) return { ok: false, reason: "empty" };
  let url: string;
  try {
    url = resolveAddressBarInput(trimmed, NO_SEARCH);
  } catch (error) {
    if (isPreviewUrlNormalizationError(error) && error.reason === "unsupported-protocol") {
      return { ok: false, reason: "unsupported" };
    }
    return { ok: false, reason: "invalid" };
  }
  if (url.startsWith("about:search?") || url.length > PREVIEW_URL_MAX_LENGTH) {
    return { ok: false, reason: "invalid" };
  }
  return { ok: true, url };
}

export interface PreviewUrlTarget {
  readonly name: string;
  readonly url: string;
}

/** Project scripts' Preview URLs on the host's loopback, deduplicated and bounded like web. */
export function projectPreviewTargets(
  scripts: ReadonlyArray<ProjectScript>,
): ReadonlyArray<PreviewUrlTarget> {
  const targets: PreviewUrlTarget[] = [];
  const seen = new Set<string>();
  for (const script of scripts) {
    const raw = script.previewUrl;
    if (!raw || raw.length > PREVIEW_URL_MAX_LENGTH || raw.trim() !== raw) continue;
    try {
      const url = new URL(raw);
      if (url.protocol !== "http:" && url.protocol !== "https:") continue;
      if (!isLoopbackHost(url.hostname)) continue;
      url.hash = "";
      if (seen.has(url.href)) continue;
      seen.add(url.href);
      targets.push({ name: script.name, url: raw });
    } catch {
      continue;
    }
    if (targets.length >= CONFIGURED_LOCAL_SERVER_URLS_MAX_ITEMS) break;
  }
  return targets;
}

export interface LocalServerRow {
  readonly key: string;
  readonly url: string;
  readonly host: string;
  readonly port: number;
  readonly processName: string | null;
  /** The project script whose Preview URL this server answers. */
  readonly scriptName: string | null;
}

function serverKey(host: string, port: number) {
  const normalized = host.toLowerCase();
  return `${isLoopbackHost(normalized) ? "loopback" : normalized}:${port}`;
}

function loopbackPort(url: URL) {
  if (url.port) return Number.parseInt(url.port, 10);
  return url.protocol === "http:" ? 80 : 443;
}

/** Live servers only, Preview URLs first, then by port. */
export function localServerRows(
  list: DiscoveredLocalServerList | null,
  targets: ReadonlyArray<PreviewUrlTarget>,
): ReadonlyArray<LocalServerRow> {
  const byKey = new Map<string, PreviewUrlTarget>();
  for (const target of targets) {
    const url = new URL(target.url);
    const key = serverKey(url.hostname, loopbackPort(url));
    if (!byKey.has(key)) byKey.set(key, target);
  }
  const rows = (list?.servers ?? []).map((server): LocalServerRow => {
    const key = serverKey(server.host, server.port);
    return {
      key,
      // The server probes Preview URLs itself, so its URL already carries their path.
      url: server.url,
      host: server.host,
      port: server.port,
      processName: server.processName,
      scriptName: byKey.get(key)?.name ?? null,
    };
  });
  return rows.sort(
    (a, b) => Number(a.scriptName === null) - Number(b.scriptName === null) || a.port - b.port,
  );
}
