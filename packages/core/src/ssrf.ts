import dns, { type LookupAddress } from 'node:dns';
import { BlockList, isIP, type LookupFunction } from 'node:net';

/**
 * SSRF guard for user-supplied URLs (monitored endpoints and alert webhooks).
 *
 * Two layers:
 * 1. `assertPublicUrl()` when a URL is saved: http/https only, no credentials, and the host must
 *    not be, or resolve to, a private/reserved address. Hosts that don't resolve yet are allowed.
 * 2. `guardedLookup` at connect time: a drop-in `lookup` for http(s).request that re-resolves and
 *    refuses blocked addresses. Because the check happens on the address actually connected to,
 *    DNS rebinding (public at save time, private at fetch time) doesn't get through, and every
 *    redirect hop goes through it too.
 */

export class BlockedUrlError extends Error {
  readonly code = 'ERR_BLOCKED_URL';
  constructor(message: string) {
    super(message);
    this.name = 'BlockedUrlError';
  }
}

// One list per family: BlockList also checks an IPv4 address against IPv6 rules (as ::ffff:a.b.c.d),
// so the IPv4-embedding IPv6 ranges are matched by hand below, never added to a list.
const blockedV4 = new BlockList();
const blockedV6 = new BlockList();
const BLOCKED_V4: Array<[string, number]> = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // RFC1918
  ['100.64.0.0', 10], // CGNAT; Alibaba Cloud metadata lives at 100.100.100.200
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, incl. the 169.254.169.254 cloud metadata service
  ['172.16.0.0', 12], // RFC1918
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1 (documentation)
  ['192.168.0.0', 16], // RFC1918
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2 (documentation)
  ['203.0.113.0', 24], // TEST-NET-3 (documentation)
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, incl. 255.255.255.255
];
const BLOCKED_V6: Array<[string, number]> = [
  ['64:ff9b:1::', 48], // local-use NAT64
  ['100::', 64], // discard-only
  ['2001::', 32], // Teredo
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4 (deprecated)
  ['fc00::', 7], // unique local (IPv6 "RFC1918"), incl. AWS IMDS fd00:ec2::254
  ['fe80::', 10], // link-local
  ['fec0::', 10], // site-local (deprecated)
  ['ff00::', 8], // multicast
];
for (const [net, prefix] of BLOCKED_V4) blockedV4.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of BLOCKED_V6) blockedV6.addSubnet(net, prefix, 'ipv6');

/**
 * True for loopback, RFC1918, link-local, metadata, CGNAT, multicast, documentation and other
 * reserved ranges. In IPv6 that includes every address that embeds or tunnels to an IPv4 one
 * (IPv4-compatible, IPv4-mapped, 6to4, Teredo, local-use NAT64), blocked outright; the well-known
 * NAT64 prefix (`64:ff9b::/96`) is unwrapped here and its IPv4 address checked.
 */
export function isBlockedAddress(address: string): boolean {
  const ip = address.replace(/^\[|\]$/g, '').split('%')[0]!;
  const family = isIP(ip);
  if (family === 4) return blockedV4.check(ip, 'ipv4');
  if (family === 6) {
    const groups = ipv6Groups(ip);
    // ::/96 (IPv4-compatible, incl. :: and ::1) and ::ffff:0:0/96 (IPv4-mapped).
    if (groups.slice(0, 5).every((g) => g === 0) && (groups[5] === 0 || groups[5] === 0xffff)) return true;
    // 64:ff9b::/96, the well-known NAT64 prefix: check the IPv4 address it carries.
    if (groups[0] === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every((g) => g === 0)) {
      return blockedV4.check([groups[6]! >> 8, groups[6]! & 255, groups[7]! >> 8, groups[7]! & 255].join('.'), 'ipv4');
    }
    return blockedV6.check(ip, 'ipv6');
  }
  return true; // not an IP at all: refuse rather than guess
}

/** The eight 16-bit groups of an IPv6 address, in any notation (`::`, embedded dotted IPv4). */
function ipv6Groups(ip: string): number[] {
  // The URL parser canonicalises the notation (lowercase, hex instead of a dotted quad, one `::`).
  const canonical = new URL(`http://[${ip}]/`).hostname.slice(1, -1);
  const [head = '', tail] = canonical.split('::') as [string, string | undefined];
  const parse = (part: string) => (part === '' ? [] : part.split(':').map((g) => parseInt(g, 16)));
  const [left, right] = [parse(head), parse(tail ?? '')];
  return tail === undefined ? left : [...left, ...Array<number>(8 - left.length - right.length).fill(0), ...right];
}

/** Hostname without IPv6 brackets. */
function hostOf(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
}

/** Syntactic checks only (no DNS): scheme, credentials, obvious local names, literal IPs. */
export function parsePublicHttpUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new BlockedUrlError('Enter a full URL, e.g. https://api.example.com/health');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new BlockedUrlError('Only http and https URLs are allowed');
  }
  if (url.username || url.password) throw new BlockedUrlError('URLs with credentials are not allowed');

  const host = hostOf(url);
  if (host === 'localhost' || host.endsWith('.localhost')) {
    throw new BlockedUrlError(`${host} is a local address`);
  }
  if (isIP(host) && isBlockedAddress(host)) {
    throw new BlockedUrlError(`${host} is a private or reserved address`);
  }
  return url;
}

export type Resolver = (hostname: string) => Promise<string[]>;

export const resolveAllAddresses: Resolver = async (hostname) =>
  (await dns.promises.lookup(hostname, { all: true, verbatim: true })).map((a) => a.address);

/**
 * Save-time check. Rejects if the host resolves to ANY blocked address. A host that doesn't
 * resolve (yet) is accepted; checks will record DNS failures and the connect-time guard still applies.
 */
export async function assertPublicUrl(raw: string, resolve: Resolver = resolveAllAddresses): Promise<URL> {
  const url = parsePublicHttpUrl(raw);
  const host = hostOf(url);
  if (isIP(host)) return url;

  let addresses: string[];
  try {
    addresses = await resolve(host);
  } catch {
    return url;
  }
  const blocked = addresses.find(isBlockedAddress);
  if (blocked) throw new BlockedUrlError(`${host} resolves to a private or reserved address (${blocked})`);
  return url;
}

type LookupAll = (
  hostname: string,
  options: dns.LookupAllOptions,
  callback: (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void,
) => void;

/**
 * Build a `lookup` for http(s).request / net.connect that refuses to connect to blocked
 * addresses. `lookupAll` is injectable for tests.
 */
export function createGuardedLookup(lookupAll: LookupAll = dns.lookup as LookupAll): LookupFunction {
  const guarded = (
    hostname: string,
    options: dns.LookupOptions,
    callback: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void,
  ) => {
    lookupAll(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err, '', 0);
      const blocked = addresses.find((a) => isBlockedAddress(a.address));
      if (blocked) {
        return callback(new BlockedUrlError(`${hostname} resolves to a private or reserved address (${blocked.address})`), '', 0);
      }
      if (options.all) return callback(null, addresses);
      const first = addresses[0];
      if (!first) return callback(Object.assign(new Error(`No addresses for ${hostname}`), { code: 'ENOTFOUND' }), '', 0);
      callback(null, first.address, first.family);
    });
  };
  return guarded as unknown as LookupFunction;
}

export const guardedLookup: LookupFunction = createGuardedLookup();
