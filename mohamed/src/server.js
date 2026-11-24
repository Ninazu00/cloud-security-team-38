// Container entrypoint: listen on a port, shut down cleanly, never leave the
// process in a state where the platform's SIGTERM was ignored.

import { createApp } from './app.js';
import { config } from './config.js';
import { log } from './logger.js';
import { closePool, ping } from './db.js';

const app = createApp();

const server = app.listen(config.port, () => {
  log.info({ msg: 'listening', port: config.port, env: config.nodeEnv });
});

// First contact with the database, logged but not fatal: a task that starts
// before the database is reachable should come up and report not-ready, which
// is exactly what the load balancer needs to see. (The signing key is a
// different matter — that one must fail to start, or the service would issue
// tokens it cannot verify.)
void ping().then((result) => {
  if (result.ok) log.info({ msg: 'database reachable', ms: result.ms });
  else log.warn({ msg: 'database not reachable at boot', error: result.error });
});

let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ msg: 'shutdown started', signal });

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
