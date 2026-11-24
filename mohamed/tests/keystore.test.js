import assert from 'node:assert/strict';
import { createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { jwkThumbprint, loadKeystore } from '../src/auth/keystore.js';

function makeKey() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const jwk = createPublicKey(publicKey).export({ format: 'jwk' });
  const publicJwk = { kty: jwk.kty, n: jwk.n, e: jwk.e };

  return { pem: privateKey, publicJwk, kid: jwkThumbprint(publicJwk) };
}

function fakePorts({ payload, pem }) {
  return {
    secrets: {
      async getSecretValue() {
        return typeof payload === 'string' ? payload : JSON.stringify(payload);
      },
    },
    kms: {
      async decrypt() {
        return Buffer.from(pem, 'utf8');
      },
    },
  };
}

function sealedPayload(key, extra = {}) {
  return {
    current: {
      kid: key.kid,
      ciphertext: Buffer.from('x'.repeat(600)).toString('base64'),
      jwk: key.publicJwk,
    },
    retired: [],
    ...extra,
  };
}

test('unseals the key from Secrets Manager plus KMS and publishes a usable JWKS entry', async () => {
  const key = makeKey();
  const { secrets, kms } = fakePorts({ payload: sealedPayload(key), pem: key.pem });

  const keystore = await loadKeystore({
    kmsKeyAlias: 'alias/class-tt-keystore',
    secrets,
    kms,
  });

  assert.equal(keystore.source, 'kms');
  assert.equal(keystore.current.kid, key.kid);
  assert.equal(keystore.published.length, 1);
  assert.deepEqual(
    { kty: keystore.published[0].kty, use: keystore.published[0].use, alg: keystore.published[0].alg },
    { kty: 'RSA', use: 'sig', alg: 'RS256' },
  );

  // The published JWK has to be enough for another service to verify a token,
  // with no access to the private key and no call back to this service.
  const message = Buffer.from('header.payload');
  const signature = sign('RSA-SHA256', message, keystore.current.privateKey);
  const verifier = createPublicKey({ key: keystore.published[0], format: 'jwk' });

  assert.equal(verify('RSA-SHA256', message, verifier, signature), true);
  assert.equal(verify('RSA-SHA256', Buffer.from('header.payload2'), verifier, signature), false);
});

test('retired keys stay published so tokens signed by them keep verifying', async () => {
  const current = makeKey();
  const previous = makeKey();

  const keystore = await loadKeystore({
    kmsKeyAlias: 'alias/class-tt-keystore',
    ...fakePorts({
      payload: sealedPayload(current, {
        retired: [{ kid: previous.kid, n: previous.publicJwk.n, e: previous.publicJwk.e }],
      }),
      pem: current.pem,
    }),
  });

  assert.deepEqual(keystore.published.map((entry) => entry.kid), [current.kid, previous.kid]);
  assert.equal(keystore.current.kid, current.kid);
});

test('a secret whose declared kid does not match the sealed key is refused', async () => {
  const key = makeKey();
  const other = makeKey();

  await assert.rejects(
    loadKeystore({
      kmsKeyAlias: 'alias/class-tt-keystore',
      ...fakePorts({ payload: { current: { kid: other.kid, ciphertext: 'A'.repeat(800) } }, pem: key.pem }),
    }),
    /declares kid .* but the sealed key is/,
  );
});

test('a secret whose pinned public JWK belongs to another key is refused', async () => {
  const key = makeKey();
  const other = makeKey();

  await assert.rejects(
    loadKeystore({
      kmsKeyAlias: 'alias/class-tt-keystore',
      ...fakePorts({
        payload: { current: { kid: key.kid, ciphertext: 'A'.repeat(800), jwk: other.publicJwk } },
        pem: key.pem,
      }),
    }),
    /public JWK that does not match/,
  );
});

test('a malformed secret fails loudly instead of yielding a broken keystore', async () => {
  const key = makeKey();

  await assert.rejects(
    loadKeystore({
      kmsKeyAlias: 'alias/class-tt-keystore',
      ...fakePorts({ payload: 'not json at all', pem: key.pem }),
    }),
    /is not JSON/,
  );

  await assert.rejects(
    loadKeystore({
      kmsKeyAlias: 'alias/class-tt-keystore',
      ...fakePorts({ payload: { current: {} }, pem: key.pem }),
    }),
    /no current\.ciphertext/,
  );

  await assert.rejects(
    loadKeystore({
      kmsKeyAlias: 'alias/class-tt-keystore',
      ...fakePorts({ payload: { current: { ciphertext: 'AAAA' } }, pem: key.pem }),
    }),
    /too short to be a sealed PEM/,
  );
});

test('production refuses to boot without KMS instead of falling back to a file', async () => {
  await assert.rejects(
    loadKeystore({ nodeEnv: 'production', jwtKeyFile: 'does-not-matter.pem' }),
    /refusing to start production without a sealed signing key/,
  );
});

test('development may read a PEM file, and says so', async () => {
  const key = makeKey();
  const dir = await mkdtemp(join(tmpdir(), 'class-tt-keys-'));
  const path = join(dir, 'dev.pem');
  await writeFile(path, key.pem, { mode: 0o600 });

  const warnings = [];
  const keystore = await loadKeystore({
    nodeEnv: 'development',
    jwtKeyFile: path,
    log: { warn: (line) => warnings.push(line) },
  });

  assert.equal(keystore.source, 'file');
  assert.equal(keystore.current.kid, key.kid);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].msg, 'keystore.unsealed_from_file');
});

test('the thumbprint is stable for a key and changes with it', async () => {
  const first = makeKey();
  const second = makeKey();

  assert.equal(jwkThumbprint(first.publicJwk), first.kid);
  assert.notEqual(first.kid, second.kid);
  assert.equal(first.kid.length, 43);
});
