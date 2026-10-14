import { lookup as dnsLookup } from 'node:dns';
import { BlockList, isIP } from 'node:net';

// Server-side request forgery protection. Webhook URLs come from users, and the server
// calls them: without these checks anyone could make it POST to localhost, the private
// network or the cloud metadata service (169.254.169.254) and read the answers in the
// delivery log.
//
// Only public unicast addresses are allowed. Host names are resolved and every address
// must be public, once when the URL is saved and again on every delivery: the request
// connects to the exact address that was checked (guardedLookup), so a DNS answer that
// changes between the check and the connection (DNS rebinding) cannot sneak through.

const PRIVATE_V4 = [
  ['0.0.0.0', 8], // "this network": 0.0.0.0 reaches localhost on Linux
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT (Alibaba Cloud metadata is 100.100.100.200)
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, cloud metadata (AWS, GCP, Azure: 169.254.169.254)
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments (Oracle Cloud metadata is 192.0.0.192)
  ['192.0.2.0', 24], // documentation
  ['192.88.99.0', 24], // 6to4 relay anycast
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved and broadcast
];

const blocked4 = new BlockList();
for (const [net, prefix] of PRIVATE_V4) blocked4.addSubnet(net, prefix, 'ipv4');

// IPv6 is an allow list: global unicast (2000::/3) minus the reserved parts inside it.
// Everything else (::1, ::, fc00::/7 unique local incl. AWS fd00:ec2::254, fe80::/10,
// multicast, discard...) is refused.
const global6 = new BlockList();
global6.addSubnet('2000::', 3, 'ipv6');
const blocked6 = new BlockList();
blocked6.addSubnet('2001::', 23, 'ipv6'); // IETF protocol assignments, Teredo tunnels
blocked6.addSubnet('2001:db8::', 32, 'ipv6'); // documentation
blocked6.addSubnet('3fff::', 20, 'ipv6'); // documentation

/** The eight 16-bit groups of a valid IPv6 address. */
function groups(ip) {
  let s = ip.toLowerCase();
  if (s.includes('.')) {
    // Trailing dotted IPv4 (::ffff:127.0.0.1): rewrite it as two hex groups.
    const at = s.lastIndexOf(':');
    const [a, b, c, d] = s.slice(at + 1).split('.').map(Number);
    s = `${s.slice(0, at + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = s.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const middle = s.includes('::') ? Array(8 - left.length - right.length).fill('0') : [];
  return [...left, ...middle, ...right].map((g) => parseInt(g, 16));
}

const v4 = (hi, lo) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;

/** True only for public unicast IPv4/IPv6 addresses. Anything unparsable is not public. */
export function isPublicAddress(address) {
  const ip = String(address).replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  const family = isIP(ip);
  if (family === 4) return !blocked4.check(ip, 'ipv4');
  if (family !== 6) return false;
  const g = groups(ip);
  // IPv6 forms that carry an IPv4 address are judged by the IPv4 address they reach.
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return isPublicAddress(v4(g[6], g[7])); // ::ffff:a.b.c.d
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return isPublicAddress(v4(g[6], g[7])); // NAT64
  if (g[0] === 0x2002) return isPublicAddress(v4(g[1], g[2])); // 6to4
  return global6.check(ip, 'ipv6') && !blocked6.check(ip, 'ipv6');
}

/** Every address a host name resolves to (the same resolver http.request uses). */
export const resolveAll = (host) =>
  new Promise((resolve, reject) => {
    dnsLookup(host, { all: true, verbatim: true }, (err, list) => (err ? reject(err) : resolve(list.map((a) => a.address))));
  });

const PRIVATE_MESSAGE = 'Must be a public address: localhost, private networks and cloud metadata addresses are refused';

/**
 * Why a webhook URL cannot be used, or null when it can. Messages are safe to show to the
 * user who typed the URL: they never include what a host name resolved to.
 *
 * @param {string} raw
 * @param {{ allowPrivate?: boolean, requireHttps?: boolean, maxLength?: number,
 *   resolve?: boolean, lookup?: (host: string) => Promise<string[]> }} [rules]
 *   resolve: false skips DNS (at send time guardedLookup checks the addresses instead).
 */
export async function urlProblem(raw, { allowPrivate = false, requireHttps = false, maxLength = 2048, resolve = true, lookup = resolveAll } = {}) {
  if (typeof raw !== 'string' || !raw) return 'Is required';
  if (raw.length > maxLength) return `Must be at most ${maxLength} characters`;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return 'Must be a valid URL';
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'Must start with https:// or http://';
  if (requireHttps && url.protocol !== 'https:') return 'Must use https:// (payloads contain your data)';
  if (url.username || url.password) return 'Must not contain a user name or password (put a token in the path or query instead)';
  if (allowPrivate) return null;

  // The URL parser already turned tricks like http://2130706433/ or http://0x7f.1/ into 127.0.0.1.
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (!host) return 'Must have a host name';
  if (host === 'localhost' || host.endsWith('.localhost')) return PRIVATE_MESSAGE;
  if (isIP(host)) return isPublicAddress(host) ? null : PRIVATE_MESSAGE;
  if (!resolve) return null;

  let addresses;
  try {
    addresses = await lookup(host);
  } catch {
    return `Host ${host} could not be found`;
  }
  if (!addresses.length) return `Host ${host} could not be found`;
  return addresses.every(isPublicAddress) ? null : PRIVATE_MESSAGE;
}

/**
 * A `lookup` for http.request / net.connect that refuses host names resolving to any
 * non-public address. The connection then uses the addresses checked here, never a
 * second DNS answer.
 */
export function guardedLookup({ allowPrivate = false } = {}) {
  return (hostname, options, callback) => {
    if (typeof options === 'function') [callback, options] = [options, {}];
    dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err);
      if (!allowPrivate && (!addresses.length || !addresses.every((a) => isPublicAddress(a.address)))) {
        const refused = new Error(`Refused: ${hostname} resolves to a private or reserved address`);
        refused.code = 'ESSRF';
        return callback(refused);
      }
      if (options.all) return callback(null, addresses);
      callback(null, addresses[0].address, addresses[0].family);
    });
  };
}
