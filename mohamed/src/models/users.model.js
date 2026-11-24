import { hashPassword } from '../auth/passwords.js';

/**
 * The `users` table. SQL only — no policy, no HTTP, no token logic.
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

  return {
    findByEmail,
    findById,
    recordFailedAttempt,
    clearFailures,
    setPasswordHash,
    createVerified,
  };
}
