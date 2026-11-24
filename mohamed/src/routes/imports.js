import express from 'express';

import { createCsvUpload } from '../http/upload.js';

/**
 * The import routes.
 *
 * `POST` carries the upload middleware between the guards and the controller on
 * purpose: the guards must run first (an unauthenticated caller should not be
 * able to make the process buffer two megabytes), and the middleware must run
 * before the controller (which expects `req.file`). Order is the contract's,
 * made visible in one line.
 */
export function createImportsRouter({ controller, middleware, upload = createCsvUpload() }) {
  const router = express.Router();
  const admin = [middleware.requireAuth, middleware.requireRole('admin')];

  router.post('/api/imports', [...admin, upload], controller.create);
  router.get('/api/imports', admin, controller.list);
  router.get('/api/imports/:id', admin, controller.get);

  return router;
}
