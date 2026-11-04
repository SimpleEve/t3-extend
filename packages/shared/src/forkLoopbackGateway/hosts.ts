// fork: which hosts Chromium sends to the forwarding proxy, and the display-only rewrite of
// unspecified addresses (research/remote-loopback-forwarding.md 1.2). The UI and the desktop main
// process share this one function; the server dials loopback only, whatever it is asked.

const IPV4_OCTET = /^(?:0|[1-9]\d{0,2})$/u;
const LOCALHOST_NAME = /^(?:[a-z0-9_-]+\.)*localhost$/u;

const parseIpv4 = (host: string): ReadonlyArray<number> | null => {
  const parts = host.split(".");
  if (parts.length !== 4 || !parts.every((part) => IPV4_OCTET.test(part))) return null;
  const octets = parts.map(Number);
  return octets.every((octet) => octet <= 255) ? octets : null;
};

const expandGroups = (groups: ReadonlyArray<string>, allowQuad: boolean): Array<number> | null => {
  const hextets: Array<number> = [];
  for (const [index, group] of groups.entries()) {
    if (allowQuad && index === groups.length - 1 && group.includes(".")) {
      const quad = parseIpv4(group);
      if (quad === null) return null;
      hextets.push((quad[0]! << 8) | quad[1]!, (quad[2]! << 8) | quad[3]!);
    } else if (/^[\da-f]{1,4}$/u.test(group)) {
      hextets.push(Number.parseInt(group, 16));
    } else {
      return null;
    }
  }
  return hextets;
};

/** Eight hextets of an IPv6 literal (without brackets), or `null`. A trailing dotted quad counts. */
const parseIpv6 = (host: string): ReadonlyArray<number> | null => {
  if (!host.includes(":")) return null;
  const halves = host.split("::");
  if (halves.length > 2) return null;
  const groups = (half: string | undefined) =>
    half === undefined || half === "" ? [] : half.split(":");
  const head = expandGroups(groups(halves[0]), halves.length === 1);
  const tail = expandGroups(groups(halves[1]), true);
  if (head === null || tail === null) return null;
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  return [...head, ...Array.from({ length: missing }, () => 0), ...tail];
};

/** The host as `URL.hostname` spells it: lower case, IPv6 in brackets, at most one trailing dot. */
const hostBody = (host: string): string | null => {
  let body = host.toLowerCase();
  if (body.startsWith("[") && body.endsWith("]")) body = body.slice(1, -1);
  else if (body.includes("[") || body.includes("]")) return null;
  if (body.endsWith(".")) body = body.slice(0, -1);
  return body === "" || body.endsWith(".") ? null : body;
};

/**
 * Exactly what Chromium treats as loopback: `localhost` and `*.localhost` (one optional trailing
 * dot), `127.0.0.0/8` in canonical dotted form, `::1`, and `::ffff:127.x.x.x` in either spelling.
 * `0.0.0.0`, `::`, `localhost.localdomain` and anything with a port, userinfo or zone are false.
 */
export const isLoopbackGatewayHost = (host: string): boolean => {
  const body = hostBody(host);
  if (body === null) return false;
  if (body === "localhost" || body.endsWith(".localhost")) return LOCALHOST_NAME.test(body);
  const quad = parseIpv4(body);
  if (quad !== null) return quad[0] === 127;
  const hextets = parseIpv6(body);
  if (hextets === null) return false;
  if (hextets.slice(0, 7).every((hextet) => hextet === 0) && hextets[7] === 1) return true;
  return (
    hextets.slice(0, 5).every((hextet) => hextet === 0) &&
    hextets[5] === 0xffff &&
    hextets[6]! >> 8 === 127
  );
};

/**
 * `localhost` for `0.0.0.0` and `::` (any spelling), the input otherwise. For showing a URL a dev
 * server printed or opening a known preview address; a page that hard-codes `0.0.0.0` is not
 * forwarded. It is not a security decision: use `isLoopbackGatewayHost` for those.
 */
export const displayHostForUnspecified = (host: string): string => {
  const body = hostBody(host);
  if (body === null) return host;
  const quad = parseIpv4(body);
  if (quad !== null) return quad.every((octet) => octet === 0) ? "localhost" : host;
  const hextets = parseIpv6(body);
  return hextets !== null && hextets.every((hextet) => hextet === 0) ? "localhost" : host;
};

/** `displayHostForUnspecified` for a whole URL; anything that is not an `http(s)` URL comes back as is. */
export const displayUrlForUnspecified = (url: string): string => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return url;
  const host = displayHostForUnspecified(parsed.hostname);
  if (host === parsed.hostname) return url;
  parsed.hostname = host;
  return parsed.toString();
};
