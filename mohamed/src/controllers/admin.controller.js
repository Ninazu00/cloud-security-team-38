/**
 * Two handlers, three lines each: read the request, call the service, answer.
 *
 * The `403 SELF_ROLE_CHANGE` decision is *not* made here even though the actor's
 * id is only known here - it is passed down, because the service is where the rule
 * belongs and a second copy of it in this file would be a rule that can drift.
 */

export function createAdminController({ users }) {
  return {
    async list(req, res) {
      const page = await users.list({
        limit: req.query.limit,
        cursor: req.query.cursor,
        role: req.query.role,
        q: req.query.q,
      });

      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json(page);
    },

    async setRole(req, res) {
      const user = await users.setRole({
        actorId: req.auth.userId,
        userId: req.params.id,
        role: req.body?.role,
      });

      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json(user);
    },
  };
}
