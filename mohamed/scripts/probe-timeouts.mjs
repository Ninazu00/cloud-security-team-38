// Proves the transaction timeouts actually fire, and that they do not leak onto
// the pooled connection afterwards. Needs DATABASE_URL (npm run probe:timeouts).
//
//   PASS  second writer blocks on a held lock   (55P03 after 2014 ms)
//   PASS  timeout does not leak to the next transaction  (statement_timeout=0 …)
import { pool, withTransaction, closePool } from '../src/db.js';

const held = await pool.connect();
const results = [];

try {
  // Another session takes the room lock first and keeps it.
  await held.query('BEGIN');
  await held.query('select pg_advisory_xact_lock(hashtext($1))', ['room:H1']);

  // Our transaction now waits for that same lock.
  const startedAt = Date.now();
  try {
    await withTransaction(async (client) => {
      await client.query('select pg_advisory_xact_lock(hashtext($1))', ['room:H1']);
      return 'should not reach here';
    });
    results.push(['second writer blocks on a held lock', false, 'no error — lock_timeout did nothing']);
  } catch (err) {
    results.push(['second writer blocks on a held lock', err.code === '55P03', `${err.code} after ${Date.now() - startedAt} ms`]);
  }

  // After the failure, a pooled connection must be clean: if set_config had
  // leaked (a plain SET instead of SET LOCAL would), the next transaction would
  // inherit the 5 s statement timeout. Read it *outside* our helper.
  const reused = await pool.connect();
  await reused.query('BEGIN');
  const { rows } = await reused.query('show statement_timeout');
  await reused.query('ROLLBACK');
  reused.release();
  results.push([
    'timeout does not leak to the next transaction',
    rows[0].statement_timeout === '0',
    `statement_timeout=${rows[0].statement_timeout} on a reused connection`,
  ]);
} finally {
  await held.query('ROLLBACK').catch(() => {});
  held.release();
  await closePool();
}

for (const [name, ok, note] of results) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  (${note})`);
}
process.exit(results.every(([, ok]) => ok) ? 0 : 1);
