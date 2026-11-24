// Container entrypoint: unseal the signing key, listen on a port, shut down
// cleanly, never leave the process in a state where the platform's SIGTERM was
// ignored.

import { fileURLToPath } from 'node:url';

import { createApp } from './app.js';
import { buildAuth } from './auth/index.js';
import { buildCatalogue } from './catalogue/index.js';
import { config } from './config.js';
import { createSesSender } from './email/sender.js';
import { createOutboxWorker } from './email/worker.js';
import { log } from './logger.js';
import { closePool, ping, query, withTransaction } from './db.js';

// The key is unsealed before the socket opens, and a failure here is fatal. A
// task that cannot sign would answer every login with a 500 while reporting
// healthy to the load balancer — a crash-loop is the honest behaviour.
let auth;
try {
  auth = await buildAuth({ query, withTransaction, config, log });
  log.info({ msg: 'auth ready', source: auth.source, kid: auth.tokens.kid });
} catch (error) {
  log.error({ msg: 'auth bootstrap failed', error: error?.message });
  process.exit(1);
}

// Built after auth because the course routes borrow its guards: a catalogue
// that imported them directly would be a second place to remember whenever
// authentication changes.
const catalogue = buildCatalogue({ query, withTransaction, middleware: auth.middleware, log });

// The frontend ships in the image beside `src/`, so one task serves both the API
// and the pages. That is not laziness: the refresh cookie is `SameSite=Strict`,
// and same-origin is the only shape where a browser will store and return it
// without also needing CSRF protection.
const frontendDir = fileURLToPath(new URL('../frontend', import.meta.url));

const app = createApp({ auth, catalogue, staticDir: frontendDir });

const server = app.listen(config.port, () => {
  log.info({ msg: 'listening', port: config.port, env: config.nodeEnv });
});

// Mail drains in this same process, started after the socket opens: a mail loop
// that runs before the server can answer is a loop whose first failure nobody
// sees. `unref` inside the worker means an idle timer never blocks shutdown.
let stopMailer = null;
if (config.mailerEnabled) {
  const worker = createOutboxWorker({
    outbox: auth.outbox,
    send: createSesSender({
      region: config.awsRegion,
      endpoint: config.awsEndpointUrl,
      fromAddress: config.mailFrom,
      testCredentials: Boolean(config.awsEndpointUrl) && config.nodeEnv !== 'production',
    }),
    issueToken: auth.actionTokens.issue,
    publicBaseUrl: config.publicBaseUrl,
    log,
  });

  stopMailer = worker.start({ intervalMs: config.mailerIntervalMs });
  log.info({ msg: 'mailer started', from: config.mailFrom, intervalMs: config.mailerIntervalMs });
}

// First contact with the database, logged but not fatal: a task that starts
// before the database is reachable should come up and report not-ready, which
// is exactly what the load balancer needs to see.
void ping().then((result) => {
  if (result.ok) log.info({ msg: 'database reachable', ms: result.ms });
  else log.warn({ msg: 'database not reachable at boot', error: result.error });
});

let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ msg: 'shutdown started', signal });

  // The mailer stops claiming new rows immediately; a mail already in flight is
  // allowed to finish inside the grace period.
  stopMailer?.();

  // Stop accepting new connections, then wait for in-flight requests. The
  // grace period must be shorter than the platform's kill timeout, otherwise
  // the process is killed mid-shutdown and the drain was pointless.
  const forceTimer = setTimeout(() => {
    log.error({ msg: 'shutdown forced after timeout' });
    process.exit(1);
  }, 10_000);
  forceTimer.unref();

  server.close(async (err) => {
    if (err) log.error({ msg: 'server close failed', error: err.message });
    try {
      await closePool();
    } catch (e) {
      log.error({ msg: 'pool close failed', error: e.message });
    }
    log.info({ msg: 'shutdown complete', signal });
    clearTimeout(forceTimer);
    process.exit(0);
  });
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  // A rejected promise nobody awaited is a bug, and silently continuing hides it.
  log.error({ msg: 'unhandled rejection', error: String(reason) });
});
