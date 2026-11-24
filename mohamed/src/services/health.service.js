// Services hold rules, not HTTP. Nothing in this layer knows about `req`, `res`,
// status codes or JSON — which is what makes it testable without a network and
// reusable by the importer, the PATCH handler and the demo script alike.

import { ping } from '../db.js';
import { config } from '../config.js';

/**
 * The readiness question: can this task serve traffic right now?
 * Bounded by the health-check timeout on purpose — a probe that hangs is a probe
 * that fails, and the load balancer has already given up by then.
 */
export async function checkReadiness() {
  return ping(config.readyTimeoutMs);
}
