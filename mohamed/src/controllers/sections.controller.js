/**
 * Section endpoints: translate HTTP to service calls, and nothing else.
 *
 * The only decisions here are about the shape of the request: query strings
 * arrive as strings, so `ids` passes through untouched while the service parses
 * it, and the body is already JSON by the time Express hands it over.
 */
export function createSectionsController({ sections }) {
  return {
    async list(req, res) {
      res.json(await sections.list(req.query, req.auth));
    },

    async get(req, res) {
      res.json(await sections.get(req.params.id));
    },

    async create(req, res) {
      res.status(201).json(await sections.create(req.body));
    },

    async update(req, res) {
      res.json(await sections.update(req.params.id, req.body));
    },

    async remove(req, res) {
      res.json(await sections.remove(req.params.id));
    },
  };
}
