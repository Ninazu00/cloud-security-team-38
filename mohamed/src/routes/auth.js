import express from 'express';

/**
 * The URL table for authentication - paths and middleware, nothing else.
 *
 * `POST /api/auth/logout` takes no access token on purpose: a client whose token
 * just expired must still be able to throw away its refresh cookie.
 */

export function createAuthRouter({ controller, middleware, jwks }) {
  const router = express.Router();

  router.post('/api/auth/register', controller.register);
  router.post('/api/auth/login', controller.login);
  router.post('/api/auth/refresh', controller.refresh);
  router.post('/api/auth/logout', controller.logout);
  router.get('/api/auth/me', middleware.requireAuth, controller.me);

  // Both unauthenticated by necessity: an unverified account cannot sign in, so
  // it could never present a token to finish verifying itself.
  router.post('/api/auth/verify-email', controller.verifyEmail);
  router.post('/api/auth/verify-email/resend', controller.resendVerification);

  // Reset works the same way: request is public (nobody who forgot a password can
  // authenticate), confirm is driven by the token in the body.
  router.post('/api/auth/password-reset/request', controller.requestPasswordReset);
  router.post('/api/auth/password-reset/confirm', controller.confirmPasswordReset);

  // Not under /api and not authenticated: this is how the other two services learn
  // the public half of our signing key. Cacheable for ten minutes, and it has no
  // error response - an unreachable JWKS means "cannot verify", which the caller
  // already knows how to handle.
  router.get('/.well-known/jwks.json', (_req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=600');
    res.status(200).json(jwks());
  });

  return router;
}
