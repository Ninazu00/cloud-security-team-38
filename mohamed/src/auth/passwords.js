import { argon2, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

import { unprocessable } from '../errors.js';

/**
 * Password hashing.
 *
 * The runtime ships argon2id in `node:crypto` (Node >= 24), so this file adds no
 * dependency and needs no compiler in the image. A native module such as `argon2`
 * would mean build tools in the `deps` stage and a musl rebuild for Alpine.
 *
 * The stored value is a self-describing string in PHC layout:
 *
 *     argon2id$v=19$m=19456,t=2,p=1$<salt-b64>$<tag-b64>
 *
 * `v=19` is Argon2 version 1.3 written in decimal (0x13). The two trailing fields
 * are standard base64 with the padding stripped, per the PHC string format.
 *
 * Parameters live *inside* the string, which is what makes a cost increase
 * possible later: old rows keep verifying with their own parameters, and
 * `verifyPassword` reports `needsRehash` so the caller can upgrade a row at the
 * moment the plaintext password is available (login, password reset).
 */

const derive = promisify(argon2);

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 72;

/** Cost used for every new hash. 19 MiB / 2 passes / 1 lane is the OWASP floor. */
const POLICY = Object.freeze({
  memory: 19456,
  passes: 2,
  parallelism: 1,
  tagLength: 32,
});

/**
 * Hard ceiling applied to parameters read back from a stored hash. Without it, a
 * row carrying `m=4194304` would ask the task for 4 GiB every time someone tried
 * to log in — a stored hash must never be able to dictate unbounded work.
 */
const CEILING = Object.freeze({
  memory: 65536,
  passes: 4,
  parallelism: 4,
});

const SALT_BYTES = 16;
const ALGORITHM = 'argon2id';
const ARGON2_VERSION = 19;

/**
 * Returns why a password is unacceptable, or `null` when it is fine.
 *
 * One function, two callers: `assertPasswordPolicy` turns a reason into a 422 on
 * the way in, and `verifyPassword` turns it into "wrong password" on the way back
 * (a row whose plaintext could not be stored under today's rules must not be
 * able to log in, but it must not 500 either).
 *
 * The minimum is counted in characters so an emoji is one character; the maximum
 * is counted in UTF-8 bytes, because that is the unit every password hash actually
 * consumes. Keeping a real ceiling matters: a hash function with no byte limit is
 * the reason bcrypt silently truncated at 72, and a later swap to bcrypt must not
 * change which passwords are accepted.
 */
function passwordPolicyProblem(password) {
  if (typeof password !== 'string') return 'not-a-string';

  if ([...password].length < PASSWORD_MIN_LENGTH) return 'too-short';

  if (Buffer.byteLength(password, 'utf8') > PASSWORD_MAX_LENGTH) return 'too-long';

  return null;
}

/**
 * Refuse a password that breaks the policy.
 *
 * `field` names the input in the error, because the same rule guards a sign-up
 * (`password`) and a reset (`newPassword`), and a 422 that points at a field the
 * caller never sent is a 422 nobody can act on.
 */
export function assertPasswordPolicy(password, field = 'password') {
  switch (passwordPolicyProblem(password)) {
    case 'not-a-string':
      throw unprocessable('VALIDATION_FAILED', 'Password must be a string.', { field });
    case 'too-short':
      throw unprocessable(
        'VALIDATION_FAILED',
        `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`,
        { field },
      );
    case 'too-long':
      throw unprocessable(
        'VALIDATION_FAILED',
        `Password must be at most ${PASSWORD_MAX_LENGTH} bytes `
          + `(received ${Buffer.byteLength(password, 'utf8')}).`,
        { field },
      );
    default:
      return;
  }
}

/** Hashes a password with a fresh salt. Returns the PHC string to store. */
export async function hashPassword(password) {
  assertPasswordPolicy(password);

  const salt = randomBytes(SALT_BYTES);
  const tag = await deriveTag(password, salt, POLICY);

  return encode({
    memory: POLICY.memory,
    passes: POLICY.passes,
    parallelism: POLICY.parallelism,
    salt,
    tag,
  });
}

/**
 * Checks a password against a stored PHC string.
 *
 * Never throws for a malformed or unsupported stored value: a corrupt row must
 * read as "wrong password", not as a 500 that reveals the row exists. The caller
 * receives `reason` so the failure can still be logged with a category.
 */
export async function verifyPassword(password, stored) {
  if (typeof password !== 'string' || typeof stored !== 'string') {
    return { ok: false, needsRehash: false, reason: 'malformed' };
  }

  if (passwordPolicyProblem(password) !== null) {
    return { ok: false, needsRehash: false, reason: 'policy' };
  }

  const parsed = decode(stored);
  if (!parsed.ok) {
    return { ok: false, needsRehash: false, reason: parsed.reason };
  }

  const { params, salt, tag } = parsed;
  const candidate = await deriveTag(password, salt, params);

  if (candidate.length !== tag.length || !timingSafeEqual(candidate, tag)) {
    return { ok: false, needsRehash: false, reason: 'mismatch' };
  }

  return { ok: true, needsRehash: isWeakerThanPolicy(params), reason: null };
}

async function deriveTag(password, salt, params) {
  const tag = await derive(ALGORITHM, {
    message: Buffer.from(password, 'utf8'),
    nonce: salt,
    parallelism: params.parallelism,
    tagLength: params.tagLength ?? POLICY.tagLength,
    memory: params.memory,
    passes: params.passes,
  });

  return Buffer.from(tag);
}

/**
 * PHC's B64 is standard base64 **without padding**, not base64url. The difference
 * only shows up in the two characters (`+/` instead of `-_`), but a string that
 * says it is PHC and then uses a different alphabet cannot be handed to any other
 * implementation, so it would be a lie worth only one line of code to avoid.
 */
function b64(buffer) {
  return buffer.toString('base64').replace(/=+$/, '');
}

function encode({ memory, passes, parallelism, salt, tag }) {
  return [
    ALGORITHM,
    `v=${ARGON2_VERSION}`,
    `m=${memory},t=${passes},p=${parallelism}`,
    b64(salt),
    b64(tag),
  ].join('$');
}

function decode(stored) {
  const parts = stored.split('$');
  if (parts.length !== 5) {
    return { ok: false, reason: 'malformed' };
  }

  const [algorithm, version, cost, saltB64, tagB64] = parts;

  if (algorithm !== ALGORITHM || version !== `v=${ARGON2_VERSION}`) {
    return { ok: false, reason: 'unsupported-algorithm' };
  }

  const match = /^m=(\d{1,7}),t=(\d{1,2}),p=(\d{1,2})$/.exec(cost);
  if (!match) {
    return { ok: false, reason: 'malformed' };
  }

  const params = {
    memory: Number(match[1]),
    passes: Number(match[2]),
    parallelism: Number(match[3]),
    tagLength: POLICY.tagLength,
  };

  // Refuse to spend more than the ceiling allows, whatever the row claims.
  if (
    params.memory < 8 ||
    params.memory > CEILING.memory ||
    params.passes < 1 ||
    params.passes > CEILING.passes ||
    params.parallelism < 1 ||
    params.parallelism > CEILING.parallelism
  ) {
    return { ok: false, reason: 'cost-out-of-range' };
  }

  const salt = Buffer.from(saltB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');

  // `Buffer.from(…, 'base64')` skips characters it does not like, so a typo would
  // decode to a shorter buffer instead of failing. Check the alphabet and the exact
  // encoded lengths first: 16 bytes -> 22 chars, 32 bytes -> 43 chars, no padding.
  if (!/^[A-Za-z0-9+/]+$/.test(saltB64) || !/^[A-Za-z0-9+/]+$/.test(tagB64)) {
    return { ok: false, reason: 'malformed' };
  }

  if (saltB64.length !== 22 || salt.length !== SALT_BYTES) {
    return { ok: false, reason: 'malformed' };
  }

  if (tagB64.length !== 43 || tag.length !== POLICY.tagLength) {
    return { ok: false, reason: 'malformed' };
  }

  return { ok: true, params, salt, tag };
}

/**
 * True only when the stored cost is *weaker* than today's policy, so the row is
 * upgraded on the next successful login. A row that is stronger than the policy
 * (a hash made by a future setting) is left alone — rehashing it would be a
 * downgrade dressed up as maintenance.
 */
function isWeakerThanPolicy(params) {
  return params.memory < POLICY.memory || params.passes < POLICY.passes;
}
