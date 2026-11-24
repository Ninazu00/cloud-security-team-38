// A pool, not a client: one connection per request would open and close a TCP
// connection (and a TLS handshake) for every call, which is both slow and the
// fastest way to exhaust a pooled endpoint.

import pg from 'pg';
import { config } from './config.js';
import { log } from './logger.js';

// pg returns BIGINT and NUMERIC as strings by default to avoid precision loss.
// The catalogue has no such columns yet, but timestamps should come back as
// Date objects so the API can serialise them consistently.
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));

// TLS is decided by the connection string, not by a hostname guess: Neon hands
// out URLs ending in `?sslmode=require`, and pg honours that. Guessing from the
// hostname broke the container-to-local-database case, where the database is
// "remote" from the container's point of view but cannot speak TLS at all.
export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: config.dbPoolMax,
  connectionTimeoutMillis: config.dbConnectTimeoutMs,
  idleTimeoutMillis: 30_000,
  application_name: config.serviceName,
});

pool.on('error', (err) => {
  // An idle client failing is not fatal to the process, but it must be visible:
  // it is how a network blip or a server-side connection limit looks.
  log.error({ msg: 'database pool error', error: err.message, code: err.code });
});

/**
 * One statement, no transaction.
 *
 * Most database calls in this service are a single `select` or `update`. Wrapping
 * those in BEGIN/COMMIT would be two extra network round trips and would suggest
 * an atomicity guarantee that is not being asked for. Use `withTransaction` only
 * when two statements must both happen or neither.
 */
export function query(text, params) {
  return pool.query(text, params);
}

/**
 * Round trip to the database with a hard deadline. Used by readiness only, so
 * it must never throw and must never take longer than the health-check timeout.
 * @returns {Promise<{ok: boolean, ms: number, error?: string}>}
 */
export async function ping(timeoutMs = config.readyTimeoutMs) {
  const startedAt = Date.now();
  let timer;
  try {
    const query = pool.query('SELECT 1 AS ok');
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('readyz timeout')), timeoutMs);
    });
    await Promise.race([query, deadline]);
    return { ok: true, ms: Date.now() - startedAt };
  } catch (err) {
    return { ok: false, ms: Date.now() - startedAt, error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One transaction. Commits when the callback returns, rolls back when it throws,
 * and always releases the client — callers never see BEGIN/COMMIT/ROLLBACK.
 *
 * Both timeouts are set with set_config(..., is_local = true), which scopes them
 * to this transaction. That matters because the connection goes back into the
 * pool afterwards: a plain `SET lock_timeout` would leak into the next request
 * that happens to reuse this client.
 */
export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("select set_config('lock_timeout', $1, true)", [
      `${config.dbLockTimeoutMs}ms`,
    ]);
    await client.query("select set_config('statement_timeout', $1, true)", [
      `${config.dbStatementTimeoutMs}ms`,
    ]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // A rollback failure means the connection is gone; the release below
      // destroys it either way.
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool() {
  await pool.end();
}
