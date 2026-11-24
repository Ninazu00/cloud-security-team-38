import { forbidden, unauthorized } from '../errors.js';

/**
 * Who is calling, and may they.
 *
 * `requireAuth` is deliberately cheap: it verifies the signature and attaches the
 * claims, but does not read the database. A token is the caller's claim, good for
 * up to two hours — fine for "is this person logged in".
 *
 * `requireRole` is not cheap, on purpose: it re-reads `users.role`, because an
 * admin demoted thirty seconds ago still holds an `admin` claim in a token that
 * will not expire for another two hours. Authorising on a stale claim is how
 * "removed from the team" keeps working until tomorrow.
 *
 * Both answer `401 UNAUTHENTICATED` for any problem with the token itself, and
 * never say which problem: "expired" versus "unknown" is an oracle.
 *
 * Neither function wraps its body in try/catch. Express 5 catches a synchronous
 * throw in a handler or middleware and passes it to the error handler, and it does
 * the same for a rejected promise from an async one — so the `ApiError` raised by
 * the verifier arrives at the JSON error handler without any plumbing here.
 */

export function createAuthMiddleware({ tokens, users }) {
  function requireAuth(req, _res, next) {
    const header = req.headers.authorization;

    if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
      throw unauthorized('UNAUTHENTICATED', 'Missing or invalid access token.');
    }

    const claims = tokens.verifyAccessToken(header.slice('Bearer '.length).trim());

    req.auth = { userId: claims.sub, role: claims.role, jti: claims.jti, exp: claims.exp };
    next();
  }

  function requireRole(role) {
    return async function roleGuard(req, _res, next) {
      if (!req.auth) {
        throw unauthorized('UNAUTHENTICATED', 'Missing or invalid access token.');
      }

      const user = await users.findById(req.auth.userId);
      if (!user) throw unauthorized('UNAUTHENTICATED', 'Missing or invalid access token.');

      if (user.role !== role) {
        throw forbidden('FORBIDDEN', 'You do not have permission to do that.');
      }

      // Hand the fresh role to the handler so it does not read the row again.
      req.auth.role = user.role;
      next();
    };
  }

  return { requireAuth, requireRole };
}
