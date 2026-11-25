/**
 * CORS, narrow.
 *
 * The frontend normally ships from this same origin, so this middleware does
 * nothing at all unless `CORS_ORIGINS` names an origin. That is the right
 * default: a same-origin app needs no CORS headers, and a permissive default is
 * how `Access-Control-Allow-Origin: *` ends up in production.
 *
 * The refresh cookie is credentialed, so `*` is never valid here - the browser
 * rejects it - and the allow-list has to be exact. `Vary: Origin` keeps a shared
 * cache from serving one origin's response to another.
 */
export function cors({ origins = [] } = {}) {
  const allowed = new Set(origins);

  return function applyCors(req, res, next) {
    const origin = req.get('origin');
    if (!origin) return next();

    res.setHeader('Vary', 'Origin');

    if (!allowed.has(origin)) {
      // A preflight from an origin we do not trust gets an empty 204 rather than a
      // 404: the browser refuses the request either way, because no
      // `Access-Control-Allow-Origin` came back - but a 404 would also tell the
      // caller which routes exist, which is a free map of the API for anyone who
      // asks. Nothing else about the response is revealed.
      if (req.method === 'OPTIONS') return res.status(204).end();
      return next();
    }

    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Expose-Headers', 'x-request-id');

    if (req.method !== 'OPTIONS') return next();

    // Preflight. Answering it here means the routes never see an OPTIONS request
    // they would have answered with a 404 in the error envelope.
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      req.get('access-control-request-headers') ?? 'authorization, content-type',
    );
    res.setHeader('Access-Control-Max-Age', '600');
    return res.status(204).end();
  };
}
