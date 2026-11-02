// @effect-diagnostics nodeBuiltinImport:off -- Address parsing and the host's own interfaces come from the OS.
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";

// fork: which addresses this server may POST a push to. A paired device chooses the endpoint, so
// anything that is not a public unicast address (this machine, the LAN, link-local and cloud
// metadata, CGNAT such as Tailscale's) is refused, whether it is written out or a name resolves to it.

type Bytes = ReadonlyArray<number>;

/** `[prefix bytes, prefix length in bits]`. */
type Range = readonly [prefix: Bytes, bits: number];

const v4 = (a: number, b: number, c: number, d: number): Bytes => [a, b, c, d];

const NON_PUBLIC_V4: ReadonlyArray<Range> = [
  [v4(0, 0, 0, 0), 8], // "this network", includes 0.0.0.0
  [v4(10, 0, 0, 0), 8], // RFC 1918
  [v4(100, 64, 0, 0), 10], // CGNAT, Tailscale
  [v4(127, 0, 0, 0), 8], // loopback
  [v4(169, 254, 0, 0), 16], // link-local, cloud metadata
  [v4(172, 16, 0, 0), 12], // RFC 1918
  [v4(192, 0, 0, 0), 24], // IETF protocol assignments
  [v4(192, 0, 2, 0), 24], // documentation
  [v4(192, 88, 99, 0), 24], // 6to4 relay anycast
  [v4(192, 168, 0, 0), 16], // RFC 1918
  [v4(198, 18, 0, 0), 15], // benchmarking
  [v4(198, 51, 100, 0), 24], // documentation
  [v4(203, 0, 113, 0), 24], // documentation
  [v4(224, 0, 0, 0), 4], // multicast
  [v4(240, 0, 0, 0), 4], // reserved, includes the broadcast address
];

const v6 = (...groups: ReadonlyArray<number>): Bytes =>
  groups.flatMap((group) => [group >> 8, group & 0xff]);

/** IPv6 prefixes that are never public. Ones that wrap an IPv4 address are handled separately. */
const NON_PUBLIC_V6: ReadonlyArray<Range> = [
  [v6(0x0100), 64], // discard-only
  [v6(0x2001, 0), 23], // IETF assignments: Teredo, benchmarking, ORCHID and the like
  [v6(0x2001, 0x0db8), 32], // documentation
  [v6(0x3fff), 20], // documentation
  [v6(0x5f00), 16], // segment routing SIDs
  [v6(0x64, 0xff9b, 1), 48], // local-use NAT64
  [v6(0xfc00), 7], // unique local
  [v6(0xfe80), 10], // link-local
  [v6(0xfec0), 10], // site-local, deprecated
  [v6(0xff00), 8], // multicast
];

const inRange = (address: Bytes, [prefix, bits]: Range): boolean => {
  for (let index = 0; index * 8 < bits; index += 1) {
    const remaining = bits - index * 8;
    const mask = remaining >= 8 ? 0xff : (0xff << (8 - remaining)) & 0xff;
    if (((address[index] ?? 0) & mask) !== ((prefix[index] ?? 0) & mask)) return false;
  }
  return true;
};

const parseV4 = (text: string): Bytes | null => {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  const bytes = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN));
  return bytes.every((byte) => byte >= 0 && byte <= 255) ? bytes : null;
};

/** 16 bytes, or null when the text is not an IPv6 address. Zone ids are dropped. */
const parseV6 = (input: string): Bytes | null => {
  const text = input.split("%")[0] ?? "";
  if (NodeNet.isIP(text) !== 6) return null;
  const halves = text.split("::");
  const expand = (half: string): number[] | null => {
    if (half === "") return [];
    const groups: number[] = [];
    for (const group of half.split(":")) {
      if (group.includes(".")) {
        const embedded = parseV4(group);
        if (embedded === null) return null;
        groups.push(((embedded[0] ?? 0) << 8) | (embedded[1] ?? 0));
        groups.push(((embedded[2] ?? 0) << 8) | (embedded[3] ?? 0));
      } else {
        groups.push(Number.parseInt(group, 16));
      }
    }
    return groups;
  };
  const head = expand(halves[0] ?? "");
  const tail = halves.length === 2 ? expand(halves[1] ?? "") : [];
  if (head === null || tail === null) return null;
  const fill = 8 - head.length - tail.length;
  if (fill < 0 || (halves.length === 1 && fill !== 0)) return null;
  return v6(...head, ...new Array<number>(fill).fill(0), ...tail);
};

const startsWith = (address: Bytes, prefix: Bytes) =>
  prefix.every((byte, index) => address[index] === byte);

/** The IPv4 address an IPv6 address carries, if it is one of the forms that do. */
const embeddedV4 = (address: Bytes): Bytes | null => {
  const zeros = (count: number) => address.slice(0, count).every((byte) => byte === 0);
  if (zeros(10) && address[10] === 0xff && address[11] === 0xff) return address.slice(12); // mapped
  if (zeros(12)) return address.slice(12); // compatible, and :: and ::1
  if (startsWith(address, v6(0x64, 0xff9b, 0, 0, 0, 0))) return address.slice(12); // NAT64
  if (address[0] === 0x20 && address[1] === 0x02) return address.slice(2, 6); // 6to4
  return null;
};

/** What `isPublicAddress` needs besides the address: this machine's own addresses. */
export interface AddressPolicy {
  readonly localAddresses: ReadonlyArray<string>;
}

const canonical = (address: string): string => {
  const bytes = parseV4(address) ?? parseV6(address);
  return bytes === null ? address.toLowerCase() : bytes.join(",");
};

/**
 * True only for an address that is public and not one of this machine's.
 * Text that is not an IP address is not public.
 */
export function isPublicAddress(address: string, policy: AddressPolicy): boolean {
  const text = address.replace(/^\[|\]$/g, "");
  const ipv4 = NodeNet.isIP(text) === 4 ? parseV4(text) : null;
  const ipv6 = ipv4 === null ? parseV6(text) : null;
  const bytes = ipv4 ?? ipv6;
  if (bytes === null) return false;
  const key = canonical(text);
  if (policy.localAddresses.some((local) => canonical(local) === key)) return false;
  if (ipv4 !== null) return !NON_PUBLIC_V4.some((range) => inRange(ipv4, range));
  const embedded = embeddedV4(bytes);
  if (embedded !== null) return isPublicAddress(embedded.join("."), policy);
  return !NON_PUBLIC_V6.some((range) => inRange(bytes, range));
}

/** The IP an URL hostname spells out, or null for a name that needs resolving. */
export const literalIp = (hostname: string): string | null => {
  const host = hostname.replace(/^\[|\]$/g, "");
  return NodeNet.isIP(host) === 0 ? null : host;
};

/** Every address on this machine's interfaces, read fresh because they change. */
export const systemLocalAddresses = (): ReadonlyArray<string> =>
  Object.values(NodeOS.networkInterfaces()).flatMap((entries) =>
    (entries ?? []).map((entry) => entry.address),
  );
