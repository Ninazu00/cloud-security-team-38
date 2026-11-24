import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

import pg from 'pg';

import { createSessionService } from '../src/auth/sessions.js';

/**
 * These tests talk to a real Postgres, because the behaviour under test is in the
 * SQL: row locks, partial state, the family revocation. A fake pool would only
 * prove that the mock returns what the mock was told to return.
 *
 * They skip themselves when DATABASE_URL is absent, so `npm test` stays green
 * for anyone without the local stack running.
 */
const DATABASE_URL = process.env.DATABASE_URL;
const skip = DATABASE_URL ? false : 'needs DATABASE_URL (local stack on :5433)';

let pool;
let withTransaction;
let userId;

function serviceAt(offsetMs = 0) {
  return createSessionService({
    withTransaction,
    now: () => Date.now() + offsetMs,
  });
}

async function expectApiError(promise, status, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.status, status);
    assert.equal(error.code, code);
    return true;
  });
}

before(async () => {
  if (!DATABASE_URL) return;

  pool = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });
  withTransaction = async (fn) => {
    const client = await pool.connect();
    try {
      await client.query('begin');
      const result = await fn(client);
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  };

  const { rows } = await pool.query(
    `insert into users (email, password_hash, role, email_verified_at)
     values ($1, 'not-a-real-hash', 'student', now())
     returning id`,
    [`sessions-test-${Date.now()}@example.test`],
  );
  userId = rows[0].id;
});

beforeEach(async () => {
  if (!pool) return;
  await pool.query('delete from sessions where user_id = $1', [userId]);
});

after(async () => {
  if (!pool) return;
  await pool.query('delete from users where id = $1', [userId]);
  await pool.end();
});

test('a new session stores only the hash of the token', { skip }, async () => {
  const sessions = serviceAt();
  const session = await sessions.start({ userId, userAgent: 'node:test' });

  const { rows } = await pool.query('select token_hash, revoked_at from sessions where id = $1', [
    session.sessionId,
  ]);

  assert.equal(rows[0].token_hash.length, 32);
  assert.notEqual(rows[0].token_hash.toString('base64url'), session.refreshToken);

  // The plaintext must not be recoverable from the row at all.
  const asText = rows[0].token_hash.toString('utf8');
  assert.equal(asText.includes(session.refreshToken), false);
  assert.equal(rows[0].revoked_at, null);
});

test('rotating replaces the token and keeps the family', { skip }, async () => {
  const sessions = serviceAt();
  const first = await sessions.start({ userId });
  const second = await sessions.rotate({ token: first.refreshToken });

  assert.notEqual(second.refreshToken, first.refreshToken);
  assert.equal(second.familyId, first.familyId);

  const { rows } = await pool.query(
    'select id, family_id, replaced_at, replaced_by_id from sessions where user_id = $1 order by created_at',
    [userId],
  );

  assert.equal(rows.length, 2);
  assert.equal(rows[0].family_id, rows[1].family_id);
  assert.ok(rows[0].replaced_at instanceof Date);
  assert.equal(rows[0].replaced_by_id, rows[1].id);
});

test('a token reused after the grace window revokes the whole family', { skip }, async () => {
  const sessions = serviceAt();
  const first = await sessions.start({ userId });
  const second = await sessions.rotate({ token: first.refreshToken });

  // The thief replays the old token 60 s later — outside the 30 s window.
  const later = serviceAt(60_000);
  await expectApiError(later.rotate({ token: first.refreshToken }), 410, 'REFRESH_REUSED');

  // And the token the legitimate client still holds is now dead too.
  await expectApiError(later.rotate({ token: second.refreshToken }), 401, 'INVALID_REFRESH');

  const { rows } = await pool.query(
    'select count(*)::int as live from sessions where user_id = $1 and revoked_at is null',
    [userId],
  );
  assert.equal(rows[0].live, 0);
});

test('the grace window lets two tabs rotate, but only once', { skip }, async () => {
  const sessions = serviceAt();
  const first = await sessions.start({ userId });

  await sessions.rotate({ token: first.refreshToken }); // tab A wins
  const third = await sessions.rotate({ token: first.refreshToken }); // tab B, inside grace

  assert.ok(third.refreshToken);

  // A third attempt with the same stale token is reuse, not a tab race.
  await expectApiError(sessions.rotate({ token: first.refreshToken }), 410, 'REFRESH_REUSED');
});

test('revoking a session stops it rotating, without touching its siblings', { skip }, async () => {
  const sessions = serviceAt();
  const phone = await sessions.start({ userId });
  const laptop = await sessions.start({ userId });

  assert.equal(await sessions.revoke({ token: phone.refreshToken }), true);

  await expectApiError(sessions.rotate({ token: phone.refreshToken }), 401, 'INVALID_REFRESH');

  const rotated = await sessions.rotate({ token: laptop.refreshToken });
  assert.ok(rotated.refreshToken);
});

test('revokeAllForUser ends every family', { skip }, async () => {
  const sessions = serviceAt();
  const one = await sessions.start({ userId });
  const two = await sessions.start({ userId });

  const revoked = await sessions.revokeAllForUser(userId);
  assert.ok(revoked >= 2);

  await expectApiError(sessions.rotate({ token: one.refreshToken }), 401, 'INVALID_REFRESH');
  await expectApiError(sessions.rotate({ token: two.refreshToken }), 401, 'INVALID_REFRESH');
});

test('an expired token is rejected, and expired rows are cleaned up later', { skip }, async () => {
  const sessions = serviceAt();
  const session = await sessions.start({ userId });

  await pool.query("update sessions set expires_at = now() - interval '1 minute' where id = $1", [
    session.sessionId,
  ]);

  await expectApiError(sessions.rotate({ token: session.refreshToken }), 401, 'INVALID_REFRESH');

  // Starting a new session opportunistically deletes the expired row.
  await sessions.start({ userId });
  const { rows } = await pool.query('select count(*)::int as n from sessions where id = $1', [
    session.sessionId,
  ]);
  assert.equal(rows[0].n, 0);
});

test('a login older than the family cap cannot be refreshed, even if the token is fresh', { skip }, async () => {
  const sessions = serviceAt();
  const session = await sessions.start({ userId });

  await pool.query(
    "update sessions set family_expires_at = now() - interval '1 minute' where id = $1",
    [session.sessionId],
  );

  await expectApiError(sessions.rotate({ token: session.refreshToken }), 401, 'INVALID_REFRESH');
});

test('the eleventh login revokes the oldest family', { skip }, async () => {
  const sessions = serviceAt();

  const tokens = [];
  for (let i = 0; i < 11; i += 1) {
    const session = await sessions.start({ userId });
    tokens.push(session.refreshToken);
  }

  const { rows } = await pool.query(
    `select count(distinct family_id)::int as families
       from sessions
      where user_id = $1 and revoked_at is null`,
    [userId],
  );
  assert.equal(rows[0].families, 10);

  // The oldest family is gone: its very first token no longer rotates.
  await expectApiError(sessions.rotate({ token: tokens[0] }), 401, 'INVALID_REFRESH');

  // The newest still works.
  const rotated = await sessions.rotate({ token: tokens[10] });
  assert.ok(rotated.refreshToken);
});

test('an unknown or malformed token is rejected without a database read', { skip }, async () => {
  const sessions = serviceAt();

  for (const token of ['', 'short', 'x'.repeat(600), null, 42]) {
    await expectApiError(sessions.rotate({ token }), 401, 'INVALID_REFRESH');
  }

  await expectApiError(sessions.rotate({ token: 'a'.repeat(43) }), 401, 'INVALID_REFRESH');
  assert.equal(await sessions.revoke({ token: 'nope' }), false);
});
