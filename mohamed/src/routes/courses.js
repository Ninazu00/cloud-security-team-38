import express from 'express';

/**
 * The URL table for courses — paths and guards only, every handler a one-liner.
 *
 * Reads need a login; writes need `admin`. `requireRole` re-reads the role from
 * the users table, so a demoted admin loses write access on their next request
 * even though their token still carries the old claim for up to two hours.
 */

export function createCoursesRouter({ controller, middleware }) {
  const router = express.Router();

  const admin = [middleware.requireAuth, middleware.requireRole('admin')];

  router.get('/api/courses', middleware.requireAuth, controller.list);
  router.get('/api/courses/:id', middleware.requireAuth, controller.get);
  router.post('/api/courses', admin, controller.create);
  router.patch('/api/courses/:id', admin, controller.update);
  router.delete('/api/courses/:id', admin, controller.remove);

  return router;
}
