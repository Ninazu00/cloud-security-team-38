#!/usr/bin/env node
import { generateKeyPairSync, createPublicKey } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { createAwsPorts } from '../src/auth/aws-clients.js';
import { jwkThumbprint } from '../src/auth/keystore.js';

/**
 * Creates the token-signing key and seals it.
 *
 *   node scripts/seal-key.mjs --dev
 *       Writes keys/dev.pem (mode 0600). Local boot only; loadKeystore refuses this
 *       path in production. Nothing touches AWS.
 *
 *   node scripts/seal-key.mjs
 *       Generates an RSA-2048 keypair, encrypts the PEM with KMS, and writes the
 *       ciphertext into a Secrets Manager secret. The PEM never reaches the disk.
 *       Prints the kid to publish.
 *
 *   node scripts/seal-key.mjs --key keys/dev.pem
 *       Same, but seals an existing PEM instead of generating one - this is how a
 *       key already in use is moved into the vault without changing its kid.
 *
 * Rotation (`--rotate`) keeps the old key's public half in `retired`, so tokens
 * signed by it keep verifying until they expire.
 *
 * Environment: KMS_KEY_ALIAS (default alias/class-tt-keystore), JWT_SECRET_ID
 * (default class-tt/jwt-signing-key), AWS_REGION, AWS_ENDPOINT_URL.
 */

const args = process.argv.slice(2);

function flag(name) {
  return args.includes(`--${name}`);
}

function value(name, fallback) {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

const DEV_MODE = flag('dev');
const KEY_PATH = resolve(value('key', 'keys/dev.pem'));
const KMS_KEY_ALIAS = value('alias', process.env.KMS_KEY_ALIAS ?? 'alias/class-tt-keystore');
const SECRET_ID = value('secret', process.env.JWT_SECRET_ID ?? 'class-tt/jwt-signing-key');
const REGION = value('region', process.env.AWS_REGION ?? 'us-east-1');
const ENDPOINT = value('endpoint', process.env.AWS_ENDPOINT_URL ?? process.env.AWS_ENDPOINT);

function generatePem() {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return privateKey;
}

async function main() {
  const pem = flag('key') ? await readFile(KEY_PATH, 'utf8') : generatePem();
  const publicJwk = createPublicKey(pem).export({ format: 'jwk' });
  const jwk = { kty: publicJwk.kty, n: publicJwk.n, e: publicJwk.e };
  const kid = jwkThumbprint(jwk);

  if (DEV_MODE) {
    await mkdir(dirname(KEY_PATH), { recursive: true, mode: 0o700 });
    await writeFile(KEY_PATH, pem, { mode: 0o600 });
    console.log(`wrote ${KEY_PATH} (mode 0600)`);
    console.log(`kid ${kid}`);
    console.log('development only: loadKeystore refuses this path when NODE_ENV=production');
    return;
  }

  // A developer script that talks to floci: the dummy credential pair is passed
  // explicitly, never inferred from the environment (see aws-clients.js).
  const ports = createAwsPorts({ region: REGION, endpoint: ENDPOINT, testCredentials: true });
  const ciphertext = await ports.kms.encrypt({ plaintext: pem, keyId: KMS_KEY_ALIAS });

  let retired = [];
  let action = 'created';
  let previous = null;

  try {
    previous = JSON.parse(await ports.secrets.getSecretValue(SECRET_ID));
    retired = Array.isArray(previous.retired) ? [...previous.retired] : [];
    action = 'updated';
  } catch (error) {
    if (error?.name !== 'ResourceNotFoundException') throw error;
  }

  if (previous?.current?.jwk && previous.current.kid !== kid) {
    if (!flag('rotate')) {
      throw new Error(
        `secret ${SECRET_ID} already holds kid ${previous.current.kid}. `
          + 'Pass --rotate to retire it and publish both keys.',
      );
    }
    retired = [
      ...retired.filter((entry) => entry.kid !== previous.current.kid),
      { kid: previous.current.kid, n: previous.current.jwk.n, e: previous.current.jwk.e },
    ];
  }

  const payload = JSON.stringify({ current: { kid, ciphertext: ciphertext.toString('base64'), jwk }, retired });

  await ports.secrets.ensureSecret(SECRET_ID, payload, 'JWT signing key, sealed by KMS');

  console.log(`sealed key with ${KMS_KEY_ALIAS} at ${ENDPOINT ?? `AWS ${REGION}`}`);
  console.log(`secret ${SECRET_ID} ${action}`);
  console.log(`kid ${kid}`);
  console.log(`ciphertext ${ciphertext.length} bytes, retired ${retired.length}`);
  console.log('publish this kid in GET /.well-known/jwks.json');
}

main().catch((error) => {
  console.error(`seal-key failed: ${error.message}`);
  process.exit(1);
});
