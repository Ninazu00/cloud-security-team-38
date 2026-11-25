import { hashPassword } from '../auth/passwords.js';

/**
 * The `users` table. SQL only - no policy, no HTTP, no token logic.
 *
 * The lockout lives here rather than in memory for one reason: four ECS tasks
 * behind a load balancer each have their own memory, so a counter in-process
 * would allow five attempts *per task*. The database is the only place a number
 * can mean the same thing everywhere.
 *
 * `failed_attempts_at` is what makes "5 failures in 15 minutes" true rather than
 * "5 failures ever": the counter is ignored once it is older than the window.
 *
 * Every method here is one statement except `recordFailedAttempt`, which reads
 * then writes and therefore needs both to happen or neither.
 */

const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000;
const LOCK_MS = 15 * 60 * 1000;

const COLUMNS = `id, email, role, password_hash, email_verified_at,
                 failed_attempts, locked_until, created_at, updated_at`;

/**
 * Rows arrive with column names; everything above this file speaks camelCase.
 * Converting in one place keeps `password_hash` and `locked_until` from leaking
 * into services, controllers and responses, where a stray spread would ship them.
 */
function toUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    passwordHash: row.password_hash,
    emailVerifiedAt: row.email_verified_at,
    failedAttempts: row.failed_attempts,
    lockedUntil: row.locked_until,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createUsersModel({ query, withTransaction, now = () => Date.now() }) {
  if (typeof query !== 'function' || typeof withTransaction !== 'function') {
    throw new Error('createUsersModel needs query and withTransaction from db.js.');
  }

  async function findByEmail(email) {
    const { rows } = await query(`select ${COLUMNS} from users where lower(email) = lower($1)`, [
      email,
    ]);
    return toUser(rows[0]);
  }

  async function findById(id) {
    const { rows } = await query(`select ${COLUMNS} from users where id = $1`, [id]);
    return toUser(rows[0]);
  }

  /**
   * Insert a self-registered account. Returns null when the address already
   * exists, which is the interesting case: the caller must answer identically
   * either way, so "does this email have an account" is not learnable by
   * registering it.
   *
   * `email_verified_at` stays null: the account exists but cannot sign in until
   * the address is confirmed.
   */
  async function create({ email, passwordHash }) {
    const { rows } = await query(
      `insert into users (email, password_hash)
       values ($1, $2)
       on conflict (lower(email)) do nothing
       returning ${COLUMNS}`,
      [email, passwordHash],
    );

    return toUser(rows[0]);
  }

  /**
   * Confirm an address. `coalesce` keeps the first confirmation: verifying twice
   * must not move the timestamp that `/api/auth/me` reports.
   */
  async function markEmailVerified(userId) {
    const { rows } = await query(
      `update users set email_verified_at = coalesce(email_verified_at, now())
        where id = $1
        returning ${COLUMNS}`,
      [userId],
    );

    return toUser(rows[0]);
  }

  /**
   * Count one failed password. Returns the account's state after the attempt, so
   * the caller can distinguish "wrong password" from "wrong password, and you are
   * now locked out".
   */
  async function recordFailedAttempt(userId) {
    const at = now();

    return withTransaction(async (client) => {
      // `for update` holds the row until commit. Without it, ten simultaneous
      // guesses would each read the same counter and write 1, and an attacker
      // could parallelise their way past the limit.
      const { rows } = await client.query(
        `select failed_attempts, failed_attempts_at, locked_until
           from users where id = $1 for update`,
        [userId],
      );

      const user = rows[0];
      if (!user) return null;

      // Already locked: leave the numbers alone, just report the remaining time.
      if (user.locked_until !== null && user.locked_until.getTime() > at) {
        return { failedAttempts: user.failed_attempts, lockedUntil: user.locked_until };
      }

      const windowExpired =
        user.failed_attempts_at === null || at - user.failed_attempts_at.getTime() > WINDOW_MS;

      const attempts = windowExpired ? 1 : user.failed_attempts + 1;
      const lockedUntil = attempts >= MAX_ATTEMPTS ? new Date(at + LOCK_MS) : null;

      await client.query(
        `update users
            set failed_attempts = $2, failed_attempts_at = $3, locked_until = $4
          where id = $1`,
        [userId, attempts, new Date(at), lockedUntil],
      );

      return { failedAttempts: attempts, lockedUntil };
    });
  }

  async function clearFailures(userId) {
    await query(
      `update users
          set failed_attempts = 0, failed_attempts_at = null, locked_until = null
        where id = $1`,
      [userId],
    );
  }

  /** Upgrade a row whose Argon2id cost is below the current policy. */
  async function setPasswordHash(userId, passwordHash) {
    await query('update users set password_hash = $2 where id = $1', [userId, passwordHash]);
  }

  /**
   * One operation, not two: the new password and the end of every session must
   * land together. Splitting them would allow the state where the password is
   * new and the old sessions are still alive, which is the worst of both.
   *
   * A verified mailbox is implied: whoever spent the reset link controls the
   * address, which is the same proof that a verification link gives.
   */
  async function resetPassword(client, { userId, passwordHash, at }) {
    const { rows } = await client.query(
      `update users
          set password_hash = $2,
              email_verified_at = coalesce(email_verified_at, $3),
              updated_at = $3
        where id = $1
        returning id, email`,
      [userId, passwordHash, at],
    );

    if (rows.length === 0) return null;

    await client.query(
      'update sessions set revoked_at = $2 where user_id = $1 and revoked_at is null',
      [userId, at],
    );

    return rows[0];
  }

  /**
   * Used by the seed script: create an account that can log in immediately.
   * Idempotent on the email, so re-running the seed does not create duplicates.
   */
  async function createVerified({ email, password, role = 'student' }) {
    const passwordHash = await hashPassword(password);

    const { rows } = await query(
      `insert into users (email, password_hash, role, email_verified_at)
       values ($1, $2, $3, now())
       on conflict (lower(email)) do nothing
       returning ${COLUMNS}`,
      [email, passwordHash, role],
    );

    return toUser(rows[0]);
  }

  /**
   * One page of accounts, newest first, for the admin screen.
   *
   * Keyset again rather than offset: the users table grows while an admin pages
   * through it, and an offset would repeat or skip rows as that happens.
   *
   * Only the six columns the contract publishes are selected. A hash that is never
   * read cannot be leaked by a later `...user` somewhere above this layer.
   */
  async function list({ limit, cursor = null, role = null, q = null }) {
    const where = [];
    const values = [];

    if (role) {
      values.push(role);
      where.push(`role = $${values.length}`);
    }

    if (q) {
      values.push(`%${q}%`);
      where.push(`email ilike $${values.length}`);
    }

    if (cursor) {
      values.push(cursor.createdAt, cursor.id);
      where.push(`(created_at, id) < ($${values.length - 1}, $${values.length})`);
    }

    values.push(limit + 1);

    const { rows } = await query(
      `select id, email, role, created_at, email_verified_at, locked_until
         from users
        ${where.length ? `where ${where.join(' and ')}` : ''}
        order by created_at desc, id desc
        limit $${values.length}`,
      values,
    );

    return rows.map((row) => ({
      id: row.id,
      email: row.email,
      role: row.role,
      createdAt: row.created_at,
      emailVerifiedAt: row.email_verified_at,
      lockedUntil: row.locked_until,
    }));
  }

  /**
   * Change a role, or refuse. Both refusals are decided here rather than in the
   * service because they are facts about the table: the account exists, and the
   * system keeps at least one admin.
   *
   * Returns a result object instead of throwing, so the layer that owns HTTP keeps
   * owning the status codes.
   */
  async function setRole(client, { id, role, at = new Date() }) {
    const { rows } = await client.query(
      'select id, email, role from users where id = $1 for update',
      [id],
    );

    const target = rows[0];
    if (!target) return { ok: false, reason: 'not_found' };

    if (target.role === role) {
      return { ok: true, user: { id: target.id, email: target.email, role, updatedAt: at } };
    }

    if (target.role === 'admin' && role !== 'admin') {
      // Count the *other* admins while holding the target's row. Without the lock
      // two demotions could each see one remaining admin and both proceed.
      const admins = await client.query(
        `select id from users where role = 'admin' and id <> $1 for update`,
        [id],
      );
      if (admins.rowCount === 0) return { ok: false, reason: 'last_admin' };
    }

    const updated = await client.query(
      `update users set role = $2, updated_at = $3 where id = $1
        returning id, email, role, updated_at`,
      [id, role, at],
    );

    // A demoted admin holds an `admin` claim for up to two hours; revoking the
    // sessions makes the change immediate rather than eventual.
    await client.query(
      'update sessions set revoked_at = $2 where user_id = $1 and revoked_at is null',
      [id, at],
    );

    const row = updated.rows[0];
    return {
      ok: true,
      user: { id: row.id, email: row.email, role: row.role, updatedAt: row.updated_at },
    };
  }

  return {
    findByEmail,
    findById,
    create,
    markEmailVerified,
    recordFailedAttempt,
    clearFailures,
    setPasswordHash,
    resetPassword,
    createVerified,
    list,
    setRole,
  };
}
