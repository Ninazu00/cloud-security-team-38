import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';

import pg from 'pg';

import { createApp } from '../src/app.js';
import { createActionTokenStore, hashToken } from '../src/auth/action-tokens.js';
import { createAuthMiddleware } from '../src/auth/middleware.js';
import { createSessionService } from '../src/auth/sessions.js';
import { createTokenService } from '../src/auth/tokens.js';
import { createAuthController } from '../src/controllers/auth.controller.js';
import { createCaptureSender } from '../src/email/sender.js';
import { createOutboxWorker } from '../src/email/worker.js';
import { createOutbox } from '../src/models/outbox.model.js';
import { createAuthRouter } from '../src/routes/auth.js';
import { createUsersModel } from '../src/models/users.model.js';
import { createAuthService } from '../src/services/auth.service.js';

/**
 * Registration and email verification, end to end over HTTP.
 *
 * The mail is not stubbed out at the service boundary: the test drives the real
 * outbox and the real worker, with a sender that keeps the messages. That way the
 * token is recovered the way a user recovers it — out of the rendered text — and
 * a token that is never minted, or minted into a payload instead of a mail, fails
 * the test instead of passing it.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const skip = DATABASE_URL ? false : 'needs DATABASE_URL (local stack on :5433)';

const PASSWORD = 'correct horse battery';
const EMAIL_PREFIX = 'reg-test-';

let pool;
let server;
let baseUrl;
let users;
let actionTokens;
let outbox;
let worker;
const capture = createCaptureSender();
const createdEmails = [];
let turnstileOk = true;

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

async function request(path, { method = 'GET', body, cookie } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(cookie ? { cookie } : {}),
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

const newEmail = () => {
  const email = `${EMAIL_PREFIX}${randomUUID()}@example.test`;
  createdEmails.push(email);
  return email;
};

const register = (email, { password = PASSWORD, turnstileToken = 'test-token' } = {}) =>
  request('/api/auth/register', { method: 'POST', body: { email, password, turnstileToken } });

const login = (email, { password = PASSWORD } = {}) =>
  request('/api/auth/login', {
    method: 'POST',
    body: { email, password, turnstileToken: 'test-token' },
  });

/** Run the drainer until the queue is empty, then return the mails it produced. */
async function drainMail() {
  for (let i = 0; i < 5; i += 1) {
    const { claimed } = await worker.runOnce();
    if (claimed === 0) return capture.messages;
  }
  throw new Error('the outbox never drained');
}

function lastTokenFor(email) {
  const message = [...capture.messages].reverse().find((entry) => entry.to === email);
  assert.ok(message, `no mail was sent to ${email}`);
  const match = /verify-email\.html\?token=([A-Za-z0-9_-]+)/.exec(message.text);
  assert.ok(match, 'the verification mail has no link');
  return match[1];
}

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
  const tokens = createTokenService({ keystore, accessTtlSeconds: 7200 });
  users = createUsersModel({ query, withTransaction });
  actionTokens = createActionTokenStore({ query });
  outbox = createOutbox({ query });

  const service = createAuthService({
    users,
    sessions: createSessionService({ withTransaction, graceSeconds: 0 }),
    tokens,
    outbox,
    actionTokens,
    verifyTurnstile: async () => turnstileOk,
    resendLimitPerHour: 3,
  });

  worker = createOutboxWorker({
    outbox,
    send: capture.send,
    issueToken: actionTokens.issue,
    publicBaseUrl: 'http://localhost:3100',
  });

  const auth = {
    router: createAuthRouter({
      controller: createAuthController({ auth: service, tokens }),
      middleware: createAuthMiddleware({ tokens, users }),
      jwks: () => ({ keys: keystore.published }),
    }),
  };

  server = createApp({ auth }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(() => {
  turnstileOk = true;
});

after(async () => {
  if (!DATABASE_URL) return;
  await new Promise((resolve) => server.close(resolve));

  // Outbox rows have no foreign key to users, so they are removed by address.
  await pool.query('delete from email_outbox where to_email like $1', [`${EMAIL_PREFIX}%`]);
  await pool.query('delete from users where email like $1', [`${EMAIL_PREFIX}%`]);
  await pool.end();
});

test('registration answers 202 and hands out no token', { skip }, async () => {
  const email = newEmail();
  const response = await register(email);

  assert.equal(response.status, 202);
  assert.deepEqual(response.json, { status: 'accepted' });
  assert.equal(response.setCookie.length, 0, 'registration must not start a session');
  assert.ok(!response.text.includes('token'), 'no access token in the body');
});

test('a fresh account cannot sign in until the address is confirmed', { skip }, async () => {
  const email = newEmail();
  await register(email);
  await drainMail();

  const attempt = await login(email);
  assert.equal(attempt.status, 403);
  assert.equal(attempt.json.error.code, 'EMAIL_NOT_VERIFIED');
  assert.equal(attempt.json.error.details.resendable, true);
});

test('the mailed link confirms the address, and then login works', { skip }, async () => {
  const email = newEmail();
  await register(email);
  await drainMail();

  const token = lastTokenFor(email);
  const verified = await request('/api/auth/verify-email', {
    method: 'POST',
    body: { token },
  });

  assert.equal(verified.status, 200);
  assert.equal(verified.json.status, 'verified');
  assert.ok(verified.json.emailVerifiedAt);

  const signedIn = await login(email);
  assert.equal(signedIn.status, 200);
  assert.equal(signedIn.json.user.email, email);
});

test('presenting the same link twice is not an error', { skip }, async () => {
  const email = newEmail();
  await register(email);
  await drainMail();
  const token = lastTokenFor(email);

  const first = await request('/api/auth/verify-email', { method: 'POST', body: { token } });
  const second = await request('/api/auth/verify-email', { method: 'POST', body: { token } });

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(second.json.emailVerifiedAt, first.json.emailVerifiedAt, 'the timestamp must not move');
});

test('an unknown or malformed link is refused', { skip }, async () => {
  const unknown = await request('/api/auth/verify-email', {
    method: 'POST',
    body: { token: 'x'.repeat(43) },
  });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.json.error.code, 'INVALID_TOKEN');

  const missing = await request('/api/auth/verify-email', { method: 'POST', body: {} });
  assert.equal(missing.status, 400);
});

test('an expired link is refused', { skip }, async () => {
  const email = newEmail();
  await register(email);
  await drainMail();
  const token = lastTokenFor(email);

  // Age the row rather than the clock: the store compares against `now()`.
  await pool.query(
    `update auth_tokens set expires_at = now() - interval '1 minute' where token_hash = $1`,
    [hashToken(token)],
  );

  const response = await request('/api/auth/verify-email', {
    method: 'POST',
    body: { token },
  });

  assert.equal(response.status, 400);
  assert.equal(response.json.error.code, 'INVALID_TOKEN');
});

test('registering an existing address changes nothing and sends no second mail', { skip }, async () => {
  const email = newEmail();
  await register(email);
  const before = capture.messages.length;
  await drainMail();

  const again = await register(email);
  assert.equal(again.status, 202);
  assert.deepEqual(again.json, { status: 'accepted' });

  await drainMail();
  const mailed = capture.messages.filter((entry) => entry.to === email).length;
  assert.equal(mailed, 1, 'a duplicate registration must not mail the address again');

  const { rows } = await pool.query('select count(*)::int as count from users where email = $1', [email]);
  assert.equal(rows[0].count, 1);
  assert.ok(capture.messages.length >= before);
});

test('an address that is not an email, or a short password, is refused with the field', { skip }, async () => {
  const badEmail = await register('not-an-address');
  assert.equal(badEmail.status, 422);
  assert.equal(badEmail.json.error.details.field, 'email');

  const short = await register(newEmail(), { password: 'short' });
  assert.equal(short.status, 422);
  assert.equal(short.json.error.code, 'VALIDATION_FAILED');
});

test('no Turnstile token means no account and no mail', { skip }, async () => {
  const email = newEmail();
  turnstileOk = false;

  const response = await register(email);
  assert.equal(response.status, 403);
  assert.equal(response.json.error.code, 'TURNSTILE_FAILED');

  const { rows } = await pool.query('select count(*)::int as count from users where email = $1', [email]);
  assert.equal(rows[0].count, 0);
  await drainMail();
  assert.equal(capture.messages.filter((entry) => entry.to === email).length, 0);
});

test('resending replaces the previous link, so only the newest works', { skip }, async () => {
  const email = newEmail();
  await register(email);
  await drainMail();
  const first = lastTokenFor(email);

  const resent = await request('/api/auth/verify-email/resend', {
    method: 'POST',
    body: { email, turnstileToken: 'test-token' },
  });
  assert.equal(resent.status, 202);
  await drainMail();
  const second = lastTokenFor(email);
  assert.notEqual(second, first, 'a resend must mint a new token');

  const stale = await request('/api/auth/verify-email', { method: 'POST', body: { token: first } });
  assert.equal(stale.status, 400, 'the superseded link must stop working');

  const fresh = await request('/api/auth/verify-email', { method: 'POST', body: { token: second } });
  assert.equal(fresh.status, 200);
});

test('resending for an address with no account still answers 202 and sends nothing', { skip }, async () => {
  const email = newEmail();

  const response = await request('/api/auth/verify-email/resend', {
    method: 'POST',
    body: { email, turnstileToken: 'test-token' },
  });

  assert.equal(response.status, 202);
  await drainMail();
  assert.equal(capture.messages.filter((entry) => entry.to === email).length, 0);
});

test('resending for an address that is already confirmed sends nothing', { skip }, async () => {
  const email = newEmail();
  await register(email);
  await drainMail();
  await request('/api/auth/verify-email', { method: 'POST', body: { token: lastTokenFor(email) } });

  const before = capture.messages.filter((entry) => entry.to === email).length;
  const response = await request('/api/auth/verify-email/resend', {
    method: 'POST',
    body: { email, turnstileToken: 'test-token' },
  });

  assert.equal(response.status, 202);
  await drainMail();
  assert.equal(capture.messages.filter((entry) => entry.to === email).length, before);
});

test('the resend limit is per address and answers 429 with the scope', { skip }, async () => {
  const email = newEmail();
  await register(email);

  // Register issues one token when it is sent; three resends hit the cap on the
  // fourth request. Each round drains the queue so a token exists to count.
  await drainMail();
  for (let i = 0; i < 2; i += 1) {
    const ok = await request('/api/auth/verify-email/resend', {
      method: 'POST',
      body: { email, turnstileToken: 'test-token' },
    });
    assert.equal(ok.status, 202, `resend ${i + 1} should be allowed`);
    await drainMail();
  }

  const blocked = await request('/api/auth/verify-email/resend', {
    method: 'POST',
    body: { email, turnstileToken: 'test-token' },
  });

  assert.equal(blocked.status, 429);
  assert.equal(blocked.json.error.code, 'RATE_LIMITED');
  assert.equal(blocked.json.error.details.scope, 'verification_resend');
});

test('the mails carry no token in the stored payload', { skip }, async () => {
  const email = newEmail();
  await register(email);

  const { rows } = await pool.query(
    'select template_key, payload from email_outbox where to_email = $1',
    [email],
  );

  assert.equal(rows.length, 1);
  assert.equal(rows[0].template_key, 'verify_email');
  assert.equal(JSON.stringify(rows[0].payload).includes('token'), false);
});
