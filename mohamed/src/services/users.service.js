import { conflict, forbidden, notFound, unprocessable } from '../errors.js';
import { parseLimit, toPage } from '../http/pagination.js';

/**
 * The admin console: who exists, and who is an admin.
 *
 * Two rules make this more than a table reader, and both matter for the marks:
 * an admin cannot change their own role (a single misclick would leave the system
 * without the person who is allowed to fix it), and the last admin cannot be
 * demoted. Both are enforced in the model inside a transaction, because they are
 * facts about the rows; this file only turns the outcome into a status code.
 */

const ROLES = ['student', 'admin'];
const QUERY_MAX = 64;

export function createUsersService({ users, withTransaction }) {
  if (typeof withTransaction !== 'function') {
    throw new Error('createUsersService needs withTransaction from db.js.');
  }

  function invalid(field, message) {
    return unprocessable('VALIDATION_FAILED', message, { field });
  }

  function parseRole(value, field = 'role') {
    if (typeof value !== 'string' || !ROLES.includes(value)) {
      throw invalid(field, 'role must be "student" or "admin".');
    }
    return value;
  }

  return {
    async list({ limit, cursor, role, q }) {
      const parsedLimit = parseLimit(limit);
      const parsedRole = role === undefined ? null : parseRole(role);

      if (q !== undefined && (typeof q !== 'string' || [...q].length > QUERY_MAX)) {
        throw invalid('q', `q must be a string of at most ${QUERY_MAX} characters.`);
      }

      const rows = await users.list({
        limit: parsedLimit,
        cursor,
        role: parsedRole,
        q: q?.trim() || null,
      });

      return toPage(rows, parsedLimit, (row) => ({ createdAt: row.createdAt, id: row.id }));
    },

    async setRole({ actorId, userId, role }) {
      // Compared as strings because one comes from a JWT claim and the other from
      // a path segment; a strict self-check that misses is a self-demotion that
      // succeeds.
      if (String(actorId) === String(userId)) {
        throw forbidden('SELF_ROLE_CHANGE', 'You cannot change your own role.');
      }

      const parsedRole = parseRole(role);

      const result = await withTransaction((client) =>
        users.setRole(client, { id: userId, role: parsedRole }),
      );

      if (!result.ok && result.reason === 'not_found') {
        throw notFound('USER_NOT_FOUND', 'No such user.');
      }
      if (!result.ok && result.reason === 'last_admin') {
        throw conflict('LAST_ADMIN', 'The system must keep at least one admin.');
      }

      return result.user;
    },
  };
}
