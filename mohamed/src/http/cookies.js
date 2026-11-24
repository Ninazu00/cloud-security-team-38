/**
 * The refresh cookie, in one place.
 *
 * Written by hand rather than with `cookie-parser` + `cookie`: it is 25 lines,
 * and the attributes here are security-relevant — a dependency that changes its
 * defaults silently is worse than code we can read.
 *
 *   __Secure-refresh   the double-underscore prefix makes the browser refuse the
 *                      cookie if it is ever set without `Secure`, so a staging
 *                      deployment over plain HTTP cannot quietly weaken it.
 *   HttpOnly           JavaScript cannot read it, so an XSS bug steals a page, not
 *                      a week-long session.
 *   SameSite=Strict    it is not sent on cross-site navigations, which is what makes
 *                      CSRF on /api/auth/refresh a non-event. The cost: the frontend
 *                      must be same-site as the API (a Vercel frontend calling an
 *                      api.example.com backend is *same-site*, a different registrable
 *                      domain is not).
 *   Path=/api/auth     it is not attached to catalogue requests that do not need it,
 *                      so it is not exposed to every handler in the service.
 */

export const REFRESH_COOKIE = '__Secure-refresh';

/** Reads one cookie header into a map. Internal: `readRefreshCookie` is the API. */
function parseCookies(header) {
  const jar = new Map();
  if (typeof header !== 'string' || header.length === 0) return jar;

  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const name = part.slice(0, index).trim();
    if (name.length === 0) continue;
    jar.set(name, decodeValue(part.slice(index + 1).trim()));
  }

  return jar;
}

/**
 * A cookie value is untrusted input, and `decodeURIComponent` throws on a malformed
 * escape such as `%ZZ`. Left unguarded, any visitor could turn a 401 into a 500 by
 * sending a broken cookie header — so a value that cannot be decoded is kept as
 * sent, which then simply fails to match a token hash.
 */
function decodeValue(raw) {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export function readRefreshCookie(req) {
  return parseCookies(req.headers.cookie).get(REFRESH_COOKIE) ?? null;
}

export function refreshCookie(value, maxAgeSeconds) {
  return serialize(REFRESH_COOKIE, value, maxAgeSeconds);
}

/** Same name, same attributes, zero lifetime: the browser drops it. */
export function clearedRefreshCookie() {
  return serialize(REFRESH_COOKIE, '', 0);
}

function serialize(name, value, maxAgeSeconds) {
  return [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/api/auth',
    'HttpOnly',
    'Secure',
    'SameSite=Strict',
    `Max-Age=${Math.max(0, Math.trunc(maxAgeSeconds))}`,
  ].join('; ');
}
