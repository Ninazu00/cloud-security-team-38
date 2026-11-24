/**
 * Mint an access token for testing a peer service.
 *
 * This exists for the hand-off: Timetable and Compare & Share need a token before
 * they have a frontend, and nobody should be asked to log in to test a verifier.
 * It unseals the signing key exactly as the server does, so if this works, the
 * server's boot path works too.
 *
 *   node scripts/mint-test-token.mjs --role admin
 *   node scripts/mint-test-token.mjs --sub 11111111-2222-3333-4444-555555555555 --ttl 600
 *
 * Env: KMS_KEY_ALIAS (or JWT_KEY_FILE in development), JWT_SECRET_ID, AWS_REGION,
 * AWS_ENDPOINT_URL when pointing at the emulator.
 */
import { createAwsPorts } from '../src/auth/aws-clients.js';
import { loadKeystore } from '../src/auth/keystore.js';
import { createTokenService } from '../src/auth/tokens.js';

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

const role = arg('role', 'student');
const sub = arg('sub', '11111111-2222-3333-4444-555555555555');
const ttl = Number(arg('ttl', '7200'));
const kmsKeyAlias = process.env.KMS_KEY_ALIAS;

if (!['student', 'admin'].includes(role)) {
  console.error(`--role must be student or admin, got ${JSON.stringify(role)}`);
  process.exit(1);
}

if (!Number.isFinite(ttl) || ttl <= 0) {
  console.error(`--ttl must be a positive number of seconds, got ${JSON.stringify(arg('ttl'))}`);
  process.exit(1);
}

// Only build AWS clients when there is a sealed key to unseal; with JWT_KEY_FILE
// this script never touches AWS and should not construct an SDK client.
const ports = kmsKeyAlias
  ? createAwsPorts({
      region: process.env.AWS_REGION ?? 'us-east-1',
      endpoint: process.env.AWS_ENDPOINT_URL,
    })
  : null;

const keystore = await loadKeystore({
  kmsKeyAlias,
  jwtSecretId: process.env.JWT_SECRET_ID ?? 'class-tt/jwt-signing-key',
  jwtKeyFile: process.env.JWT_KEY_FILE ?? 'keys/dev.pem',
  nodeEnv: process.env.NODE_ENV ?? 'development',
  secrets: ports?.secrets,
  kms: ports?.kms,
});

const tokens = createTokenService({ keystore, accessTtlSeconds: ttl });
const token = tokens.signAccessToken({ sub, role });
const claims = tokens.verifyAccessToken(token);

console.log(token);
console.error('');
console.error(`source       ${keystore.source}`);
console.error(`kid          ${keystore.current.kid}`);
console.error(`sub          ${claims.sub}`);
console.error(`role         ${claims.role}`);
console.error(`expires      ${new Date(claims.exp * 1000).toISOString()}`);
console.error(`jwks at      GET /.well-known/jwks.json  (${keystore.published.length} key(s) published)`);
