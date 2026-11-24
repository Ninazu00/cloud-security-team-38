import assert from 'node:assert/strict';
import {
  createHmac,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as signBytes,
} from 'node:crypto';
import { test } from 'node:test';

import { jwkThumbprint } from '../src/auth/keystore.js';
import { createTokenService, createTokenVerifier } from '../src/auth/tokens.js';

function makeKeystore() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  const jwk = createPublicKey(publicKey).export({ format: 'jwk' });
  const publicJwk = { kty: jwk.kty, n: jwk.n, e: jwk.e };
  const kid = jwkThumbprint(publicJwk);

  return {
    kid,
    publicPem: publicKey,
    keystore: {
      current: { kid, privateKey: createPrivateKey(privateKey), publicJwk },
      published: [{ kty: 'RSA', use: 'sig', alg: 'RS256', kid, n: jwk.n, e: jwk.e }],
    },
  };
}

function serviceAt(keystore, seconds, overrides = {}) {
  return createTokenService({
    keystore,
    now: () => seconds * 1000,
    ...overrides,
  });
}

const b64 = (value) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');

function craft(keystore, { header, payload, signature }) {
  const input = `${b64(header)}.${b64(payload)}`;
  const sig = signature ?? signBytes('RSA-SHA256', Buffer.from(input), keystore.current.privateKey).toString('base64url');
  return `${input}.${sig}`;
}

function expectRejection(fn, expectedReason) {
  assert.throws(fn, (error) => {
    assert.equal(error.status, 401);
    assert.equal(error.code, 'UNAUTHENTICATED');
    assert.equal(error.message, 'Missing or invalid access token.');
    if (expectedReason) assert.equal(error.reason, expectedReason);
    return true;
  });
}

test('a minted token round-trips and carries exactly the contract claims', () => {
  const { keystore } = makeKeystore();
  const service = serviceAt(keystore, 1_700_000_000);

  const token = service.signAccessToken({ sub: '11111111-2222-3333-4444-555555555555', role: 'admin' });

  assert.equal(token.split('.').length, 3);

  const claims = service.verifyAccessToken(token);
  assert.equal(claims.sub, '11111111-2222-3333-4444-555555555555');
  assert.equal(claims.role, 'admin');
  assert.equal(claims.iss, 'class-tt');
  assert.equal(claims.aud, 'class-tt');
  assert.equal(claims.exp - claims.iat, 7200);
  assert.equal(typeof claims.jti, 'string');
  assert.ok(claims.jti.length > 0);

  // No email, no name: the payload is readable by anyone holding the public key.
  const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
  assert.deepEqual(Object.keys(payload).sort(), ['aud', 'exp', 'iat', 'iss', 'jti', 'role', 'sub']);
});

test('the header names the algorithm and the key that signed it', () => {
  const { keystore, kid } = makeKeystore();
  const service = serviceAt(keystore, 1_700_000_000);

  const token = service.signAccessToken({ sub: 'abc', role: 'student' });
  const header = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8'));

  assert.deepEqual(header, { alg: 'RS256', typ: 'JWT', kid });
});

test('an expired token is rejected, and the 60-second skew is honoured', () => {
  const { keystore } = makeKeystore();
  const issuedAt = 1_700_000_000;
  const token = serviceAt(keystore, issuedAt).signAccessToken({ sub: 'abc', role: 'student' });

  // 30 s past expiry: inside the skew window, still usable.
  assert.ok(serviceAt(keystore, issuedAt + 7200 + 30).verifyAccessToken(token));

  // 61 s past expiry: rejected as expired.
  expectRejection(
    () => serviceAt(keystore, issuedAt + 7200 + 61).verifyAccessToken(token),
    'expired',
  );
});

test('a token whose iat is far in the future is rejected', () => {
  const { keystore } = makeKeystore();
  const token = serviceAt(keystore, 1_700_000_000 + 3600).signAccessToken({ sub: 'abc', role: 'student' });

  expectRejection(() => serviceAt(keystore, 1_700_000_000).verifyAccessToken(token), 'iat-future');
});

test('wrong issuer or audience is rejected even with a valid signature', () => {
  const { keystore } = makeKeystore();

  const wrongIssuer = serviceAt(keystore, 1_700_000_000, { issuer: 'someone-else' })
    .signAccessToken({ sub: 'abc', role: 'student' });
  expectRejection(() => serviceAt(keystore, 1_700_000_000).verifyAccessToken(wrongIssuer), 'iss');

  const wrongAudience = serviceAt(keystore, 1_700_000_000, { audience: 'other-product' })
    .signAccessToken({ sub: 'abc', role: 'student' });
  expectRejection(() => serviceAt(keystore, 1_700_000_000).verifyAccessToken(wrongAudience), 'aud');
});

test('alg: none is rejected before any signature work', () => {
  const { keystore } = makeKeystore();
  const service = serviceAt(keystore, 1_700_000_000);

  const token = craft(keystore, {
    header: { alg: 'none', typ: 'JWT', kid: keystore.current.kid },
    payload: { iss: 'class-tt', aud: 'class-tt', sub: 'abc', role: 'admin', iat: 1_700_000_000, exp: 1_700_007_200, jti: 'x' },
    signature: 'A',
  });

  expectRejection(() => service.verifyAccessToken(token), 'alg:none');
});

test('an HS256 token signed with the public key is rejected (key confusion)', () => {
  const { keystore, publicPem } = makeKeystore();
  const service = serviceAt(keystore, 1_700_000_000);

  const header = b64({ alg: 'HS256', typ: 'JWT', kid: keystore.current.kid });
  const payload = b64({ iss: 'class-tt', aud: 'class-tt', sub: 'abc', role: 'admin', iat: 1_700_000_000, exp: 1_700_007_200, jti: 'x' });
  const signature = createHmac('sha256', publicPem).update(`${header}.${payload}`).digest('base64url');

  expectRejection(() => service.verifyAccessToken(`${header}.${payload}.${signature}`), 'alg:HS256');
});

test('a tampered payload fails the signature check', () => {
  const { keystore } = makeKeystore();
  const service = serviceAt(keystore, 1_700_000_000);

  const token = service.signAccessToken({ sub: 'abc', role: 'student' });
  const [header, payload, signature] = token.split('.');

  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  claims.role = 'admin';
  const forged = `${header}.${b64(claims)}.${signature}`;

  expectRejection(() => service.verifyAccessToken(forged), 'signature');
});

test('a token signed by a key we do not publish is rejected by kid', () => {
  const { keystore } = makeKeystore();
  const { keystore: attacker } = makeKeystore();
  const service = serviceAt(keystore, 1_700_000_000);

  const token = serviceAt(attacker, 1_700_000_000).signAccessToken({ sub: 'abc', role: 'admin' });

  expectRejection(() => service.verifyAccessToken(token), 'unknown-kid');
});

test('garbage in every shape is rejected as UNAUTHENTICATED', () => {
  const { keystore } = makeKeystore();
  const service = serviceAt(keystore, 1_700_000_000);

  for (const token of ['', 'a', 'a.b', 'a.b.c', 'not.a.token', `${'x'.repeat(5000)}.y.z`, null, 42]) {
    expectRejection(() => service.verifyAccessToken(token), 'shape');
  }
});

test('a relying party with only the public keys verifies the token, and cannot mint one', () => {
  const { keystore } = makeKeystore();
  const service = serviceAt(keystore, 1_700_000_000);

  const token = service.signAccessToken({ sub: 'abc', role: 'student' });

  // Exactly what Timetable or Compare & Share holds: the JWKS document and nothing else.
  // Its only knowledge of us is the public key set — no shared secret to sign with.
  const peer = createTokenVerifier({
    published: keystore.published,
    now: () => 1_700_000_000 * 1000,
  });

  assert.equal(peer.verifyAccessToken(token).role, 'student');
  assert.deepEqual(peer.kids, [keystore.current.kid]);
  assert.equal(peer.signAccessToken, undefined);
});

test('a verifier only accepts keys it was given, never a key named in the token', () => {
  const { keystore } = makeKeystore();
  const service = serviceAt(keystore, 1_700_000_000);
  const token = service.signAccessToken({ sub: 'abc', role: 'student' });

  const peerWithNoKeys = createTokenVerifier({ published: [] });
  expectRejection(() => peerWithNoKeys.verifyAccessToken(token), 'unknown-kid');
});

test('the service refuses to mint a token it could not verify', () => {
  const { keystore } = makeKeystore();
  const service = serviceAt(keystore, 1_700_000_000);

  assert.throws(() => service.signAccessToken({ sub: 'abc', role: 'root' }), /refused role/);
  assert.throws(() => service.signAccessToken({ sub: '', role: 'student' }), /non-empty sub/);
  assert.throws(() => service.signAccessToken({ sub: 123, role: 'student' }), /non-empty sub/);
});
