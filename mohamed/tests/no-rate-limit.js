/**
 * The HTTP suites make dozens of requests per second from one address, which is
 * exactly what the rate limiter exists to refuse.
 *
 * Passing this in place of the real limiter keeps those suites testing what they
 * are about. The limiter has its own suite, where the limit is three and the
 * window is a second, so the 429 path is proved rather than assumed.
 */

export function noRateLimit(_req, _res, next) {
  return next();
}
