import express from 'express';

/**
 * The section routes, and who may call them.
 *
 * Reads are open to any logged-in user because Timetable and Compare & Share
 * need them; writes are admin-only because the catalogue is a statement of
 * fact, not an opinion. The guards are passed in rather than imported so this
 * file stays a routing table.
 */
export function createSectionsRouter({ controller, middleware }) {
  const router = express.Router();
  const admin = [middleware.requireAuth, middleware.requireRole('admin')];
  const anyUser = [middleware.requireAuth];

  router.get('/api/sections', anyUser, controller.list);
  router.get('/api/sections/:id', anyUser, controller.get);
  router.post('/api/sections', admin, controller.create);
  router.patch('/api/sections/:id', admin, controller.update);
  router.delete('/api/sections/:id', admin, controller.remove);

  return router;
}
