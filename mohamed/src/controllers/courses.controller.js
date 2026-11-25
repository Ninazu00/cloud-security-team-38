/**
 * HTTP in, JSON out. No SQL, no rules - the controller reads the request,
 * calls one service method and picks a status code.
 *
 * `req.auth` is filled by `requireAuth`; the role in it has already been
 * re-read from the database by `requireRole`, so it is safe to authorise on.
 */
export function createCoursesController({ courses }) {
  async function list(req, res) {
    const page = await courses.list({
      q: req.query.q,
      code: req.query.code,
      // Only the exact string "true" means yes. A client that sends
      // `includeArchived=1` gets the safe default rather than an error, because
      // the query string is where sloppy clients live.
      includeArchived: req.query.includeArchived === 'true',
      limit: req.query.limit,
      cursor: req.query.cursor,
      role: req.auth.role,
    });

    res.json(page);
  }

  async function get(req, res) {
    res.json(await courses.get(req.params.id));
  }

  async function create(req, res) {
    const course = await courses.create(req.body ?? {});
    res.status(201).json(course);
  }

  async function update(req, res) {
    res.json(await courses.update(req.params.id, req.body ?? {}));
  }

  async function remove(req, res) {
    res.json(await courses.remove(req.params.id));
  }

  return { list, get, create, update, remove };
}
