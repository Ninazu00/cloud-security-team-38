// Configuration is read once, validated once, and exported frozen. Anything
// missing or malformed stops the process at boot instead of failing on the
// first request — a container that cannot work should crash-loop, not serve
// 500s.

const env = process.env;

function required(name) {
  const v = env[name];
  if (!v || !v.trim()) {
    console.error(JSON.stringify({ level: 'fatal', msg: `missing required env var ${name}` }));
    process.exit(1);
  }
  return v.trim();
}

function optional(name, fallback) {
  const v = env[name];
  return v && v.trim() ? v.trim() : fallback;
}

function integer(name, fallback) {
  const raw = env[name];
  if (!raw || !raw.trim()) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) {
    console.error(JSON.stringify({ level: 'fatal', msg: `env var ${name} is not an integer: ${raw}` }));
    process.exit(1);
  }
  return n;
}

export const config = Object.freeze({
  nodeEnv: optional('NODE_ENV', 'development'),
  port: integer('PORT', 3000),

  // Neon in deployment, Postgres in the local compose stack. The service only
  // needs one connection string; the difference is TLS and pooling, both of
  // which live in the URL and in the pool settings below.
  databaseUrl: required('DATABASE_URL'),

  // A pooled endpoint cannot take one connection per task per request, so the
  // pool is deliberately small: tasks × pool max must stay under the endpoint's
  // connection limit.
  dbPoolMax: integer('DB_POOL_MAX', 5),
  dbConnectTimeoutMs: integer('DB_CONNECT_TIMEOUT_MS', 2000),

  // A transaction that holds a room lock must not be able to hold it forever.
  // lock_timeout fails a *waiting* statement (55P03); statement_timeout caps the
  // total time of any single statement. Both are set per transaction, not per
  // connection, so a pooled client cannot leak them into the next request.
  dbLockTimeoutMs: integer('DB_LOCK_TIMEOUT_MS', 2000),
  dbStatementTimeoutMs: integer('DB_STATEMENT_TIMEOUT_MS', 5000),

  // Readiness must answer inside the load balancer's health-check timeout.
  readyTimeoutMs: integer('READY_TIMEOUT_MS', 1000),

  // --- authentication -------------------------------------------------------
  // The signing key never lives in an env var: the alias points at a KMS key that
  // can decrypt the sealed secret. `jwtKeyFile` is the development fallback and is
  // refused outright when NODE_ENV=production (see auth/keystore.js).
  kmsKeyAlias: optional('KMS_KEY_ALIAS', null),
  jwtSecretId: optional('JWT_SECRET_ID', 'class-tt/jwt-signing-key'),
  jwtKeyFile: optional('JWT_KEY_FILE', 'keys/dev.pem'),
  jwtIssuer: optional('JWT_ISSUER', 'class-tt'),
  jwtAudience: optional('JWT_AUDIENCE', 'class-tt'),
  accessTokenTtlSeconds: integer('ACCESS_TOKEN_TTL_SECONDS', 7200),
  refreshTtlDays: integer('REFRESH_TTL_DAYS', 7),
  sessionAbsoluteDays: integer('SESSION_ABSOLUTE_DAYS', 30),
  refreshGraceSeconds: integer('REFRESH_GRACE_SECONDS', 30),
  maxSessionsPerUser: integer('MAX_SESSIONS_PER_USER', 10),

  // Required in production (the verifier refuses to construct without it), and the
  // local stack uses Cloudflare's "always passes" test secret.
  turnstileSecret: optional('TURNSTILE_SECRET', null),

  // Empty by default: the frontend is served from this same origin. If it is ever
  // hosted elsewhere, name the exact origins — the refresh cookie is credentialed,
  // so a wildcard is both unsafe and rejected by browsers.
  corsOrigins: optional('CORS_ORIGINS', '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),

  // --- outgoing mail --------------------------------------------------------
  // The From address must be a verified identity in SES, which is why the runbook
  // verifies it before the first sign-up rather than letting the first send fail.
  mailFrom: optional('MAIL_FROM', 'noreply@class-tt.local'),

  // Used to build the verification link. It must be the address a *user* can
  // reach, not the address the process can reach: on floci the two differ.
  publicBaseUrl: optional('PUBLIC_BASE_URL', 'http://localhost:3000'),

  // Two sends per sign-up are normal (register, resend); the cap is per account
  // per hour and lives here so a test can lower it instead of sending four mails.
  resendLimitPerHour: integer('RESEND_LIMIT_PER_HOUR', 3),

  // The drainer is on by default. Tests turn it off and call `runOnce` themselves,
  // so an assertion is never racing a background timer.
  mailerEnabled: optional('MAILER_ENABLED', 'true') !== 'false',
  mailerIntervalMs: integer('MAILER_INTERVAL_MS', 2000),

  awsRegion: optional('AWS_REGION', 'us-east-1'),
  awsEndpointUrl: optional('AWS_ENDPOINT_URL', null),

  logLevel: optional('LOG_LEVEL', 'info'),
  serviceName: optional('SERVICE_NAME', 'class-tt-catalogue'),
});

export const isProduction = config.nodeEnv === 'production';
