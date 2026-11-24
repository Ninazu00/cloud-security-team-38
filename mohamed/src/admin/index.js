import { createAdminController } from '../controllers/admin.controller.js';
import { createAdminRouter } from '../routes/admin.js';
import { createUsersService } from '../services/users.service.js';

/**
 * The admin module, wired the same way as the catalogue: model → service →
 * controller → router, with the guards injected because they belong to auth.
 *
 * The users model is passed in by the boot path (auth already built one) so there
 * is exactly one instance talking to the table.
 */

export function buildAdmin({ withTransaction, middleware, users }) {
  if (!middleware) throw new Error('buildAdmin needs the auth middleware.');
  if (!users) throw new Error('buildAdmin needs the users model from buildAuth.');

  const service = createUsersService({ users, withTransaction });
  const controller = createAdminController({ users: service });

  return { router: createAdminRouter({ controller, middleware }), users };
}
