import assert from 'node:assert/strict';
import { argon2, randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { promisify } from 'node:util';

import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  assertPasswordPolicy,
  hashPassword,
  verifyPassword,
} from '../src/auth/passwords.js';

const derive = promisify(argon2);

const PHC_PATTERN = /^argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/;

/** PHC's B64: standard base64, padding stripped. */
function b64(buffer) {
  return buffer.toString('base64').replace(/=+$/, '');
}

/** Builds a stored row by hand, so a test can pose as an older or hostile row. */
async function craftStoredRow(password, { memory, passes, parallelism }) {
  const salt = randomBytes(16);
  const tag = await derive('argon2id', {
    message: Buffer.from(password, 'utf8'),
    nonce: salt,
    parallelism,
    tagLength: 32,
    memory,
    passes,
  });

  return [
    'argon2id',
    'v=19',
    `m=${memory},t=${passes},p=${parallelism}`,
    b64(salt),
    b64(Buffer.from(tag)),
  ].join('$');
}

test('hashPassword produces a self-describing PHC string', async () => {
  const stored = await hashPassword('correct horse battery staple');

  assert.match(stored, PHC_PATTERN);
  assert.ok(!stored.includes('correct horse'), 'the plaintext must not appear in the hash');
});

test('verifyPassword accepts the right password and rejects a wrong one', async () => {
  const stored = await hashPassword('correct horse battery staple');

  assert.deepEqual(await verifyPassword('correct horse battery staple', stored), {
    ok: true,
    needsRehash: false,
    reason: null,
  });
  assert.equal((await verifyPassword('correct horse battery stapl', stored)).ok, false);
  assert.equal((await verifyPassword('Correct horse battery staple', stored)).ok, false);
});

test('two hashes of the same password differ, because the salt is random', async () => {
  const first = await hashPassword('correct horse battery staple');
  const second = await hashPassword('correct horse battery staple');

  assert.notEqual(first, second);
  assert.equal((await verifyPassword('correct horse battery staple', second)).ok, true);
});

test('a row with weaker cost still verifies and asks to be rehashed', async () => {
  const stored = await craftStoredRow('correct horse battery staple', {
    memory: 8192,
    passes: 1,
    parallelism: 1,
  });

  const result = await verifyPassword('correct horse battery staple', stored);
  assert.equal(result.ok, true);
  assert.equal(result.needsRehash, true);
});

test('a row claiming more work than the ceiling is refused instead of executed', async () => {
  const stored = await craftStoredRow('correct horse battery staple', {
    memory: 65536,
    passes: 2,
    parallelism: 1,
  });
  const absurd = stored.replace('m=65536', 'm=4194304');

  const started = process.hrtime.bigint();
  const result = await verifyPassword('correct horse battery staple', absurd);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

  assert.deepEqual(result, { ok: false, needsRehash: false, reason: 'cost-out-of-range' });
  assert.ok(elapsedMs < 50, `refused in ${elapsedMs.toFixed(1)} ms, before deriving anything`);
});

test('a malformed or foreign stored value reads as a wrong password, never a crash', async () => {
  const cases = [
    '',
    'x',
    'argon2id$v=19$m=19456,t=2,p=1$tooShort$tooShort',
    'argon2id$v=19$m=abc,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    'bcrypt$2b$12$abcdefghijklmnopqrstuv',
    null,
    undefined,
    42,
  ];

  for (const stored of cases) {
    const result = await verifyPassword('correct horse battery staple', stored);
    assert.equal(result.ok, false, `stored value ${JSON.stringify(stored)} should not verify`);
    assert.equal(result.needsRehash, false);
    assert.ok(typeof result.reason === 'string');
  }
});

test('the password policy is measured in characters for the floor and bytes for the ceiling', async () => {
  assert.throws(() => assertPasswordPolicy('short'), {
    code: 'VALIDATION_FAILED',
    status: 422,
  });
  assert.throws(() => assertPasswordPolicy(1234), { code: 'VALIDATION_FAILED' });

  assert.equal(PASSWORD_MIN_LENGTH, 10);
  assert.doesNotThrow(() => assertPasswordPolicy('a'.repeat(PASSWORD_MIN_LENGTH)));

  // 40 characters, but 80 UTF-8 bytes: the byte ceiling is what hashing consumes.
  const wide = 'ä'.repeat(40);
  assert.equal([...wide].length, 40);
  assert.ok(Buffer.byteLength(wide, 'utf8') > PASSWORD_MAX_LENGTH);
  assert.throws(() => assertPasswordPolicy(wide), { code: 'VALIDATION_FAILED' });
});

test('a password outside the policy is refused before any derivation', async () => {
  const stored = await hashPassword('correct horse battery staple');

  const tooShort = await verifyPassword('short', stored);
  assert.deepEqual(tooShort, { ok: false, needsRehash: false, reason: 'policy' });

  const tooLong = await verifyPassword('ä'.repeat(40), stored);
  assert.equal(tooLong.reason, 'policy');
});
