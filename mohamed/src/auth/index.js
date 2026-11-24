import { createAwsPorts } from './aws-clients.js';
import { createAuthMiddleware } from './middleware.js';
import { loadKeystore } from './keystore.js';
import { createSessionService } from './sessions.js';
import { createTokenService } from './tokens.js';
import { createTurnstileVerifier } from './turnstile.js';

import { createAuthController } from '../controllers/auth.controller.js';
import { createUsersModel } from '../models/users.model.js';
import { createAuthRouter } from '../routes/auth.js';
import { createAuthService } from '../services/auth.service.js';

/**
 * One place where the authentication stack is wired together.
 *
 * Everything is injected rather than imported so tests can build the same graph
 * with an ephemeral key and a fake Turnstile, and so the boot path has exactly
 * one order: the key must unseal before the server can listen, because a service
 * that cannot sign is worse than a service that is down.
 */

export async function buildAuth({ query, withTransaction, config, log, turnstile = null }) {
  // Only build AWS clients when there is a sealed key to unseal. A developer
  // running against keys/dev.pem has no reason to construct two SDK clients that
  // would then never be called.
  const ports = config.kmsKeyAlias
    ? createAwsPorts({ region: config.awsRegion, endpoint: config.awsEndpointUrl })
    : null;

  const keystore = await loadKeystore({
    kmsKeyAlias: config.kmsKeyAlias,
    jwtSecretId: config.jwtSecretId,
    jwtKeyFile: config.jwtKeyFile,
    nodeEnv: config.nodeEnv,
    secrets: ports?.secrets,
    kms: ports?.kms,
    log,
  });

  const tokens = createTokenService({
    keystore,
    issuer: config.jwtIssuer,
    audience: config.jwtAudience,
    accessTtlSeconds: config.accessTokenTtlSeconds,
  });

  const users = createUsersModel({ query, withTransaction });

  const sessions = createSessionService({
    withTransaction,
    ttlDays: config.refreshTtlDays,
    familyMaxDays: config.sessionAbsoluteDays,
    graceSeconds: config.refreshGraceSeconds,
    maxFamilies: config.maxSessionsPerUser,
  });

  const verifyTurnstile =
    turnstile ?? createTurnstileVerifier({ secret: config.turnstileSecret, log }).verify;

  const service = createAuthService({ users, sessions, tokens, verifyTurnstile, log });
  const middleware = createAuthMiddleware({ tokens, users });
  const controller = createAuthController({ auth: service, tokens });

  return {
    router: createAuthRouter({
      controller,
      middleware,
      jwks: () => ({ keys: keystore.published }),
    }),
    middleware,
    tokens,
    keystore,
    source: keystore.source,
  };
}
