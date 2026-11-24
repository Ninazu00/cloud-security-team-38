import { badRequest, forbidden, locked, unauthorized } from '../errors.js';
import { hashPassword, verifyPassword } from '../auth/passwords.js';
import { turnstileFailed } from '../auth/turnstile.js';

/**
 * Login, refresh, logout, and "who am I".
 *
 * The rule that shapes this file: **nothing reveals whether an account exists**
 * until the caller has proved they control it. Two mechanisms implement it.
 *
 *  1. A constant dummy hash. When the email is unknown we still verify the supplied
 *     password against `DUMMY_HASH`, so the response time for "no such user" and
 *     "wrong password" is the same ~50 ms of Argon2id. Skipping the hash on an
 *     unknown email would make the fastest response the tell.
 *  2. Password before state. The lock and the verification flag are inspected only
 *     after a *correct* password. Checked earlier, "unknown email" would answer 401
 *     while "known but locked" answered 423 — an enumeration oracle built out of
 *     error codes. The price is one hash per attempt on a locked account, bounded
 *     by the rate limit.
 */

// A real Argon2id hash of a password nobody knows, used only for its timing.
const DUMMY_HASH =
  'argon2id$v=19$m=19456,t=2,p=1$K/lCj3ZSVdsMiF9qvJD3tQ$igW9/R7WzvdWcp2SdQRF0TLTwG/a0aSLRLWS8EI9pp4';

export function createAuthService({
  users,
  sessions,
  tokens,
  verifyTurnstile,
  log = null,
  now = () => Date.now(),
} = {}) {
  async function login({ email, password, turnstileToken, remoteIp, userAgent }) {
    if (typeof email !== 'string' || email.trim().length === 0 || email.length > 320) {
      throw badRequest('VALIDATION_FAILED', 'A valid email address is required.');
    }
    if (typeof password !== 'string' || password.length === 0 || password.length > 512) {
      throw badRequest('VALIDATION_FAILED', 'A password is required.');
    }

    // Before the hash, on purpose: a bot that cannot solve the challenge never
    // reaches Argon2id, so the expensive part cannot be used as a lever.
    if (!(await verifyTurnstile(turnstileToken, remoteIp))) {
      throw turnstileFailed();
    }

    const user = await users.findByEmail(email.trim());
    const checked = await verifyPassword(password, user?.passwordHash ?? DUMMY_HASH);

    if (!user || !checked.ok) {
      if (user) await users.recordFailedAttempt(user.id);
      throw unauthorized('INVALID_CREDENTIALS', 'Wrong email or password.');
    }

    if (user.lockedUntil !== null && user.lockedUntil.getTime() > now()) {
      const retryAfterSeconds = Math.max(1, Math.ceil((user.lockedUntil.getTime() - now()) / 1000));
      log?.info({ msg: 'auth.login.locked', userId: user.id, retryAfterSeconds });
      throw locked('LOCKED', 'Too many failed attempts. Try again later.', { retryAfterSeconds });
    }

    if (user.emailVerifiedAt === null) {
      throw forbidden('EMAIL_NOT_VERIFIED', 'Verify your email address before signing in.', {
        resendable: true,
      });
    }

    await users.clearFailures(user.id);

    // The hash was made under an older cost setting: re-hash now that we hold the
    // plaintext, so the row improves without a migration or a forced reset.
    if (checked.needsRehash) {
      await users.setPasswordHash(user.id, await hashPassword(password));
    }

    const session = await sessions.start({ userId: user.id, userAgent });
    const accessToken = tokens.signAccessToken({ sub: user.id, role: user.role });

    log?.info({ msg: 'auth.login', userId: user.id, familyId: session.familyId });

    return { user: snapshot(user), accessToken, session };
  }

  async function refresh({ refreshToken, userAgent }) {
    const rotated = await sessions.rotate({ token: refreshToken, userAgent });

    // The role comes from the database, not from the token being replaced: a user
    // demoted since their last login must not get another admin claim.
    const user = await users.findById(rotated.userId);
    if (!user) {
      await sessions.revoke({ token: rotated.refreshToken });
      throw unauthorized('INVALID_REFRESH', 'Refresh token is missing or no longer valid.');
    }

    const accessToken = tokens.signAccessToken({ sub: user.id, role: user.role });
    return { accessToken, session: rotated, user: snapshot(user) };
  }

  async function logout({ refreshToken }) {
    await sessions.revoke({ token: refreshToken });
  }

  async function me({ userId }) {
    const user = await users.findById(userId);
    if (!user) throw unauthorized('UNAUTHENTICATED', 'Missing or invalid access token.');

    // The same shape login returns, plus the field only this route reports.
    return { ...snapshot(user), emailVerifiedAt: user.emailVerifiedAt };
  }

  return { login, refresh, logout, me };
}

/** The user object returned by login — a snapshot, not the authority (`/me` is). */
function snapshot(user) {
  return { id: user.id, email: user.email, role: user.role, createdAt: user.createdAt };
}
