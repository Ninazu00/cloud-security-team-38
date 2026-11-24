/**
 * Request rate limiting, in process.
 *
 * The load balancer cannot do this. An ALB has no rate rule — the only AWS place
 * to express "N requests per minute per client" in front of an ALB is WAF, and
 * floci has no WAF data plane in front of an emulated ALB, so a WAF rule there
 * would be a control that provably does nothing. This is the honest place for it:
 * in the service, with a test that proves the 429.
 *
 * Two consequences worth stating rather than hiding:
 *
 *  1. The counter is **per task**. Four tasks allow four times the limit. A shared
 *     counter would need Redis, which is a new service and a new failure mode for
 *     a limit that exists to blunt accidental loops and cheap abuse, not to meter
 *     traffic. The per-account login lockout is the exact control, and that one is
 *     in Postgres.
 *  2. Memory is bounded by the number of distinct clients seen inside one window,
 *     because expired buckets are dropped as they are swept.
 *
 * The window slides: a fixed window would let a client send 60 at 12:00:59 and 60
 * at 12:01:00, which is 120 in two seconds.
 */

export function createRateLimit({
  windowMs = 60_000,
  max = 60,
  now = () => Date.now(),
  skip = () => false,
  log = null,
} = {}) {
  if (!Number.isFinite(max) || max <= 0) throw new Error('createRateLimit needs a positive max.');
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    throw new Error('createRateLimit needs a positive windowMs.');
  }

  /** key → timestamps of the requests still inside the window. */
  const hits = new Map();

  function sweep(at) {
    const cutoff = at - windowMs;
    for (const [key, stamps] of hits) {
      const live = stamps.filter((t) => t > cutoff);
      if (live.length === 0) hits.delete(key);
      else hits.set(key, live);
    }
  }

  let lastSweep = 0;

  return function applyRateLimit(req, res, next) {
    if (skip(req)) return next();

    const at = now();
    // A full sweep on every request would be O(clients) per request. Once per
    // window is enough to keep the map from growing without bound.
    if (at - lastSweep > windowMs) {
      sweep(at);
      lastSweep = at;
    }

    const key = req.ip ?? 'unknown';
    const cutoff = at - windowMs;
    const stamps = (hits.get(key) ?? []).filter((t) => t > cutoff);

    if (stamps.length >= max) {
      const retryAfterMs = Math.max(0, stamps[0] + windowMs - at);
      const retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1000));

      res.setHeader('Retry-After', String(retryAfterSeconds));
      res.setHeader('RateLimit-Limit', String(max));
      res.setHeader('RateLimit-Remaining', '0');
      res.setHeader('RateLimit-Reset', String(retryAfterSeconds));

      log?.warn({ msg: 'rate_limit.exceeded', requestId: req.id, path: req.path, limit: max });

      return res.status(429).json({
        error: {
          code: 'RATE_LIMITED',
          message: `Too many requests. Try again in ${retryAfterSeconds} seconds.`,
          requestId: req.id,
          details: { scope: 'rate_limit', limit: max, retryAfterSeconds },
        },
      });
    }

    stamps.push(at);
    hits.set(key, stamps);

    res.setHeader('RateLimit-Limit', String(max));
    res.setHeader('RateLimit-Remaining', String(Math.max(0, max - stamps.length)));
    return next();
  };
}
