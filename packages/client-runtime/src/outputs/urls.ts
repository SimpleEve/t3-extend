const URL_CANDIDATE_PATTERN = /https?:\/\/[^\s\u0000-\u001f<>"'`\\^{}|]+/gi;

/** Namespace identifiers that file contents print; they are never somewhere to go. */
const NAMESPACE_HOSTS = new Set(["www.w3.org", "schemas.xmlsoap.org", "schemas.microsoft.com"]);

/** A command that lists sockets, hosts or ports prints addresses that are not results. */
const DIAGNOSTIC_COMMAND_PATTERN = /(?:^|[\s;&|(`])(?:ssh|ss|netstat|lsof|nmap)(?=$|[\s;&|)`])/;

/** An output with this many distinct URLs is a listing or a log, not a result. */
export const COMMAND_OUTPUT_URL_LIMIT = 4;

function trimUrlEnd(candidate: string): string {
  let parentheses = 0;
  let brackets = 0;
  for (const character of candidate) {
    if (character === "(") parentheses += 1;
    if (character === ")") parentheses -= 1;
    if (character === "[") brackets += 1;
    if (character === "]") brackets -= 1;
  }
  let end = candidate.length;
  while (end > 0) {
    const character = candidate[end - 1]!;
    if (character === ")" && parentheses < 0) parentheses += 1;
    else if (character === "]" && brackets < 0) brackets += 1;
    else if (!".,;:!?*".includes(character)) break;
    end -= 1;
  }
  return candidate.slice(0, end);
}

/** The URL as one stable string, or null for anything that is not a real http(s) address. */
function normalizeOutputUrl(candidate: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (parsed.hostname.length === 0 || NAMESPACE_HOSTS.has(parsed.hostname)) return null;
  const href = parsed.href;
  return parsed.pathname === "/" && parsed.search === "" && parsed.hash === ""
    ? href.replace(/\/$/, "")
    : href;
}

/** Distinct http(s) URLs in the order they appear. */
export function extractHttpUrls(text: string): string[] {
  if (!text.includes("http")) return [];
  const urls = new Set<string>();
  for (const match of text.matchAll(URL_CANDIDATE_PATTERN)) {
    const url = normalizeOutputUrl(trimUrlEnd(match[0]));
    if (url !== null) urls.add(url);
  }
  return [...urls];
}

export function isDiagnosticCommand(command: string): boolean {
  return DIAGNOSTIC_COMMAND_PATTERN.test(command);
}

/** URLs a command printed, unless the command or the size of its output says they are noise. */
export function commandOutputUrls(command: string, output: string | undefined): string[] {
  if (output === undefined || output.length === 0 || isDiagnosticCommand(command)) return [];
  const urls = extractHttpUrls(output);
  return urls.length >= COMMAND_OUTPUT_URL_LIMIT ? [] : urls;
}
