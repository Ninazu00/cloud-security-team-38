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
  // pool is deliberately small. app tasks * pool max must stay under the limit.
  dbPoolMax: integer('DB_POOL_MAX', 5),
  dbConnectTimeoutMs: integer('DB_CONNECT_TIMEOUT_MS', 2000),
  dbQueryTimeoutMs: integer('DB_QUERY_TIMEOUT_MS', 3000),

  // A transaction that holds a room lock must not be able to hold it forever.
  // lock_timeout fails a *waiting* statement (55P03); statement_timeout caps the
  // total time of any single statement. Both are set per transaction, not per
  // connection, so a pooled client cannot leak them into the next request.
  dbLockTimeoutMs: integer('DB_LOCK_TIMEOUT_MS', 2000),
  dbStatementTimeoutMs: integer('DB_STATEMENT_TIMEOUT_MS', 5000),

  // Readiness must answer inside the load balancer's health-check timeout.
  readyTimeoutMs: integer('READY_TIMEOUT_MS', 1000),

  logLevel: optional('LOG_LEVEL', 'info'),
  serviceName: optional('SERVICE_NAME', 'class-tt-catalogue'),
});

export const isProduction = config.nodeEnv === 'production';
