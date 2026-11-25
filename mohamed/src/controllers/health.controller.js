// Controllers translate HTTP <-> services. They may read `req`, choose a status
// code and shape a response body. They must not contain SQL, and they must not
// contain a business rule: if a rule only lives here, it cannot be reused by the
// importer, covered by a service test, or called from a background worker.

import { checkReadiness } from '../services/health.service.js';

/** Liveness: the process answers at all. It never touches state. */
export function liveness(_req, res) {
  res.status(200).json({ status: 'ok' });
}

/** Readiness: can this task take traffic right now? */
export async function readiness(_req, res) {
  const result = await checkReadiness();

  if (result.ok) {
    res.status(200).json({ status: 'ready', db: 'ok', ms: result.ms });
    return;
  }

  // 503 removes the target from rotation without restarting the container.
  // No error envelope: this body is read by the platform, not by clients.
  res.status(503).json({ status: 'not_ready', db: 'unreachable', ms: result.ms });
}
