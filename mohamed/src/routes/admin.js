import express from 'express';

/**
 * The URL table for the admin console. `requireRole` re-reads the role from the
 * database, so a demoted admin loses this door immediately rather than when their
 * two-hour token expires.
 */

export function createAdminRouter({ controller, middleware }) {
  const router = express.Router();
  const admin = [middleware.requireAuth, middleware.requireRole('admin')];

  router.get('/api/admin/users', admin, controller.list);
  router.patch('/api/admin/users/:id/role', admin, controller.setRole);

  return router;
}
