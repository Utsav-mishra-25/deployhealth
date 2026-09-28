import type { LookupAddress } from 'node:dns';
import { describe, expect, it } from 'vitest';
import {
  assertPublicUrl,
  BlockedUrlError,
  createGuardedLookup,
  guardedLookup,
  isBlockedAddress,
  parsePublicHttpUrl,
} from '../src/ssrf';

describe('isBlockedAddress', () => {
  it.each([
    ['127.0.0.1', 'loopback'],
    ['127.255.0.9', 'loopback range'],
    ['10.1.2.3', 'RFC1918 10/8'],
    ['172.16.0.1', 'RFC1918 172.16/12'],
    ['172.31.255.255', 'RFC1918 172.16/12 top'],
    ['192.168.1.1', 'RFC1918 192.168/16'],
    ['169.254.169.254', 'cloud metadata'],
    ['169.254.10.10', 'link-local'],
    ['100.100.100.200', 'Alibaba metadata (CGNAT)'],
    ['0.0.0.0', 'unspecified'],
    ['224.0.0.1', 'multicast'],
    ['255.255.255.255', 'broadcast'],
    ['::1', 'IPv6 loopback'],
    ['::', 'IPv6 unspecified'],
    ['fe80::1', 'IPv6 link-local'],
    ['fd00:ec2::254', 'AWS IMDS IPv6 (unique local)'],
    ['fc00::1', 'IPv6 unique local'],
    ['::ffff:10.0.0.1', 'IPv4-mapped private'],
    ['::ffff:7f00:1', 'IPv4-mapped loopback, hex'],
    ['64:ff9b::a9fe:a9fe', 'NAT64 of 169.254.169.254'],
    ['64:ff9b::127.0.0.1', 'NAT64 of loopback, dotted'],
    ['[::1]', 'bracketed'],
    ['not-an-ip', 'not an IP'],
  ])('blocks %s (%s)', (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each(['8.8.8.8', '1.1.1.1', '172.32.0.1', '192.169.0.1', '100.128.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8', '64:ff9b::808:808'])(
    'allows public address %s',
    (address) => {
      expect(isBlockedAddress(address)).toBe(false);
    },
  );
});

describe('parsePublicHttpUrl', () => {
  it('accepts http and https URLs with public or unresolved hosts', () => {
    expect(parsePublicHttpUrl('https://api.example.com/health').href).toBe('https://api.example.com/health');
    expect(parsePublicHttpUrl('  http://8.8.8.8:8080/  ').hostname).toBe('8.8.8.8');
  });

  it.each([
    ['ftp://example.com/', 'Only http and https'],
    ['file:///etc/passwd', 'Only http and https'],
    ['javascript:alert(1)', 'Only http and https'],
    ['gopher://example.com', 'Only http and https'],
    ['https://user:pass@example.com', 'credentials'],
    ['not a url', 'Enter a full URL'],
    ['http://localhost:3000', 'local address'],
    ['http://app.localhost', 'local address'],
    ['http://127.0.0.1/', 'private or reserved'],
    ['http://127.1/', 'private or reserved'],
    ['http://2130706433/', 'private or reserved'],
    ['http://0x7f.1/', 'private or reserved'],
    ['http://[::1]:8080/', 'private or reserved'],
    ['http://[::ffff:7f00:1]/', 'private or reserved'],
    ['http://169.254.169.254/latest/meta-data/', 'private or reserved'],
    ['http://10.0.0.5/', 'private or reserved'],
  ])('rejects %s', (url, message) => {
    expect(() => parsePublicHttpUrl(url)).toThrow(BlockedUrlError);
    expect(() => parsePublicHttpUrl(url)).toThrow(message);
  });
});

describe('assertPublicUrl (save time)', () => {
  const resolvesTo = (...addresses: string[]) => async () => addresses;

  it('rejects hostnames that resolve to a blocked address', async () => {
    await expect(assertPublicUrl('https://internal.example.com', resolvesTo('10.0.0.5'))).rejects.toThrow(
      'internal.example.com resolves to a private or reserved address (10.0.0.5)',
    );
  });

  it('rejects when ANY resolved address is blocked', async () => {
    await expect(assertPublicUrl('https://mixed.example.com', resolvesTo('93.184.215.14', '127.0.0.1'))).rejects.toThrow(
      BlockedUrlError,
    );
  });

  it('accepts hostnames that resolve only to public addresses', async () => {
    const url = await assertPublicUrl('https://example.com/health', resolvesTo('93.184.215.14', '2606:2800:21f:cb07:6820:80da:af6b:8b2c'));
    expect(url.pathname).toBe('/health');
  });

  it('accepts hosts that do not resolve yet', async () => {
    const failing = async () => {
      throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
    };
    await expect(assertPublicUrl('https://not-live-yet.example', failing)).resolves.toBeInstanceOf(URL);
  });

  it('still applies the syntactic checks', async () => {
    await expect(assertPublicUrl('ftp://example.com', resolvesTo('93.184.215.14'))).rejects.toThrow('Only http and https');
  });
});

describe('guarded lookup (connect time)', () => {
  const fakeLookup =
    (addresses: LookupAddress[]) =>
    (_host: string, _opts: object, cb: (err: NodeJS.ErrnoException | null, a: LookupAddress[]) => void) =>
      cb(null, addresses);

  function lookupOnce(lookup: ReturnType<typeof createGuardedLookup>, host: string, options: object) {
    return new Promise<{ err: Error | null; address: unknown; family?: number }>((resolve) => {
      (lookup as unknown as (h: string, o: object, cb: (...args: unknown[]) => void) => void)(host, options, (err, address, family) =>
        resolve({ err: err as Error | null, address, family: family as number | undefined }),
      );
    });
  }

  it('returns the first public address, or all of them when asked', async () => {
    const lookup = createGuardedLookup(fakeLookup([{ address: '93.184.215.14', family: 4 }, { address: '2606:2800::1', family: 6 }]));
    expect(await lookupOnce(lookup, 'example.com', {})).toEqual({ err: null, address: '93.184.215.14', family: 4 });
    const all = await lookupOnce(lookup, 'example.com', { all: true });
    expect(all.err).toBeNull();
    expect(all.address).toHaveLength(2);
  });

  it('refuses to connect when DNS now answers with a private address (rebinding)', async () => {
    const lookup = createGuardedLookup(fakeLookup([{ address: '192.168.0.10', family: 4 }]));
    const { err } = await lookupOnce(lookup, 'rebind.example.com', {});
    expect(err).toBeInstanceOf(BlockedUrlError);
    expect(err?.message).toContain('192.168.0.10');
  });

  it('blocks localhost through the real resolver', async () => {
    const { err } = await lookupOnce(guardedLookup, 'localhost', {});
    expect(err).toBeInstanceOf(BlockedUrlError);
  });
});
