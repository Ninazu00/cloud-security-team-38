// Readiness and liveness are two different questions wired to two different
// mechanisms:
//
//   GET /healthz  - "is this process alive?"   -> container restart decision
//   GET /readyz   - "can this task serve?"     -> load balancer routing decision
//
// Collapsing them is the classic mistake: a database outage would restart every
// task in a loop instead of draining them, or a dead process would stay in
// rotation because the database was fine.

import { Router } from 'express';
import { liveness, readiness } from '../controllers/health.controller.js';

export const healthRouter = Router();

healthRouter.get('/healthz', liveness);
healthRouter.get('/readyz', readiness);
