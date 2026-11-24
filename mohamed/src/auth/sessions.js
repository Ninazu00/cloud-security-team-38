import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { gone, unauthorized } from '../errors.js';

/**
 * Refresh sessions — the stateful half of authentication.
 *
 * The access token is a signed claim nobody can withdraw; this module is the
 * withdrawal mechanism. A refresh token is 32 random bytes, never stored, only
 * its SHA-256. Presenting one rotates it: the old row keeps a `replaced_at`
 * stamp and a link to the new row, so the history of a login survives rotation.
 *
 * A *family* is one login. Every rotation creates a new row in the same family,
 * and the family is the unit that gets revoked. That is what makes theft
 * detectable: if a token that was already rotated is presented again, either the
 * thief or the real client is holding a stale copy, we cannot tell which, so the
 * whole family dies and both are sent back to the login page.
 *
 * The 30-second grace window exists for one mundane reason: two browser tabs
 * share one cookie. Both refresh, one wins, the loser presents a token that was
 * just consumed. Without grace that is "reuse detected", and the user is logged
 * out of everything by their own browser. Within the window the old token may
 * rotate once more (`grace_used` prevents a loop); outside it, reuse revokes.
 *
 * `family_expires_at` is an absolute cap set at login and never extended, so a
 * session cannot live forever just by being used. Seven days per token, thirty
 * days per login.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_TOKEN_LENGTH = 512;

export function createSessionService({
  withTransaction,
  now = () => Date.now(),
  newToken = () => randomBytes(32).toString('base64url'),
  ttlDays = 7,
  familyMaxDays = 30,
  graceSeconds = 30,
  maxFamilies = 10,
} = {}) {
  if (typeof withTransaction !== 'function') {
    throw new Error('createSessionService needs a withTransaction function.');
  }

  const ttlMs = ttlDays * DAY_MS;

  // One error for absent, unknown, expired and revoked tokens: a caller must not
  // learn whether a guessed token ever existed. Same reason as UNAUTHENTICATED.
  const invalid = () =>
    unauthorized('INVALID_REFRESH', 'Refresh token is missing or no longer valid.');

  const reused = () =>
    gone(
      'REFRESH_REUSED',
      'This refresh token was already used. All sessions for that login have been revoked.',
    );

  /** Start a new family: one row, and the plaintext token leaves only here. */
  async function start({ userId, userAgent = null }) {
    const token = newToken();
    const familyId = randomUUID();
    const issuedAt = now();
    const expiresAt = new Date(issuedAt + ttlMs);
    const familyExpiresAt = new Date(issuedAt + familyMaxDays * DAY_MS);

    return withTransaction(async (client) => {
      // Opportunistic cleanup: expired rows are unusable, so there is nothing to
      // preserve, and this avoids needing a scheduler for housekeeping.
      await client.query('delete from sessions where user_id = $1 and expires_at < now()', [userId]);

      // Cap the number of live logins. Oldest families are revoked, not deleted,
      // so the audit trail ("this login was signed out by a newer one") survives.
      // `offset maxFamilies - 1` keeps the current newest ones and revokes the rest.
      await client.query(
        `with ranked as (
           select family_id, max(created_at) as newest
             from sessions
            where user_id = $1 and revoked_at is null and expires_at > now()
            group by family_id
            order by newest desc
           offset $2
         )
         update sessions s
            set revoked_at = now()
           from ranked r
          where s.family_id = r.family_id
            and s.revoked_at is null`,
        [userId, Math.max(maxFamilies - 1, 0)],
      );

      const { rows } = await insertSession(client, {
        userId,
        familyId,
        token,
        expiresAt,
        familyExpiresAt,
        userAgent,
      });

      return { refreshToken: token, sessionId: rows[0].id, familyId, expiresAt, familyExpiresAt };
    });
  }

  /**
   * Exchange a refresh token for a fresh one. Returns the new token; the caller
   * sets the cookie and mints an access token.
   */
  async function rotate({ token, userAgent = null }) {
    if (typeof token !== 'string' || token.length < 20 || token.length > MAX_TOKEN_LENGTH) {
      throw invalid();
    }

    // Reuse detection has a side effect — the family must die — and that side
    // effect has to survive the exception that reports it. Throwing from inside the
    // transaction would roll the revocation back and leave the stolen token alive,
    // so the family is recorded here and revoked afterwards, in its own transaction.
    let familyToRevoke = null;

    try {
      return await withTransaction(async (client) => {
        // FOR UPDATE serialises two tabs presenting the same token: the second waits,
        // then sees `replaced_at` set and goes down the grace-or-reuse path.
        const { rows } = await client.query(
          `select id, user_id, family_id, expires_at, family_expires_at,
                  revoked_at, replaced_at, grace_used
             from sessions
            where token_hash = $1
            for update`,
          [hashToken(token)],
        );

        const session = rows[0];
        if (!session) throw invalid();
        if (session.revoked_at !== null) throw invalid();
        if (session.expires_at.getTime() <= now()) throw invalid();
        if (session.family_expires_at.getTime() <= now()) throw invalid();

        const rotatedAt = session.replaced_at?.getTime() ?? null;
        const withinGrace = rotatedAt !== null && now() - rotatedAt <= graceSeconds * 1000;

        if (rotatedAt !== null && (!withinGrace || session.grace_used)) {
          // Evidence of theft — or of a client replaying an old cookie. Either way
          // the family is finished, including the token the real client holds.
          familyToRevoke = session.family_id;
          throw reused();
        }

        // A successor never outlives the login it belongs to, even when the
        // per-token TTL would reach further than the family cap.
        const expiresAt = new Date(Math.min(now() + ttlMs, session.family_expires_at.getTime()));
        const successorToken = newToken();

        const successor = await insertSession(client, {
          userId: session.user_id,
          familyId: session.family_id,
          token: successorToken,
          expiresAt,
          familyExpiresAt: session.family_expires_at,
          userAgent,
        });

        if (rotatedAt === null) {
          // The first rotation is the chain link: record who replaced this row.
          await client.query(
            `update sessions
                set replaced_by_id = $2, replaced_at = now(), last_used_at = now()
              where id = $1`,
            [session.id, successor.rows[0].id],
          );
        } else {
          // A grace rotation must not overwrite the chain link, or the family would
          // read as if the token had never been used.
          await client.query(
            'update sessions set grace_used = true, last_used_at = now() where id = $1',
            [session.id],
          );
        }

        return {
          refreshToken: successorToken,
          sessionId: successor.rows[0].id,
          familyId: session.family_id,
          userId: session.user_id,
          expiresAt,
        };
      });
    } catch (error) {
      if (familyToRevoke !== null) {
        // Best effort: if this fails the client still gets 410, and the log carries
        // the cause. Never let a revocation failure turn into a usable token.
        try {
          await revokeFamily(familyToRevoke);
        } catch (revokeError) {
          error.cause = revokeError;
        }
      }
      throw error;
    }
  }

  /** Log out this device: only the presented session row dies. */
  async function revoke({ token }) {
    if (typeof token !== 'string' || token.length < 20 || token.length > MAX_TOKEN_LENGTH) {
      return false;
    }

    return withTransaction(async (client) => {
      const { rowCount } = await client.query(
        'update sessions set revoked_at = now() where token_hash = $1 and revoked_at is null',
        [hashToken(token)],
      );
      return rowCount > 0;
    });
  }

  /** Every token in one login, wherever it is in the rotation chain. */
  async function revokeFamily(familyId) {
    return withTransaction(async (client) => {
      await client.query(
        'update sessions set revoked_at = now() where family_id = $1 and revoked_at is null',
        [familyId],
      );
    });
  }

  /** Used by password reset and by an admin changing someone's role. */
  async function revokeAllForUser(userId) {
    return withTransaction(async (client) => {
      const { rowCount } = await client.query(
        'update sessions set revoked_at = now() where user_id = $1 and revoked_at is null',
        [userId],
      );
      return rowCount;
    });
  }

  return { start, rotate, revoke, revokeFamily, revokeAllForUser };
}

/**
 * The one insert both `start` and `rotate` use, so the column list exists once.
 * `token` is the plaintext; only its hash reaches the row.
 */
function insertSession(client, { userId, familyId, token, expiresAt, familyExpiresAt, userAgent }) {
  return client.query(
    `insert into sessions
       (user_id, family_id, token_hash, expires_at, family_expires_at, user_agent)
     values ($1, $2, $3, $4, $5, $6)
     returning id`,
    [
      userId,
      familyId,
      hashToken(token),
      expiresAt,
      familyExpiresAt,
      truncate(userAgent),
    ],
  );
}

function hashToken(token) {
  return createHash('sha256').update(token).digest();
}

/** Bounded so a long header cannot bloat every session row. */
function truncate(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  return value.slice(0, 200);
}
