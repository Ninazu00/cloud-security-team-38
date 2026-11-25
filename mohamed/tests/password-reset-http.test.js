import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';

import pg from 'pg';

import { createApp } from '../src/app.js';
import { noRateLimit } from './no-rate-limit.js';
import { createActionTokenStore } from '../src/auth/action-tokens.js';
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
 * Password reset, end to end over HTTP, with the real outbox and the real worker.
 *
 * The token is recovered from the rendered mail, so a token that is never minted -
 * or minted into the log instead of the message - fails here rather than in the
 * demo.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const skip = DATABASE_URL ? false : 'needs DATABASE_URL (local stack on :5433)';

const PASSWORD = 'correct horse battery';
const NEW_PASSWORD = 'a completely new passphrase';
const EMAIL_PREFIX = 'reset-test-';

let pool;
let server;
let baseUrl;
let actionTokens;
let worker;
const capture = createCaptureSender();
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
    json: text.length > 0 && response.headers.get('content-type')?.includes('json') ? JSON.parse(text) : null,
    setCookie: response.headers.getSetCookie(),
    text,
  };
}

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
  const match = /reset-password\.html\?token=([A-Za-z0-9_-]+)/.exec(`${message.text}\n${message.html ?? ''}`);
  assert.ok(match, 'the reset mail has no link');
  return match[1];
}

const newEmail = () => `${EMAIL_PREFIX}${randomUUID()}@example.test`;

/** A verified account, created through the same register → verify path a user takes. */
async function createVerifiedAccount(email, password = PASSWORD) {
  await request('/api/auth/register', {
    method: 'POST',
    body: { email, password, turnstileToken: 'test-token' },
  });
  await drainMail();

  const message = [...capture.messages].reverse().find((entry) => entry.to === email);
  const token = /verify-email\.html\?token=([A-Za-z0-9_-]+)/.exec(message.text)[1];
  await request('/api/auth/verify-email', { method: 'POST', body: { token } });
}

const login = (email, password = PASSWORD) =>
  request('/api/auth/login', {
    method: 'POST',
    body: { email, password, turnstileToken: 'test-token' },
  });

const askReset = (email) =>
  request('/api/auth/password-reset/request', {
    method: 'POST',
    body: { email, turnstileToken: 'test-token' },
  });

const confirmReset = (token, newPassword = NEW_PASSWORD) =>
  request('/api/auth/password-reset/confirm', {
    method: 'POST',
    body: { token, newPassword },
  });

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
  const users = createUsersModel({ query, withTransaction });
  actionTokens = createActionTokenStore({ query });
  const outbox = createOutbox({ query });

  const service = createAuthService({
    users,
    sessions: createSessionService({ withTransaction, graceSeconds: 0 }),
    tokens,
    outbox,
    actionTokens,
    verifyTurnstile: async () => turnstileOk,
    withTransaction,
    resetLimitPerHour: 3,
  });

  // Only this file's addresses: `node --test` runs files in parallel against one
  // database, so a worker must not claim another file's mail.
  const ownOutbox = {
    ...outbox,
    claim: (limit) => outbox.claim(limit, { toEmailLike: `${EMAIL_PREFIX}%` }),
  };

  worker = createOutboxWorker({
    outbox: ownOutbox,
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

  server = createApp({ auth, rateLimit: noRateLimit }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(() => {
  turnstileOk = true;
});

after(async () => {
  if (!DATABASE_URL) return;
  await new Promise((resolve) => server.close(resolve));

  await pool.query('delete from email_outbox where to_email like $1', [`${EMAIL_PREFIX}%`]);
  await pool.query('delete from users where email like $1', [`${EMAIL_PREFIX}%`]);
  await pool.end();
});

test('asking for a link answers 202 and sends mail to a real address', { skip }, async () => {
  const email = newEmail();
  await createVerifiedAccount(email);

  const response = await askReset(email);
  assert.equal(response.status, 202);
  assert.deepEqual(response.json, { status: 'accepted' });

  await drainMail();
  const token = lastTokenFor(email);
  assert.ok(token.length >= 40, 'the token is 32 random bytes, base64url encoded');
});

test('asking for an unknown address answers the same 202 and sends nothing', { skip }, async () => {
  const before = capture.messages.length;
  const response = await askReset(newEmail());

  assert.equal(response.status, 202);
  assert.deepEqual(response.json, { status: 'accepted' });

  await drainMail();
  assert.equal(capture.messages.length, before, 'nothing may be sent for an unknown address');
});

test('the mailed link changes the password, and the old one stops working', { skip }, async () => {
  const email = newEmail();
  await createVerifiedAccount(email);

  await askReset(email);
  await drainMail();
  const token = lastTokenFor(email);

  const confirmed = await confirmReset(token);
  assert.equal(confirmed.status, 200);
  assert.deepEqual(confirmed.json, { status: 'reset' });
  assert.equal(confirmed.setCookie.length, 0, 'a reset does not sign anyone in');

  assert.equal((await login(email, PASSWORD)).status, 401, 'the old password is gone');
  assert.equal((await login(email, NEW_PASSWORD)).status, 200, 'the new one works');
});

test('a link works once', { skip }, async () => {
  const email = newEmail();
  await createVerifiedAccount(email);
  await askReset(email);
  await drainMail();
  const token = lastTokenFor(email);

  assert.equal((await confirmReset(token)).status, 200);
  const replay = await confirmReset(token, 'yet another passphrase');

  assert.equal(replay.status, 400);
  assert.equal(replay.json.error.code, 'INVALID_TOKEN');
});

test('an expired link is refused with the same code as an unknown one', { skip }, async () => {
  const email = newEmail();
  await createVerifiedAccount(email);
  await askReset(email);
  await drainMail();
  const token = lastTokenFor(email);

  // Age the row instead of waiting half an hour.
  await pool.query(
    `update auth_tokens set expires_at = now() - interval '1 minute'
      where user_id = (select id from users where email = $1) and purpose = 'password_reset'`,
    [email],
  );

  const response = await confirmReset(token);
  assert.equal(response.status, 400);
  assert.equal(response.json.error.code, 'INVALID_TOKEN');
});

test('a made-up token is refused, and so is a missing one', { skip }, async () => {
  const madeUp = await confirmReset('x'.repeat(43));
  assert.equal(madeUp.status, 400);
  assert.equal(madeUp.json.error.code, 'INVALID_TOKEN');

  const missing = await request('/api/auth/password-reset/confirm', {
    method: 'POST',
    body: { newPassword: NEW_PASSWORD },
  });
  assert.equal(missing.status, 400);
  assert.equal(missing.json.error.code, 'INVALID_TOKEN');
});

test('a password that breaks the policy is refused before the token is spent', { skip }, async () => {
  const email = newEmail();
  await createVerifiedAccount(email);
  await askReset(email);
  await drainMail();
  const token = lastTokenFor(email);

  const weak = await confirmReset(token, 'short');
  assert.equal(weak.status, 422);
  assert.equal(weak.json.error.code, 'VALIDATION_FAILED');
  assert.equal(weak.json.error.details.field, 'newPassword');

  // The link must still be usable: a rejected password is not a used token.
  assert.equal((await confirmReset(token)).status, 200);
});

test('every session for that account is revoked by a reset', { skip }, async () => {
  const email = newEmail();
  await createVerifiedAccount(email);

  const signedIn = await login(email);
  assert.equal(signedIn.status, 200);
  const refreshCookie = signedIn.setCookie[0].split(';')[0];

  const stillValid = await request('/api/auth/refresh', { method: 'POST', cookie: refreshCookie });
  assert.equal(stillValid.status, 200, 'the session works before the reset');

  await askReset(email);
  await drainMail();
  await confirmReset(lastTokenFor(email));

  const afterReset = await request('/api/auth/refresh', { method: 'POST', cookie: refreshCookie });
  assert.equal(afterReset.status, 401, 'the old refresh token died with the password');
  assert.equal(afterReset.json.error.code, 'INVALID_REFRESH');
});

test('a reset confirms the address, because controlling the mailbox is the proof', { skip }, async () => {
  const email = newEmail();
  const registered = await request('/api/auth/register', {
    method: 'POST',
    body: { email, password: PASSWORD, turnstileToken: 'test-token' },
  });
  assert.equal(registered.status, 202, 'registered but never verified');

  // Drain the verification mail first, so the reset mail is the last one for this
  // address and `lastTokenFor` cannot pick the wrong link.
  await drainMail();

  // A password reset is allowed for an unverified account on purpose: the user may
  // have registered with a typo and then had no way to sign in at all.
  await askReset(email);
  await drainMail();
  assert.equal((await confirmReset(lastTokenFor(email))).status, 200);

  assert.equal((await login(email, NEW_PASSWORD)).status, 200, 'and now the account works');
});

test('the fourth request in an hour is refused with the reset scope', { skip }, async () => {
  const email = newEmail();
  await createVerifiedAccount(email);

  assert.equal((await askReset(email)).status, 202);
  assert.equal((await askReset(email)).status, 202);
  assert.equal((await askReset(email)).status, 202);

  const fourth = await askReset(email);
  assert.equal(fourth.status, 429);
  assert.equal(fourth.json.error.code, 'RATE_LIMITED');
  assert.equal(fourth.json.error.details.scope, 'password_reset');
});

test('a reset does not clear a lockout', { skip }, async () => {
  const email = newEmail();
  await createVerifiedAccount(email);

  for (let i = 0; i < 5; i += 1) await login(email, 'definitely wrong');

  await askReset(email);
  await drainMail();
  assert.equal((await confirmReset(lastTokenFor(email))).status, 200);

  const locked = await login(email, NEW_PASSWORD);
  assert.equal(locked.status, 423, 'a guesser cannot reset their way out of the lockout');
  assert.equal(locked.json.error.code, 'LOCKED');
});
