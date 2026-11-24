import {
  badRequest,
  forbidden,
  locked,
  tooManyRequests,
  unauthorized,
  unprocessable,
} from '../errors.js';
import { assertPasswordPolicy, hashPassword, verifyPassword } from '../auth/passwords.js';
import { turnstileFailed } from '../auth/turnstile.js';

/**
 * Login, refresh, logout, and "who am I".
 *
 * The rule that shapes this file: **nothing reveals whether an account exists**
 * until the caller has proved they control it. Two mechanisms implement it.
 *
 *  1. A constant dummy hash. When the email is unknown we still verify the supplied
 *     password against `DUMMY_HASH`, so "no such user" pays the same ~50 ms of
 *     Argon2id as "wrong password". This narrows the timing gap; it does not close
 *     it. A known account takes one extra write (`recordFailedAttempt`), and the
 *     row lookup itself differs, so a patient attacker with many samples still has
 *     something to measure — which is why the account also gets locked after five
 *     failures. Timing equalisation is a mitigation, not a proof.
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
  outbox,
  actionTokens,
  verifyTurnstile,
  log = null,
  now = () => Date.now(),
  resendLimitPerHour = 3,
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

  /**
   * Registration answers the same `202` whether the address was free or already
   * taken, and never says which. Two details keep that promise honest:
   *
   *  - the password is hashed on both paths, so a duplicate does not answer
   *    faster than a new account;
   *  - mail is queued only when a row was actually inserted, so registration
   *    cannot be used to send unsolicited messages to someone else's address.
   *
   * No token is returned: the account cannot sign in until the address is
   * confirmed, so there is nothing useful to hand out yet.
   */
  async function register({ email, password, turnstileToken, remoteIp }) {
    const address = normaliseEmail(email);
    assertPasswordPolicy(password);

    if (!(await verifyTurnstile(turnstileToken, remoteIp))) {
      throw turnstileFailed();
    }

    const passwordHash = await hashPassword(password);
    const user = await users.create({ email: address, passwordHash });

    if (user) {
      await outbox.enqueue({
        toEmail: address,
        templateKey: 'verify_email',
        payload: { userId: user.id },
      });
      log?.info({ msg: 'auth.register', userId: user.id });
    } else {
      log?.info({ msg: 'auth.register.duplicate' });
    }

    return { status: 'accepted' };
  }

  /**
   * Consume a verification link. Idempotent on the winning path: a second visit
   * to a link that already worked answers `200` rather than an error, because
   * "you are verified" is still true and the user did nothing wrong.
   */
  async function verifyEmail({ token }) {
    const row = await actionTokens.find(token, 'email_verify');
    if (!row) throw invalidLink();

    if (row.consumedAt !== null) {
      const user = await users.findById(row.userId);
      if (user?.emailVerifiedAt) {
        return { status: 'verified', emailVerifiedAt: user.emailVerifiedAt };
      }
      throw invalidLink();
    }

    if (row.expiresAt.getTime() <= now()) {
      throw badRequest('INVALID_TOKEN', 'This link has expired. Request a new one.');
    }

    if (!(await actionTokens.markConsumed(row.id))) {
      // Someone else consumed it between the read and the update. Answer from
      // their result rather than reporting a failure the user cannot act on.
      const user = await users.findById(row.userId);
      if (user?.emailVerifiedAt) {
        return { status: 'verified', emailVerifiedAt: user.emailVerifiedAt };
      }
      throw invalidLink();
    }

    const user = await users.markEmailVerified(row.userId);
    if (!user) throw invalidLink();

    log?.info({ msg: 'auth.email.verified', userId: user.id });
    return { status: 'verified', emailVerifiedAt: user.emailVerifiedAt };
  }

  /**
   * Queue another verification mail. Always `202`, for the same reason
   * registration is: an unauthenticated caller must not learn whether an address
   * has an unverified account.
   *
   * The limit is per account and counted from `auth_tokens`, not from the outbox:
   * the token is minted when the mail is sent, so tokens are the record of mails
   * that actually exist.
   */
  async function resendVerification({ email, turnstileToken, remoteIp }) {
    if (!(await verifyTurnstile(turnstileToken, remoteIp))) {
      throw turnstileFailed();
    }

    const address = normaliseEmail(email);
    const user = await users.findByEmail(address);

    if (user && user.emailVerifiedAt === null) {
      const issued = await actionTokens.countSince({
        userId: user.id,
        purpose: 'email_verify',
        sinceMs: now() - 60 * 60 * 1000,
      });

      if (issued >= resendLimitPerHour) {
        throw tooManyRequests(
          'RATE_LIMITED',
          'Too many verification emails were requested. Try again later.',
          { scope: 'verification_resend', limit: resendLimitPerHour },
        );
      }

      // A new link replaces the old one, so "resend" cannot leave two live
      // links in two mailboxes.
      await actionTokens.discardOutstanding({ userId: user.id, purpose: 'email_verify' });
      await outbox.enqueue({
        toEmail: address,
        templateKey: 'verify_email',
        payload: { userId: user.id },
      });
      log?.info({ msg: 'auth.verify.resent', userId: user.id });
    }

    return { status: 'accepted' };
  }

  return { login, refresh, logout, me, register, verifyEmail, resendVerification };
}

function invalidLink() {
  return badRequest('INVALID_TOKEN', 'This link is not valid. Request a new one.');
}

/**
 * One place that decides what an acceptable address is. Lower-cased because the
 * unique index is on `lower(email)`: `Ada@x.com` and `ada@x.com` are one account,
 * so they must also be one string here.
 */
function normaliseEmail(value) {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';

  if (email.length === 0 || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    throw unprocessable('VALIDATION_FAILED', 'A valid email address is required.', {
      field: 'email',
    });
  }

  return email;
}

/** The user object returned by login — a snapshot, not the authority (`/me` is). */
function snapshot(user) {
  return { id: user.id, email: user.email, role: user.role, createdAt: user.createdAt };
}
