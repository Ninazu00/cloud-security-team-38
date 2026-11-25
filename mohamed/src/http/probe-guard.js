// Probes answer anyone who can open a connection. That is fine for the load
// balancer and wrong for the internet: /readyz reports whether the database is
// reachable and how slow it is, and neither probe is rate limited or
// authenticated, so a stranger gets unlimited free information.
//
// This guard keeps them reachable only from a private address, decided on the
// TCP peer rather than on `req.ip`.
//
// Why the socket and not the header: `req.ip` comes from X-Forwarded-For, which
// any caller who reaches the process directly can set. Measured:
//
//   no header      -> req.ip 127.0.0.1
//   XFF 10.20.0.5  -> req.ip 10.20.0.5     (socket still 127.0.0.1)
//
// So an allow-list keyed on `req.ip` would be a lock whose key anyone can print.
// `req.socket.remoteAddress` is the peer of the actual TCP connection: behind
// the load balancer it is the balancer, and for a direct caller it is the
// caller. It cannot be forged.
//
// What this does not do: it does not stop a caller who reaches the load
// balancer from asking for /readyz. The balancer forwards the path like any
// other, so that has to be closed at the balancer (a listener rule answering
// the probe paths with a fixed response). This guard closes the other door -
// traffic that bypasses the balancer entirely.

import net from 'node:net';

import { notFound } from '../errors.js';

// Private ranges only: the load balancer's network interfaces live inside the
// VPC, and so does every task. A public address is not eligible by definition.
const DEFAULT_ALLOWED = [
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '127.0.0.0/8',
  '::1/128',
  'fc00::/7',
];

function parseCidr(text) {
  const [address, bitsText] = String(text).trim().split('/');
  const version = net.isIP(address);
  if (!version) throw new Error(`PROBE_ALLOW_CIDRS: "${text}" is not a CIDR with an IP address.`);

  const bits = bitsText === undefined ? (version === 4 ? 32 : 128) : Number(bitsText);
  if (!Number.isInteger(bits) || bits < 0 || bits > (version === 4 ? 32 : 128)) {
    throw new Error(`PROBE_ALLOW_CIDRS: "${text}" has an out-of-range prefix length.`);
  }

  return { address, bits, version };
}

// Expand an IPv4 address to a 32-bit integer. IPv6 is only ever matched by
// exact string comparison against ::1 and the fc00::/7 prefix, because a full
// 128-bit comparison is not worth writing for six fixed ranges.
function ipv4ToInt(address) {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return null;
  }
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

// Node reports IPv4 peers on a dual-stack socket as "::ffff:10.20.0.5".
function normalisePeer(peer) {
  if (!peer) return '';
  return peer.startsWith('::ffff:') ? peer.slice(7) : peer;
}

export function createProbeGuard({ cidrs = DEFAULT_ALLOWED } = {}) {
  const ranges = cidrs.map(parseCidr);
  const v4 = ranges.filter((range) => range.version === 4);
  const v6 = ranges.filter((range) => range.version === 6);

  function isAllowed(peer) {
    const address = normalisePeer(peer);
    if (!address) return false;

    const version = net.isIP(address);
    if (version === 4) {
      const value = ipv4ToInt(address);
      if (value === null) return false;
      return v4.some((range) => {
        const base = ipv4ToInt(range.address);
        if (base === null) return false;
        const mask = range.bits === 0 ? 0 : (0xffffffff << (32 - range.bits)) >>> 0;
        return (value & mask) === (base & mask);
      });
    }

    if (version === 6) {
      if (address === '::1') return v6.some((range) => range.address === '::1');
      // fc00::/7 covers the two private IPv6 prefixes. The first hextet holds the
      // first two bytes, so the prefix test is on its high byte.
      const firstHextet = parseInt(address.split(':')[0] || '0', 16);
      const highByte = (firstHextet >> 8) & 0xff;
      return v6.some(
        (range) => range.address !== '::1' && range.bits === 7 && (highByte & 0xfe) === 0xfc,
      );
    }

    return false;
  }

  // Answering 404, not 403: a probe that does not exist is less interesting to
  // a scanner than one that exists and refuses, and 404 is what an unknown path
  // returns anyway, so the guard is indistinguishable from the route not being
  // there.
  function guard(req, _res, next) {
    if (isAllowed(req.socket?.remoteAddress)) return next();
    return next(notFound('NOT_FOUND', 'No such endpoint.'));
  }

  return { guard, isAllowed };
}
