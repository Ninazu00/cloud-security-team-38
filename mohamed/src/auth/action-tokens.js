import { createHash, randomBytes } from 'node:crypto';

/**
 * Single-use links that arrive by email: verify an address, reset a password.
 *
 * Two properties matter and neither is visible in the API:
 *
 *  1. **Only the hash is stored.** The row holds `sha256(token)`, so a dump of
 *     `auth_tokens` cannot be turned into a working link. The plaintext exists in
 *     exactly two places: the string we hand to the mailer, and the recipient's
 *     inbox.
 *  2. **The token is minted when the mail is sent**, not when it is queued. That
 *     is why `email_outbox.payload` carries a user id and no token: a database
 *     dump of the outbox must not contain the thing that resets a password.
 *
 * A token is consumed by `markConsumed`, which is a conditional update: two
 * requests holding the same link race, one wins, the other sees zero rows.
 */

const PURPOSES = new Set(['email_verify', 'password_reset', 'mfa_challenge']);

export function hashToken(token) {
  return createHash('sha256').update(token).digest();
}

export function createActionTokenStore({ query, now = () => Date.now() } = {}) {
  if (typeof query !== 'function') {
    throw new Error('createActionTokenStore needs query from db.js.');
  }

  /** 32 random bytes, base64url. 256 bits: not guessable, safe in a URL. */
  async function issue({ userId, purpose, ttlSeconds }) {
    if (!PURPOSES.has(purpose)) throw new Error(`unknown token purpose: ${purpose}`);
    if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
      throw new Error('issue needs a positive ttlSeconds.');
    }

    const token = randomBytes(32).toString('base64url');

    await query(
      `insert into auth_tokens (user_id, purpose, token_hash, expires_at)
       values ($1, $2, $3, $4)`,
      [userId, purpose, hashToken(token), new Date(now() + ttlSeconds * 1000)],
    );

    return token;
  }

  /** The row for a presented token, or null. Expiry is judged by the caller. */
  async function find(token, purpose) {
    if (typeof token !== 'string' || token.length < 20 || token.length > 200) return null;

    const { rows } = await query(
      `select id, user_id, purpose, expires_at, consumed_at
         from auth_tokens
        where token_hash = $1 and purpose = $2`,
      [hashToken(token), purpose],
    );

    const row = rows[0];
    if (!row) return null;

    return {
      id: row.id,
      userId: row.user_id,
      purpose: row.purpose,
      expiresAt: row.expires_at,
      consumedAt: row.consumed_at,
    };
  }

  /**
   * True only for the caller that actually consumed it.
   *
   * Pass a transaction client to consume the token inside a wider transaction: a
   * password reset must not leave the token spent if the password update fails.
   */
  async function markConsumed(id, client = null) {
    const run = client ? (text, params) => client.query(text, params) : query;
    const { rowCount } = await run(
      'update auth_tokens set consumed_at = now() where id = $1 and consumed_at is null',
      [id],
    );
    return rowCount === 1;
  }

  /** How many links of this kind were issued for the user since `sinceMs`. */
  async function countSince({ userId, purpose, sinceMs }) {
    const { rows } = await query(
      `select count(*)::int as count
         from auth_tokens
        where user_id = $1 and purpose = $2 and created_at >= $3`,
      [userId, purpose, new Date(sinceMs)],
    );
    return rows[0]?.count ?? 0;
  }

  /**
   * Spend every unused token of this kind for the user. Called before issuing a
   * replacement, so "resend" cannot leave two live links in two inboxes.
   */
  async function discardOutstanding({ userId, purpose }) {
    const { rowCount } = await query(
      `update auth_tokens set consumed_at = now()
        where user_id = $1 and purpose = $2 and consumed_at is null`,
      [userId, purpose],
    );
    return rowCount;
  }

  return { issue, find, markConsumed, countSince, discardOutstanding };
}
