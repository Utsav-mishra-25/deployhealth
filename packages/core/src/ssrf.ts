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

const blockList = new BlockList();
const BLOCKED_V4: Array<[string, number]> = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // RFC1918
  ['100.64.0.0', 10], // CGNAT; Alibaba Cloud metadata lives at 100.100.100.200
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, incl. the 169.254.169.254 cloud metadata service
  ['172.16.0.0', 12], // RFC1918
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.168.0.0', 16], // RFC1918
  ['198.18.0.0', 15], // benchmarking
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, incl. 255.255.255.255
];
const BLOCKED_V6: Array<[string, number]> = [
  ['::', 128], // unspecified
  ['::1', 128], // loopback
  ['fc00::', 7], // unique local (IPv6 "RFC1918"), incl. AWS IMDS fd00:ec2::254
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
];
for (const [net, prefix] of BLOCKED_V4) blockList.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of BLOCKED_V6) blockList.addSubnet(net, prefix, 'ipv6');

/**
 * True for loopback, RFC1918, link-local, metadata, CGNAT, multicast and other reserved ranges.
 * IPv4-mapped IPv6 (`::ffff:10.0.0.1`, any notation) is matched by BlockList itself; NAT64
 * (`64:ff9b::/96`) is unwrapped here.
 */
export function isBlockedAddress(address: string): boolean {
  const ip = address.replace(/^\[|\]$/g, '').split('%')[0]!;
  const family = isIP(ip);
  if (family === 4) return blockList.check(ip, 'ipv4');
  if (family === 6) {
    const nat64 = nat64Embedded(ip);
    if (nat64) return blockList.check(nat64, 'ipv4');
    return blockList.check(ip, 'ipv6');
  }
  return true; // not an IP at all: refuse rather than guess
}

function nat64Embedded(ip: string): string | null {
  // Let the URL parser canonicalise the notation (e.g. 64:ff9b:0:0:0:0:a9fe:a9fe → 64:ff9b::a9fe:a9fe).
  const canonical = new URL(`http://[${ip}]/`).hostname.slice(1, -1);
  const match = /^64:ff9b::(?:([0-9a-f]{1,4}):)?([0-9a-f]{1,4})$/.exec(canonical);
  if (!match) return null;
  const value = (parseInt(match[1] ?? '0', 16) << 16) | parseInt(match[2]!, 16);
  return [24, 16, 8, 0].map((shift) => (value >>> shift) & 255).join('.');
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
