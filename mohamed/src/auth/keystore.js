import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import { readFile } from 'node:fs/promises';

/**
 * The signing key, and the two ways it can arrive.
 *
 * The key that signs access tokens is the one secret in this service whose theft
 * is silent: with it, anyone can mint a valid token for any user and any role,
 * and no log line would show it. So it is not stored as a file in deployment. It
 * is stored twice-locked:
 *
 *   1. Secrets Manager holds a *ciphertext* (no plaintext key anywhere on disk).
 *   2. KMS holds the key that can decrypt it (`alias/class-tt-keystore`).
 *
 * At boot the task calls GetSecretValue, then kms:Decrypt, and keeps the parsed
 * key in memory. Each half alone is useless: reading the secret yields ciphertext,
 * calling Decrypt yields nothing to decrypt. The task role therefore needs both
 * grants. On real AWS those two calls also appear in CloudTrail; floci records no
 * audit trail, so the evidence for the assessed deployment is the boot log line
 * (`keystore.unsealed`), not an audit service. That difference is named here so
 * the report does not claim a control it cannot demonstrate.
 *
 * The cached secret (`class-tt/jwt-signing-key`) is JSON, produced by
 * `scripts/seal-key.mjs`:
 *
 *     {
 *       "current": { "kid": "<base64url sha256>", "ciphertext": "<base64 of the sealed PEM>" },
 *       "retired": [ { "kid": "...", "n": "...", "e": "AQAB" } ]
 *     }
 *
 * `retired` exists for key rotation: verifiers keep accepting tokens signed by the
 * previous key until the longest token lifetime has passed, but only the task that
 * unseals `current` can mint new ones.
 *
 * This module deliberately knows nothing about the AWS SDK. It takes two small
 * plain functions (`secrets.getSecretValue`, `kms.decrypt`), so unit tests run
 * offline against fakes and only `src/auth/aws-clients.js` imports the SDK.
 */

const DEFAULT_SECRET_ID = 'class-tt/jwt-signing-key';
const DEFAULT_KEY_FILE = 'keys/dev.pem';
const ALG = 'RS256';

/** RFC 7638 thumbprint: the canonical JWK members, lexicographic, no whitespace. */
export function jwkThumbprint(jwk) {
  const canonical = JSON.stringify({ e: jwk.e, kty: jwk.kty, n: jwk.n });
  return createHash('sha256').update(canonical).digest('base64url');
}

function publicJwkOf(privateKey) {
  const jwk = createPublicKey(privateKey).export({ format: 'jwk' });
  return { kty: jwk.kty, n: jwk.n, e: jwk.e };
}

function publishedEntry(jwk, kid) {
  return { kty: 'RSA', use: 'sig', alg: ALG, kid, n: jwk.n, e: jwk.e };
}

/**
 * Loads the signing key.
 *
 * Precedence is intentional: KMS if configured, a local PEM file only in a
 * non-production environment, and a hard failure otherwise. A production process
 * that quietly fell back to a file would be a silent downgrade of the exact
 * property the design is claiming.
 */
export async function loadKeystore({
  kmsKeyAlias,
  jwtSecretId = DEFAULT_SECRET_ID,
  jwtKeyFile = DEFAULT_KEY_FILE,
  nodeEnv = 'development',
  secrets,
  kms,
  readTextFile = (path) => readFile(path, 'utf8'),
  log = null,
} = {}) {
  if (kmsKeyAlias) {
    return loadFromKms({ kmsKeyAlias, jwtSecretId, secrets, kms, log });
  }

  if (nodeEnv === 'production') {
    throw new Error(
      'KMS_KEY_ALIAS is not set: refusing to start production without a sealed signing key.',
    );
  }

  const pem = await readTextFile(jwtKeyFile);
  const privateKey = parsePem(pem, jwtKeyFile);
  const publicJwk = publicJwkOf(privateKey);
  const kid = jwkThumbprint(publicJwk);

  log?.warn?.({
    msg: 'keystore.unsealed_from_file',
    file: jwtKeyFile,
    kid,
    detail: 'development only; start with KMS_KEY_ALIAS set to use the sealed key',
  });

  return {
    source: 'file',
    current: { kid, privateKey, publicJwk },
    published: [publishedEntry(publicJwk, kid)],
  };
}

async function loadFromKms({ kmsKeyAlias, jwtSecretId, secrets, kms, log }) {
  if (!secrets || !kms) {
    throw new Error(
      'KMS_KEY_ALIAS is set but no AWS clients were supplied: cannot unseal the signing key.',
    );
  }

  const raw = await secrets.getSecretValue(jwtSecretId);

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new Error(`secret ${jwtSecretId} is not JSON.`);
  }

  const current = payload?.current;
  if (!current?.ciphertext || typeof current.ciphertext !== 'string') {
    throw new Error(`secret ${jwtSecretId} has no current.ciphertext.`);
  }

  const sealed = Buffer.from(current.ciphertext, 'base64');
  if (sealed.length < 64) {
    throw new Error(`secret ${jwtSecretId} current.ciphertext is too short to be a sealed PEM.`);
  }

  const plaintext = await kms.decrypt({ ciphertext: sealed, keyId: kmsKeyAlias });
  const privateKey = parsePem(Buffer.from(plaintext).toString('utf8'), `secret ${jwtSecretId}`);
  const publicJwk = publicJwkOf(privateKey);
  const kid = jwkThumbprint(publicJwk);

  // If the secret also pins the public key, a mismatch means the ciphertext and the
  // declared identity came from different keypairs — a swapped or half-rotated
  // secret. Fail rather than publish a kid that does not match the key behind it.
  if (current.kid && current.kid !== kid) {
    throw new Error(
      `secret ${jwtSecretId} declares kid ${current.kid} but the sealed key is ${kid}.`,
    );
  }

  if (current.jwk && jwkThumbprint(current.jwk) !== kid) {
    throw new Error(
      `secret ${jwtSecretId} carries a public JWK that does not match the sealed private key.`,
    );
  }

  const retired = Array.isArray(payload.retired) ? payload.retired : [];
  const published = [
    publishedEntry(publicJwk, kid),
    ...retired
      .filter((entry) => entry?.kid && entry?.n && entry?.e)
      .map((entry) => publishedEntry({ n: entry.n, e: entry.e }, entry.kid)),
  ];

  log?.info?.({ msg: 'keystore.unsealed', kid, keyId: kmsKeyAlias, published: published.length });

  return { source: 'kms', current: { kid, privateKey, publicJwk }, published };
}

function parsePem(text, origin) {
  try {
    return createPrivateKey(text);
  } catch (error) {
    throw new Error(`could not parse the private key from ${origin}: ${error.message}`);
  }
}
