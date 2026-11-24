// The Express app, with no `listen` and no process-level concerns — that split
// keeps every route testable on an ephemeral port without touching a real socket
// or a real database. Everything below is transport-agnostic.

import express from 'express';
import crypto from 'node:crypto';

import { config, isProduction } from './config.js';
import { log } from './logger.js';
import { ApiError, errorBody, notFound } from './errors.js';
import { healthRouter } from './routes/health.js';
import { cors } from './http/cors.js';
import { createRateLimit } from './http/rate-limit.js';
import { securityHeaders } from './http/security.js';

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{8,64}$/;

// One number, one message: the limit is defined here and quoted from here, so
// the 413 text cannot drift away from the limit that actually fired.
const JSON_BODY_LIMIT_BYTES = 100 * 1024;

// Health probes fire every few seconds per task. Logging them at info would make
// them most of the log volume and none of the information; at debug they are
// still available when a probe is what you are investigating.
const PROBE_PATHS = new Set(['/healthz', '/readyz']);

export function createApp({
  auth = null,
  catalogue = null,
  admin = null,
  staticDir = null,
  allowedOrigins = config.corsOrigins,
  // Tests pass their own limiter so a suite can use a limit of three instead of
  // sixty, and so the window can be short.
  rateLimit = null,
} = {}) {
  const app = express();

  // Behind an ALB the client address arrives in X-Forwarded-For; without this
  // req.ip is the proxy's address and every rate limit keys on one value.
  // `1` means "trust exactly one hop" — with `true`, a client could spoof its
  // own address by sending the header itself.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(securityHeaders({ hsts: isProduction }));
  app.use(cors({ origins: allowedOrigins }));

  // Correlation id: accept a sane inbound one so a client-visible reference
  // matches the log line, otherwise mint one. Validation matters — the value
  // ends up in logs and must not be able to forge a second log line.
  app.use((req, res, next) => {
    const inbound = req.get('x-request-id');
    req.id = inbound && REQUEST_ID_PATTERN.test(inbound) ? inbound : crypto.randomUUID();
    res.setHeader('x-request-id', req.id);
    next();
  });

  app.use((req, res, next) => {
    const startedAt = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
      const fields = {
        requestId: req.id,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        ms: Number(ms.toFixed(1)),
      };
      // req.path, never req.originalUrl: reset and verification tokens travel in
      // the query string (`?token=…`), and logging only the path keeps them out
      // of the access log. This is a rule about *this* field, not a guarantee:
      // a future route that put a token in the path itself would be logged, which
      // is why tokens belong in bodies and query strings, never in path segments.
      if (PROBE_PATHS.has(req.path)) log.debug({ msg: 'probe', ...fields });
      else log.info({ msg: 'request', ...fields });
    });
    next();
  });

  // Rate limiting sits before the body parsers on purpose: a client that is over
  // its budget should be refused before the process allocates anything for it.
  // Probes are exempt — the load balancer calls them every 15 seconds and a 429
  // there would take the task out of rotation for being asked whether it is alive.
  app.use(
    rateLimit ??
      createRateLimit({
        windowMs: config.rateLimitWindowMs,
        max: config.rateLimitMax,
        skip: (req) => PROBE_PATHS.has(req.path),
        log,
      }),
  );

  // JSON bodies only, and small. The limit is a control, not a convenience:
  // it bounds the memory a single request can make the process allocate.
  // Routes that need a different limit (the CSV import) set their own parser.
  app.use(express.json({ limit: JSON_BODY_LIMIT_BYTES }));

  // Probes live at the root, not under /api: they are infrastructure, they are
  // unauthenticated, and they must not share the API's versioning or auth path.
  app.use(healthRouter);

  // Authentication arrives as an already-built router, so this file never touches
  // AWS, KMS or the users table. Tests mount an ephemeral key through the same
  // door production uses.
  if (auth) app.use(auth.router);

  // The catalogue, likewise composed outside this file. It needs auth's guards,
  // which is why it is built after auth in `server.js` and passed in ready-made.
  if (catalogue) app.use(catalogue.router);

  // Admin endpoints (user list, role changes) are their own module for the same
  // reason: they are a different responsibility from signing in or owning the
  // catalogue, and they reuse auth's guards rather than re-implementing them.
  if (admin) app.use(admin.router);

  // The frontend, when it is served from this origin — which is the deployment
  // shape the contract assumes, because the refresh cookie is `SameSite=Strict`
  // and a different site would silently drop it. Static files sit *after* the API
  // routers so a missing asset can never shadow a route, and *before* the 404 so
  // a page that is not there still answers in the API's envelope.
  if (staticDir) {
    app.use(express.static(staticDir, { index: 'index.html', etag: true, maxAge: 0 }));
  }

  // Routes are mounted here as they are built — above this line. Everything that
  // falls through is a 404 in the same envelope as any other error, so no client
  // ever sees Express's HTML page.
  app.use((_req, _res, next) => next(notFound('NOT_FOUND', 'No such endpoint.')));

  // Express identifies an error handler by its four-argument signature, so `_next`
  // has to be declared even though it is never called.
  app.use((err, req, res, _next) => {
    // body-parser failures arrive here with their own status codes.
    if (err?.type === 'entity.too.large') {
      const message = `Request body exceeds ${JSON_BODY_LIMIT_BYTES / 1024} KB.`;
      return res.status(413).json(errorBody('PAYLOAD_TOO_LARGE', message, req.id));
    }
    if (err?.type === 'entity.parse.failed') {
      return res
        .status(400)
        .json(errorBody('MALFORMED_JSON', 'Request body is not valid JSON.', req.id));
    }

    // Express 5 forwards rejected promises from async handlers here by itself,
    // so controllers do not need a catchAsync wrapper.
    if (err instanceof ApiError) {
      log.warn({
        msg: 'api error',
        requestId: req.id,
        code: err.code,
        status: err.status,
        path: req.path,
      });
      return res.status(err.status).json(errorBody(err.code, err.message, req.id, err.details));
    }

    // Anything else is a bug. The client gets a reference, not a stack trace;
    // the stack goes to the log where an operator can find it by requestId.
    log.error({
      msg: 'unhandled error',
      requestId: req.id,
      path: req.path,
      error: err?.message,
      stack: isProduction ? undefined : err?.stack,
    });
    return res.status(500).json(errorBody('INTERNAL', 'Something went wrong.', req.id));
  });

  return app;
}
