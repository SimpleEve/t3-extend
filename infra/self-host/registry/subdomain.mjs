// Device display names and computer subdomains. Spec: research/self-host-device-keys.md 3.1 and Q9.
import * as NodeCrypto from "node:crypto";

const { randomBytes } = NodeCrypto;

export const NAME_MAX_CODE_POINTS = 40;
export const SUBDOMAIN_BASE_MAX = 30;
export const SUBDOMAIN_ATTEMPTS = 20;

export const RESERVED_SUBDOMAINS = new Set([
  "ntfy",
  "www",
  "api",
  "registry",
  "frp",
  "admin",
  "mail",
  "t3x",
]);

// Control characters, plus the line and paragraph separators.
const FORBIDDEN_IN_NAME = /[\p{Cc}\u2028\u2029]/u;

/** NFC, 1-40 code points, no control characters. Returns null when invalid. */
export function normalizeDeviceName(input) {
  if (typeof input !== "string") return null;
  const name = input.normalize("NFC").trim();
  const length = [...name].length;
  if (length < 1 || length > NAME_MAX_CODE_POINTS || FORBIDDEN_IN_NAME.test(name)) return null;
  return name;
}

/** Names are unique case-insensitively among devices that have not been removed. */
export function nameKey(name) {
  return name.toLowerCase();
}

/** `name`, `name (2)`, `name (3)`... shortened so the suffix still fits in 40 code points. */
export function* nameCandidates(name) {
  yield name;
  for (let n = 2; n < 1000; n += 1) {
    const suffix = ` (${n})`;
    const room = NAME_MAX_CODE_POINTS - suffix.length;
    yield `${[...name].slice(0, room).join("")}${suffix}`;
  }
}

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

export function randomBase32(length) {
  const bytes = randomBytes(length);
  let out = "";
  for (const byte of bytes) out += BASE32[byte % 32];
  return out;
}

/** NFC, lowercase, anything outside [a-z0-9] becomes "-", collapse, trim, 30 characters at most. */
export function deriveSubdomainBase(displayName) {
  const slug = displayName
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SUBDOMAIN_BASE_MAX)
    .replace(/-+$/g, "");
  return slug === "" ? `computer-${randomBase32(4)}` : slug;
}

export function isReservedSubdomain(label) {
  return RESERVED_SUBDOMAINS.has(label) || label.startsWith("_") || label.startsWith("xn--");
}

/**
 * Picks the first free subdomain: the derived base, then base-2, base-3...
 * `isTaken` must consult both live devices and tombstones. Returns null after 20 attempts.
 */
export function allocateSubdomain(displayName, isTaken) {
  const base = deriveSubdomainBase(displayName);
  for (let attempt = 1; attempt <= SUBDOMAIN_ATTEMPTS; attempt += 1) {
    const candidate = attempt === 1 ? base : `${base}-${attempt}`;
    if (!isReservedSubdomain(candidate) && !isTaken(candidate)) return candidate;
  }
  return null;
}
