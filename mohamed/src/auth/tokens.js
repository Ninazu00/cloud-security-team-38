import { createPublicKey, randomUUID, sign as signBytes, verify as verifyBytes } from 'node:crypto';

import { unauthorized } from '../errors.js';

/**
 * Access tokens: minting and verification.
 *
 * A JWT is three base64url segments joined by dots — `header.payload.signature` —
 * where the signature is RSA-SHA256 over the first two segments. It is *signed*,
 * not encrypted: anyone holding the public key can read the claims. So nothing
 * secret ever goes in the payload, and this module refuses to put an email address
 * there (the contract fixes the claim set at `iss`/`aud`/`sub`/`role`/`iat`/`exp`/`jti`).
 *
 * Two roles, deliberately separate:
 *
 *   createTokenService({ keystore })   — the issuer: signs, and can verify its own.
 *   createTokenVerifier({ published }) — a relying party: holds ONLY public keys.
 *
 * That split is the federation property in code. Timetable and Compare & Share use
 * the verifier with the JWKS document and never possess anything that could mint a
 * token. Keeping signing and verification in one object would make the wrong thing
 * easy to hand to a peer.
 *
 * The signing itself is ~10 lines of `node:crypto`, so there is no JWT library and
 * no dependency to audit. The cost of hand-rolling is that every validation rule has
 * to be written and tested explicitly — which is what the test file is for, including
 * the two classic attacks (`alg: none`, and RS256 → HS256 key confusion).
 *
 * One error for every failure. A caller learns "not authenticated", never "expired
 * at 14:02" — the difference is an oracle that tells an attacker whether a guessed
 * token was ever valid. The specific reason is attached to the error for the log,
 * and never reaches the response body.
 */

const ALG = 'RS256';
const MAX_TOKEN_LENGTH = 4096;
const ROLES = new Set(['student', 'admin']);
const B64URL = /^[A-Za-z0-9_-]+$/;

/** The issuer: signs tokens with the unsealed private key. */
export function createTokenService({
  keystore,
  issuer = 'class-tt',
  audience = 'class-tt',
  accessTtlSeconds = 7200,
  clockSkewSeconds = 60,
  now = () => Date.now(),
  newId = randomUUID,
} = {}) {
  if (!keystore?.current?.privateKey) {
    throw new Error('createTokenService needs a keystore with a private key.');
  }

  const signingKey = keystore.current.privateKey;
  const kid = keystore.current.kid;

  const verifyAccessToken = createTokenVerifier({
    published: keystore.published,
    issuer,
    audience,
    clockSkewSeconds,
    now,
  }).verifyAccessToken;

  function signAccessToken({ sub, role }) {
    if (typeof sub !== 'string' || sub.length === 0 || sub.length > 64) {
      throw new Error('signAccessToken needs a non-empty sub of at most 64 characters.');
    }
    if (!ROLES.has(role)) {
      throw new Error(`signAccessToken refused role ${JSON.stringify(role)}.`);
    }

    const issuedAt = Math.floor(now() / 1000);

    const header = { alg: ALG, typ: 'JWT', kid };
    const payload = {
      iss: issuer,
      aud: audience,
      sub,
      role,
      iat: issuedAt,
      exp: issuedAt + accessTtlSeconds,
      jti: newId(),
    };

    const signingInput = `${encodeJson(header)}.${encodeJson(payload)}`;
    const signature = signBytes('RSA-SHA256', Buffer.from(signingInput), signingKey);

    return `${signingInput}.${signature.toString('base64url')}`;
  }

  return { signAccessToken, verifyAccessToken, kid, issuer, audience, accessTtlSeconds };
}

/**
 * A relying party: verifies with public keys only.
 *
 * `published` is the JWKS document — either the live `keystore.published` inside
 * this service, or the array another team fetched from `/.well-known/jwks.json`.
 * Nothing here can sign, which is the point.
 */
export function createTokenVerifier({
  published = [],
  issuer = 'class-tt',
  audience = 'class-tt',
  clockSkewSeconds = 60,
  now = () => Date.now(),
} = {}) {
  // Built once, so an unknown `kid` is a map miss rather than an AWS call.
  const verificationKeys = new Map();

  for (const entry of published) {
    if (!entry?.kid) continue;
    verificationKeys.set(entry.kid, createPublicKey({ key: entry, format: 'jwk' }));
  }

  function verifyAccessToken(token) {
    const reject = (reason) => {
      const error = unauthorized('UNAUTHENTICATED', 'Missing or invalid access token.');
      error.reason = reason;
      return error;
    };

    if (typeof token !== 'string' || token.length < 20 || token.length > MAX_TOKEN_LENGTH) {
      throw reject('shape');
    }

    const parts = token.split('.');
    if (parts.length !== 3 || !parts.every((part) => B64URL.test(part))) {
      throw reject('shape');
    }

    const [headerB64, payloadB64, signatureB64] = parts;

    const header = decodeJson(headerB64);
    if (!header || typeof header !== 'object') throw reject('header');

    // This line is the whole defence against algorithm substitution. The token's
    // own `alg` is compared to the single algorithm we accept; it is never used to
    // select the verification routine. An `alg: none` token lands here, and so does
    // an `HS256` token whose "signature" is an HMAC keyed with our public PEM.
    if (header.alg !== ALG) throw reject(`alg:${String(header.alg).slice(0, 16)}`);
    if (header.typ !== undefined && header.typ !== 'JWT') throw reject('typ');

    const verificationKey = verificationKeys.get(header.kid);
    if (!verificationKey) throw reject('unknown-kid');

    const signature = Buffer.from(signatureB64, 'base64url');
    const signingInput = Buffer.from(`${headerB64}.${payloadB64}`);

    let signatureValid = false;
    try {
      signatureValid = verifyBytes('RSA-SHA256', signingInput, verificationKey, signature);
    } catch {
      signatureValid = false;
    }
    if (!signatureValid) throw reject('signature');

    const claims = decodeJson(payloadB64);
    if (!claims || typeof claims !== 'object') throw reject('payload');

    if (claims.iss !== issuer) throw reject('iss');

    // A JWT may carry `aud` as a string or an array of strings. Our contract fixes
    // it to one string, so anything else — including a multi-audience token from
    // somewhere else — is simply not ours.
    if (claims.aud !== audience) throw reject('aud');

    const nowSeconds = now() / 1000;

    if (typeof claims.exp !== 'number') throw reject('exp-type');
    if (nowSeconds > claims.exp + clockSkewSeconds) throw reject('expired');

    if (typeof claims.iat !== 'number') throw reject('iat-type');
    if (claims.iat > nowSeconds + clockSkewSeconds) throw reject('iat-future');

    if (typeof claims.sub !== 'string' || claims.sub.length === 0) throw reject('sub');
    if (!ROLES.has(claims.role)) throw reject('role');
    if (typeof claims.jti !== 'string' || claims.jti.length === 0) throw reject('jti');

    return Object.freeze({
      sub: claims.sub,
      role: claims.role,
      jti: claims.jti,
      iat: claims.iat,
      exp: claims.exp,
      iss: claims.iss,
      aud: claims.aud,
    });
  }

  return { verifyAccessToken, kids: [...verificationKeys.keys()] };
}

function encodeJson(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeJson(segment) {
  try {
    const text = Buffer.from(segment, 'base64url').toString('utf8');
    const value = JSON.parse(text);
    return typeof value === 'object' && value !== null ? value : null;
  } catch {
    return null;
  }
}
