import { unauthorized } from '../errors.js';
import { clearedRefreshCookie, readRefreshCookie, refreshCookie } from '../http/cookies.js';

/**
 * HTTP in, HTTP out — no SQL, no token maths, no policy.
 *
 * The controller's whole job is to translate one medium into another: read the
 * cookie and the JSON body, call the service, then decide what goes in the body
 * and what goes in a `Set-Cookie` header. Every rule about *whether* a login is
 * allowed lives in `services/auth.service.js`.
 */

export const TOKEN_TYPE = 'Bearer';

export function createAuthController({ auth, tokens, now = () => Date.now() }) {
  /** The refresh token is a cookie, so a missing one is not a client mistake. */
  function requireRefreshCookie(req) {
    const token = readRefreshCookie(req);
    if (!token) {
      throw unauthorized('INVALID_REFRESH', 'Refresh token is missing or no longer valid.');
    }
    return token;
  }

  /** Nothing this controller returns may be cached, by a browser or a proxy. */
  function noStore(res) {
    res.setHeader('Cache-Control', 'no-store');
  }

  /** Replace the cookie and tell the browser to keep it for as long as the row lives. */
  function setRefreshCookie(res, session) {
    const maxAge = Math.max(0, Math.floor((session.expiresAt.getTime() - now()) / 1000));
    res.setHeader('Set-Cookie', refreshCookie(session.refreshToken, maxAge));
    noStore(res);
  }

  return {
    async login(req, res) {
      const { email, password, turnstileToken } = req.body ?? {};

      const result = await auth.login({
        email,
        password,
        turnstileToken,
        remoteIp: req.ip,
        userAgent: req.get('user-agent'),
      });

      setRefreshCookie(res, result.session);
      res.status(200).json({
        user: result.user,
        accessToken: result.accessToken,
        tokenType: TOKEN_TYPE,
        expiresIn: tokens.accessTtlSeconds,
      });
    },

    async refresh(req, res) {
      const result = await auth.refresh({
        refreshToken: requireRefreshCookie(req),
        userAgent: req.get('user-agent'),
      });

      setRefreshCookie(res, result.session);
      res.status(200).json({
        accessToken: result.accessToken,
        tokenType: TOKEN_TYPE,
        expiresIn: tokens.accessTtlSeconds,
      });
    },

    /**
     * Always 204, always clears the cookie — including when there was no cookie,
     * or when the token was already dead. A logout that reports failure teaches
     * the client to keep the stale cookie.
     */
    async logout(req, res) {
      try {
        await auth.logout({ refreshToken: readRefreshCookie(req) });
      } finally {
        res.setHeader('Set-Cookie', clearedRefreshCookie());
        noStore(res);
        res.status(204).end();
      }
    },

    async me(req, res) {
      const user = await auth.me({ userId: req.auth.userId });
      noStore(res);
      res.status(200).json(user);
    },

    /**
     * 202 whether or not the address was free. The body says nothing about the
     * account, which is the point: this endpoint is reachable without a session.
     */
    async register(req, res) {
      const { email, password, turnstileToken } = req.body ?? {};

      const result = await auth.register({
        email,
        password,
        turnstileToken,
        remoteIp: req.ip,
      });

      noStore(res);
      res.status(202).json(result);
    },

    /** The token arrives in the body: a link in a URL leaks through history and logs. */
    async verifyEmail(req, res) {
      const { token } = req.body ?? {};
      const result = await auth.verifyEmail({ token });

      noStore(res);
      res.status(200).json(result);
    },

    async resendVerification(req, res) {
      const { email, turnstileToken } = req.body ?? {};

      const result = await auth.resendVerification({
        email,
        turnstileToken,
        remoteIp: req.ip,
      });

      noStore(res);
      res.status(202).json(result);
    },
  };
}
