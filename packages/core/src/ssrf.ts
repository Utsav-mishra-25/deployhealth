import dns, { type LookupAddress } from 'node:dns';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { DNS_LOOKUP_DEADLINE_MS, DNS_QUERY_TIMEOUT_MS, DNS_QUERY_TRIES } from './limits';

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
 *
 * Both resolve with `resolveHostAddresses()`: A and AAAA asked in parallel on a
 * dns.promises.Resolver with a per-query timeout and a deadline for the whole lookup, so a name
 * server that never answers can't hold a check or a save open (it fails closed). GitHub API calls
 * don't use it: `systemGuardedLookup` keeps them on the system resolver (getaddrinfo), as before.
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

/** The two queries `resolveHostAddresses()` makes; dns.promises.Resolver in production, fakes in tests. */
export interface DnsQueries {
  resolve4(hostname: string): Promise<string[]>;
  resolve6(hostname: string): Promise<string[]>;
  cancel(): void;
}

/** A fresh resolver per lookup (so cancelling one lookup's queries never touches another's). */
export const systemDnsQueries = (): DnsQueries => new dns.promises.Resolver({ timeout: DNS_QUERY_TIMEOUT_MS, tries: DNS_QUERY_TRIES });

/** DNS didn't answer in time. Lookups fail closed on it: no connection, no save. */
export class DnsTimeoutError extends Error {
  readonly code = 'ETIMEOUT';
  constructor(hostname: string) {
    super(`DNS lookup for ${hostname} timed out`);
    this.name = 'DnsTimeoutError';
  }
}

const isTimeout = (err: unknown) => (err as NodeJS.ErrnoException | undefined)?.code === 'ETIMEOUT';

export interface ResolveOptions {
  /** 4 or 6 asks only that family (what net passes as `family`); anything else asks both. */
  family?: number | string;
  queries?: () => DnsQueries;
  deadlineMs?: number;
}

/**
 * A and AAAA in parallel, IPv4 first. One family failing, timing out or answering nothing is fine
 * when the other answers (only answered addresses are ever checked or connected to). With no
 * address at all: a timeout on either family, or the deadline, throws `DnsTimeoutError`;
 * otherwise the first DNS error (ENOTFOUND, ENODATA), so a name that doesn't exist reads as such.
 */
export async function resolveHostAddresses(hostname: string, options: ResolveOptions = {}): Promise<LookupAddress[]> {
  const { queries = systemDnsQueries, deadlineMs = DNS_LOOKUP_DEADLINE_MS } = options;
  const family = options.family === 4 || options.family === 'IPv4' ? 4 : options.family === 6 || options.family === 'IPv6' ? 6 : 0;
  const families: Array<4 | 6> = family === 4 ? [4] : family === 6 ? [6] : [4, 6];
  const q = queries();
  const answers = new Map<4 | 6, string[]>();
  const errors: unknown[] = [];
  const asked = families.map((f) =>
    (f === 4 ? q.resolve4(hostname) : q.resolve6(hostname)).then(
      (addresses) => void answers.set(f, addresses),
      (err: unknown) => void errors.push(err),
    ),
  );
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<'deadline'>((resolve) => {
    timer = setTimeout(() => resolve('deadline'), deadlineMs);
  });
  const outcome = await Promise.race([Promise.all(asked).then(() => 'done' as const), deadline]);
  clearTimeout(timer);
  if (outcome === 'deadline') q.cancel();

  const addresses: LookupAddress[] = families.flatMap((f) => (answers.get(f) ?? []).map((address) => ({ address, family: f })));
  if (addresses.length > 0) return addresses;
  if (outcome === 'deadline' || errors.some(isTimeout)) throw new DnsTimeoutError(hostname);
  const first = errors[0];
  if (first instanceof Error) throw first;
  throw Object.assign(new Error(`No addresses for ${hostname}`), { code: 'ENOTFOUND' });
}

export const resolveAllAddresses: Resolver = async (hostname) => (await resolveHostAddresses(hostname)).map((a) => a.address);

/**
 * Save-time check. Rejects if the host resolves to ANY blocked address. A host that doesn't
 * resolve (yet) is accepted; checks will record DNS failures and the connect-time guard still applies.
 * A lookup that times out is refused (fail closed): the name might resolve to anything.
 */
export async function assertPublicUrl(raw: string, resolve: Resolver = resolveAllAddresses): Promise<URL> {
  const url = parsePublicHttpUrl(raw);
  const host = hostOf(url);
  if (isIP(host)) return url;

  let addresses: string[];
  try {
    addresses = await resolve(host);
  } catch (err) {
    if (isTimeout(err)) throw new BlockedUrlError(`Couldn't look up ${host} in time. Try again in a moment.`);
    return url;
  }
  const blocked = addresses.find(isBlockedAddress);
  if (blocked) throw new BlockedUrlError(`${host} resolves to a private or reserved address (${blocked})`);
  return url;
}

export type LookupAll = (
  hostname: string,
  options: dns.LookupAllOptions,
  callback: (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void,
) => void;

/** `resolveHostAddresses()` in the callback shape a `lookup` uses; local names are refused up front. */
export function createResolverLookupAll(options: Omit<ResolveOptions, 'family'> = {}): LookupAll {
  return (hostname, lookupOptions, callback) => {
    const host = hostname.toLowerCase();
    if (host === 'localhost' || host.endsWith('.localhost')) {
      callback(new BlockedUrlError(`${hostname} is a local address`), []);
      return;
    }
    if (isIP(hostname)) {
      callback(null, [{ address: hostname, family: isIP(hostname) }]);
      return;
    }
    resolveHostAddresses(hostname, { ...options, family: lookupOptions.family }).then(
      (addresses) => callback(null, addresses),
      (err: NodeJS.ErrnoException) => callback(err, []),
    );
  };
}

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

/** Connect-time guard for user-supplied URLs (endpoint checks, alert webhooks): the bounded resolver. */
export const guardedLookup: LookupFunction = createGuardedLookup(createResolverLookupAll());

/**
 * The same guard on the system resolver (getaddrinfo), for GitHub API calls only: they resolve
 * exactly as they did before the bounded resolver, and never go to a user-supplied host.
 */
export const systemGuardedLookup: LookupFunction = createGuardedLookup(dns.lookup as LookupAll);
