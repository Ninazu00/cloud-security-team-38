import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';

import pg from 'pg';

import { buildAdmin } from '../src/admin/index.js';
import { createApp } from '../src/app.js';
import { noRateLimit } from './no-rate-limit.js';
import { createAuthMiddleware } from '../src/auth/middleware.js';
import { createTokenService } from '../src/auth/tokens.js';
import { hashPassword } from '../src/auth/passwords.js';
import { createUsersModel } from '../src/models/users.model.js';

/**
 * The admin endpoints, over HTTP against Postgres.
 *
 * Tokens are minted directly rather than logged in: the point here is
 * authorisation and the two refusal rules, not the login flow, which has its own
 * suite. Both rules are *also* unit tested against a fake client below, because
 * "the system keeps at least one admin" is hard to arrange in a shared database.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const skip = DATABASE_URL ? false : 'needs DATABASE_URL (local stack on :5433)';

const EMAIL_PREFIX = 'admin-test-';
const PASSWORD = 'correct horse battery';

let pool;
let server;
let baseUrl;
let tokens;
let users;

function ephemeralKeystore() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const publicJwk = publicKey.export({ format: 'jwk' });
  const kid = 'test-kid';

  return {
    source: 'test',
    current: { kid, privateKey },
    published: [{ ...publicJwk, kid, use: 'sig', alg: 'RS256' }],
  };
}

async function request(path, { method = 'GET', body, token } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await response.text();
  return {
    status: response.status,
    json: text.length > 0 && response.headers.get('content-type')?.includes('json') ? JSON.parse(text) : null,
    setCookie: response.headers.getSetCookie(),
    text,
  };
}

const newEmail = () => `${EMAIL_PREFIX}${randomUUID()}@example.test`;

/** Insert an account directly: the admin suite does not test registration. */
async function createUser({ role = 'student', verified = true } = {}) {
  const email = newEmail();
  const passwordHash = await hashPassword(PASSWORD);

  const { rows } = await pool.query(
    `insert into users (email, password_hash, role, email_verified_at)
     values ($1, $2, $3, case when $4 then now() else null end)
     returning id, email, role`,
    [email, passwordHash, role, verified],
  );

  return rows[0];
}

const tokenFor = (user) => tokens.signAccessToken({ sub: user.id, role: user.role });

before(async () => {
  if (!DATABASE_URL) return;

  pool = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });
  const query = (text, params) => pool.query(text, params);
  const withTransaction = async (fn) => {
    const client = await pool.connect();
    try {
      await client.query('begin');
      const result = await fn(client);
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  };

  const keystore = ephemeralKeystore();
  tokens = createTokenService({ keystore, accessTtlSeconds: 7200 });
  users = createUsersModel({ query, withTransaction });
  const middleware = createAuthMiddleware({ tokens, users });
  const admin = buildAdmin({ withTransaction, middleware, users });

  server = createApp({ admin, rateLimit: noRateLimit }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (!DATABASE_URL) return;
  await new Promise((resolve) => server.close(resolve));
  await pool.query('delete from sessions where user_id in (select id from users where email like $1)', [
    `${EMAIL_PREFIX}%`,
  ]);
  await pool.query('delete from users where email like $1', [`${EMAIL_PREFIX}%`]);
  await pool.end();
});

test('the user list needs a token', { skip }, async () => {
  const response = await request('/api/admin/users');

  assert.equal(response.status, 401);
  assert.equal(response.json.error.code, 'UNAUTHENTICATED');
});

test('a student is refused with 403, not with a hidden button', { skip }, async () => {
  const student = await createUser({ role: 'student' });
  const response = await request('/api/admin/users', { token: tokenFor(student) });

  assert.equal(response.status, 403);
  assert.equal(response.json.error.code, 'FORBIDDEN');
});

test('an admin reads a page of accounts, newest first, without password material', { skip }, async () => {
  const admin = await createUser({ role: 'admin' });
  const older = await createUser();
  const newer = await createUser();

  const response = await request('/api/admin/users?limit=50&q=admin-test-', { token: tokenFor(admin) });

  assert.equal(response.status, 200);
  assert.ok(Array.isArray(response.json.items));
  const ids = response.json.items.map((item) => item.id);
  assert.ok(ids.includes(older.id) && ids.includes(newer.id));
  assert.ok(ids.indexOf(newer.id) < ids.indexOf(older.id), 'newest first');

  const first = response.json.items[0];
  assert.deepEqual(
    Object.keys(first).sort(),
    ['createdAt', 'email', 'emailVerifiedAt', 'id', 'lockedUntil', 'role'].sort(),
    'exactly the documented fields, and never a hash',
  );
  assert.equal(first.passwordHash, undefined);
});

test('the role filter is exact and a bad value is a 422', { skip }, async () => {
  const admin = await createUser({ role: 'admin' });
  const student = await createUser();

  const filtered = await request('/api/admin/users?role=student&q=admin-test-', {
    token: tokenFor(admin),
  });
  assert.equal(filtered.status, 200);
  assert.ok(filtered.json.items.every((item) => item.role === 'student'));
  assert.ok(filtered.json.items.some((item) => item.id === student.id));

  const bad = await request('/api/admin/users?role=owner', { token: tokenFor(admin) });
  assert.equal(bad.status, 422);
  assert.equal(bad.json.error.code, 'VALIDATION_FAILED');
  assert.equal(bad.json.error.details.field, 'role');
});

test('promoting a student takes effect immediately', { skip }, async () => {
  const admin = await createUser({ role: 'admin' });
  const student = await createUser();

  const promoted = await request(`/api/admin/users/${student.id}/role`, {
    method: 'PATCH',
    token: tokenFor(admin),
    body: { role: 'admin' },
  });

  assert.equal(promoted.status, 200);
  assert.equal(promoted.json.role, 'admin');
  assert.equal(promoted.json.email, student.email);

  // The new admin can do admin things with their *old* student token, because the
  // guard reads the role from the table rather than from the claim.
  const listed = await request('/api/admin/users?limit=1', { token: tokenFor(student) });
  assert.equal(listed.status, 200);
});

test('demoting revokes that account sessions at once', { skip }, async () => {
  const admin = await createUser({ role: 'admin' });
  const victim = await createUser({ role: 'admin' });

  // A live refresh token for the account about to be demoted.
  const sessions = await pool.query(
    `insert into sessions (user_id, family_id, token_hash, expires_at, family_expires_at)
     values ($1, gen_random_uuid(), decode(md5($2::text), 'hex'), now() + interval '7 days', now() + interval '30 days')
     returning token_hash`,
    [victim.id, `token-${victim.id}`],
  );
  const liveBefore = await pool.query(
    'select revoked_at from sessions where token_hash = $1',
    [sessions.rows[0].token_hash],
  );
  assert.equal(liveBefore.rows[0].revoked_at, null);

  const demoted = await request(`/api/admin/users/${victim.id}/role`, {
    method: 'PATCH',
    token: tokenFor(admin),
    body: { role: 'student' },
  });
  assert.equal(demoted.status, 200);

  const liveAfter = await pool.query(
    'select revoked_at from sessions where token_hash = $1',
    [sessions.rows[0].token_hash],
  );
  assert.notEqual(liveAfter.rows[0].revoked_at, null, 'the demoted admin session was revoked');
});

test('an admin cannot change their own role', { skip }, async () => {
  const admin = await createUser({ role: 'admin' });

  const response = await request(`/api/admin/users/${admin.id}/role`, {
    method: 'PATCH',
    token: tokenFor(admin),
    body: { role: 'student' },
  });

  assert.equal(response.status, 403);
  assert.equal(response.json.error.code, 'SELF_ROLE_CHANGE');

  const stillAdmin = await pool.query('select role from users where id = $1', [admin.id]);
  assert.equal(stillAdmin.rows[0].role, 'admin');
});

test('an unknown account is a 404 and a bad role is a 422', { skip }, async () => {
  const admin = await createUser({ role: 'admin' });

  const missing = await request(`/api/admin/users/${randomUUID()}/role`, {
    method: 'PATCH',
    token: tokenFor(admin),
    body: { role: 'student' },
  });
  assert.equal(missing.status, 404);
  assert.equal(missing.json.error.code, 'USER_NOT_FOUND');

  const student = await createUser();
  const bad = await request(`/api/admin/users/${student.id}/role`, {
    method: 'PATCH',
    token: tokenFor(admin),
    body: { role: 'owner' },
  });
  assert.equal(bad.status, 422);
  assert.equal(bad.json.error.details.field, 'role');
});

test('setting the role that is already set is a no-op, not an error', { skip }, async () => {
  const admin = await createUser({ role: 'admin' });
  const student = await createUser();

  const response = await request(`/api/admin/users/${student.id}/role`, {
    method: 'PATCH',
    token: tokenFor(admin),
    body: { role: 'student' },
  });

  assert.equal(response.status, 200);
  assert.equal(response.json.role, 'student');
});

/**
 * The two refusal rules are decisions about rows, so they are proved here against
 * a fake client: the shared database always has at least one admin, and arranging
 * "the last one" would mean demoting the seeded account.
 */
test('the model refuses to demote the last admin', async () => {
  const client = {
    query: async (text) => {
      if (text.includes('select id, email, role from users')) {
        return { rows: [{ id: 'u1', email: 'only@example.test', role: 'admin' }], rowCount: 1 };
      }
      if (text.includes("where role = 'admin'")) return { rows: [], rowCount: 0 };
      throw new Error(`unexpected query: ${text}`);
    },
  };

  const { createUsersModel } = await import('../src/models/users.model.js');
  const model = createUsersModel({
    query: async () => ({ rows: [] }),
    withTransaction: async (fn) => fn(client),
  });

  const result = await model.setRole(client, { id: 'u1', role: 'student' });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'last_admin');
});

test('the model refuses an account that is not there', async () => {
  const client = {
    query: async (text) => {
      if (text.includes('select id, email, role from users')) return { rows: [], rowCount: 0 };
      throw new Error(`unexpected query: ${text}`);
    },
  };

  const { createUsersModel } = await import('../src/models/users.model.js');
  const model = createUsersModel({
    query: async () => ({ rows: [] }),
    withTransaction: async (fn) => fn(client),
  });

  const result = await model.setRole(client, { id: 'missing', role: 'admin' });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'not_found');
});
