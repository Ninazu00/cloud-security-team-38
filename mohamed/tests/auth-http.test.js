import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createPublicKey, generateKeyPairSync, randomUUID } from 'node:crypto';

import pg from 'pg';

import { createApp } from '../src/app.js';
import { createAuthMiddleware } from '../src/auth/middleware.js';
import { createAuthRouter } from '../src/routes/auth.js';
import { createAuthController } from '../src/controllers/auth.controller.js';
import { createAuthService } from '../src/services/auth.service.js';
import { createSessionService } from '../src/auth/sessions.js';
import { createTokenService } from '../src/auth/tokens.js';
import { createUsersModel } from '../src/models/users.model.js';

/**
 * The auth routes end to end: HTTP in, Postgres underneath, a real RS256 key.
 *
 * Everything external is replaced by its cheapest honest double — an ephemeral
 * keypair instead of KMS, a switch instead of Turnstile — because the subject of
 * these tests is the *wiring*: which status comes out for which input, and whether
 * the cookie and the lockout behave. The cryptography and the unlock path have
 * their own tests (tests/tokens.test.js, tests/keystore.test.js).
 *
 * Skips itself when DATABASE_URL is absent, like tests/sessions.test.js.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const skip = DATABASE_URL ? false : 'needs DATABASE_URL (local stack on :5433)';

const PASSWORD = 'correct horse battery';

let pool;
let withTransaction;
let server;
let baseUrl;
let turnstileOk = true;
const createdEmails = [];

/** A throwaway keystore shaped exactly like the real one. */
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

async function request(path, { method = 'GET', body, token, cookie, headers = {} } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(cookie ? { cookie } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    json: text.length > 0 && response.headers.get('content-type')?.includes('json') ? JSON.parse(text) : null,
    setCookie: response.headers.getSetCookie(),
    text,
  };
}

function refreshCookieOf(response) {
  const raw = response.setCookie.find((value) => value.startsWith('__Secure-refresh='));
  return raw ? raw.split(';')[0] : null;
}

async function createUser({ password = PASSWORD, role = 'student' } = {}) {
  const email = `auth-test-${randomUUID()}@example.test`;
  createdEmails.push(email);
  await users.createVerified({ email, password, role });
  return email;
}

async function login(email, password = PASSWORD) {
  return request('/api/auth/login', {
    method: 'POST',
    body: { email, password, turnstileToken: 'test-token' },
  });
}

let users;

before(async () => {
  if (!DATABASE_URL) return;

  pool = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });
  // A plain BEGIN/COMMIT, without the lock/statement timeouts src/db.js sets: the
  // tests want a failing assertion to time out the test runner, not to be masked
  // by a shorter statement timeout inside the code under test.
  withTransaction = async (fn) => {
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
  const tokens = createTokenService({ keystore, accessTtlSeconds: 7200 });
  // Same shape the production code receives from src/db.js: `query` for one
  // statement, `withTransaction` when two statements must agree.
  users = createUsersModel({ query: (text, params) => pool.query(text, params), withTransaction });

  // graceSeconds: 0 so "reuse outside the grace window" can be tested without
  // sleeping through the real thirty-second window.
  const sessions = createSessionService({ withTransaction, graceSeconds: 0 });

  const service = createAuthService({
    users,
    sessions,
    tokens,
    verifyTurnstile: async () => turnstileOk,
  });

  const auth = {
    router: createAuthRouter({
      controller: createAuthController({ auth: service, tokens }),
      middleware: createAuthMiddleware({ tokens, users }),
      jwks: () => ({ keys: keystore.published }),
    }),
  };

  const app = createApp({ auth });
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(() => {
  turnstileOk = true;
});

after(async () => {
  if (!DATABASE_URL) return;

  await new Promise((resolve) => server.close(resolve));
  if (createdEmails.length > 0) {
    await pool.query('delete from users where email = any($1::text[])', [createdEmails]);
  }
  await pool.end();
});

test('a correct password returns a token, a user snapshot and a hardened cookie', { skip }, async () => {
  const email = await createUser({ role: 'admin' });
  const response = await login(email);

  assert.equal(response.status, 200);
  assert.equal(response.json.tokenType, 'Bearer');
  assert.equal(response.json.expiresIn, 7200);
  assert.equal(response.json.user.role, 'admin');
  assert.equal(response.json.user.email, email);
  assert.equal(typeof response.json.accessToken, 'string');
  assert.equal(response.json.user.password_hash, undefined);

  const cookie = response.setCookie.find((value) => value.startsWith('__Secure-refresh='));
  assert.ok(cookie, 'refresh cookie is set');
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Path=\/api\/auth/);
});

test('a wrong password and an unknown email produce the same 401', { skip }, async () => {
  const email = await createUser();

  const wrong = await login(email, 'not the password');
  const unknown = await login(`nobody-${randomUUID()}@example.test`);

  assert.equal(wrong.status, 401);
  assert.equal(unknown.status, 401);
  assert.equal(wrong.json.error.code, 'INVALID_CREDENTIALS');
  assert.equal(unknown.json.error.code, 'INVALID_CREDENTIALS');
  // Same message too: the body must not hint at which case it was.
  assert.equal(wrong.json.error.message, unknown.json.error.message);
});

test('a failed challenge is refused before any password work', { skip }, async () => {
  const email = await createUser();
  turnstileOk = false;

  const response = await login(email);

  assert.equal(response.status, 403);
  assert.equal(response.json.error.code, 'TURNSTILE_FAILED');
});

test('five failures lock the account, and the lock is reported only with the right password', { skip }, async () => {
  const email = await createUser();

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const response = await login(email, 'wrong password');
    assert.equal(response.status, 401);
  }

  // Wrong password on a locked account is still 401, not 423: answering "locked"
  // here would tell an attacker the address exists.
  const stillWrong = await login(email, 'wrong password');
  assert.equal(stillWrong.status, 401);

  const correct = await login(email);
  assert.equal(correct.status, 423);
  assert.equal(correct.json.error.code, 'LOCKED');
  assert.ok(correct.json.error.details.retryAfterSeconds > 0);
});

test('refresh rotates the cookie and the old token cannot be used twice', { skip }, async () => {
  const email = await createUser();
  const first = await login(email);
  const cookie = refreshCookieOf(first);

  const rotated = await request('/api/auth/refresh', { method: 'POST', cookie });
  assert.equal(rotated.status, 200);
  assert.equal(typeof rotated.json.accessToken, 'string');
  const secondCookie = refreshCookieOf(rotated);
  assert.ok(secondCookie);
  assert.notEqual(secondCookie, cookie);

  const reused = await request('/api/auth/refresh', { method: 'POST', cookie });
  assert.equal(reused.status, 410);
  assert.equal(reused.json.error.code, 'REFRESH_REUSED');

  // Reuse revoked the whole family, so the rotated token is dead as well.
  const after = await request('/api/auth/refresh', { method: 'POST', cookie: secondCookie });
  assert.equal(after.status, 401);
});

test('refresh without a cookie is a 401, not a crash', { skip }, async () => {
  const response = await request('/api/auth/refresh', { method: 'POST' });
  assert.equal(response.status, 401);
  assert.equal(response.json.error.code, 'INVALID_REFRESH');
});

test('logout always answers 204 and clears the cookie', { skip }, async () => {
  const email = await createUser();
  const loginResponse = await login(email);
  const cookie = refreshCookieOf(loginResponse);

  const response = await request('/api/auth/logout', { method: 'POST', cookie });

  assert.equal(response.status, 204);
  const cleared = response.setCookie.find((value) => value.startsWith('__Secure-refresh='));
  assert.ok(cleared);
  assert.match(cleared, /Max-Age=0/);

  // And the token is gone: replaying the cookie cannot refresh.
  const replay = await request('/api/auth/refresh', { method: 'POST', cookie });
  assert.equal(replay.status, 401);
});

test('logout without a cookie still answers 204', { skip }, async () => {
  const response = await request('/api/auth/logout', { method: 'POST' });
  assert.equal(response.status, 204);
});

test('/api/auth/me reads the user from the database', { skip }, async () => {
  const email = await createUser({ role: 'admin' });
  const response = await login(email);

  const me = await request('/api/auth/me', { token: response.json.accessToken });

  assert.equal(me.status, 200);
  assert.equal(me.json.email, email);
  assert.equal(me.json.role, 'admin');
  assert.ok(me.json.emailVerifiedAt);
});

test('/api/auth/me without a token is a 401 in the error envelope', { skip }, async () => {
  const response = await request('/api/auth/me');

  assert.equal(response.status, 401);
  assert.equal(response.json.error.code, 'UNAUTHENTICATED');
  assert.ok(response.json.error.requestId);
});

test('an access token signed with another key is rejected', { skip }, async () => {
  const email = await createUser();
  await login(email);

  const impostor = createTokenService({ keystore: ephemeralKeystore() });
  const forged = impostor.signAccessToken({ sub: randomUUID(), role: 'admin' });

  const response = await request('/api/auth/me', { token: forged });
  assert.equal(response.status, 401);
});

test('the JWKS document publishes only public material', { skip }, async () => {
  const response = await request('/.well-known/jwks.json');

  assert.equal(response.status, 200);
  assert.match(response.headers.get('cache-control'), /max-age=600/);
  assert.equal(response.json.keys.length, 1);
  const [key] = response.json.keys;
  assert.equal(key.kty, 'RSA');
  assert.equal(key.alg, 'RS256');
  assert.equal(key.kid, 'test-kid');
  assert.equal(typeof key.n, 'string');
  assert.equal(key.d, undefined, 'a private exponent must never be published');
});

test('an unknown path still gets the JSON 404 envelope', { skip }, async () => {
  const response = await request('/api/auth/nope');

  assert.equal(response.status, 404);
  assert.equal(response.json.error.code, 'NOT_FOUND');
});
