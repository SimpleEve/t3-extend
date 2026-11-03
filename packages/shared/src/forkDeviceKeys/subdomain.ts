// fork: display names and subdomain derivation (design 3.1 / Q9). Mirrors registry/subdomain.mjs.
const NAME_MAX_CODE_POINTS = 40;
const SUBDOMAIN_BASE_MAX = 30;
const RESERVED = new Set(["ntfy", "www", "api", "registry", "frp", "admin", "mail", "t3x"]);
const FORBIDDEN_IN_NAME = /[\p{Cc}\u2028\u2029]/u;
const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/** NFC, 1-40 code points, no control characters. Null when invalid. */
export const normalizeDeviceName = (input: unknown): string | null => {
  if (typeof input !== "string") return null;
  const name = input.normalize("NFC").trim();
  const length = [...name].length;
  if (length < 1 || length > NAME_MAX_CODE_POINTS || FORBIDDEN_IN_NAME.test(name)) return null;
  return name;
};

export const isReservedSubdomain = (label: string): boolean =>
  RESERVED.has(label) || label.startsWith("_") || label.startsWith("xn--");

/** `randomSuffix` stands in for `computer-<4 base32>` when the name has no usable characters. */
export const deriveSubdomainBase = (
  displayName: string,
  randomSuffix: () => string = () =>
    Array.from(globalThis.crypto.getRandomValues(new Uint8Array(4)), (b) => BASE32[b % 32]).join(
      "",
    ),
): string => {
  const slug = displayName
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SUBDOMAIN_BASE_MAX)
    .replace(/-+$/g, "");
  return slug === "" ? `computer-${randomSuffix()}` : slug;
};
