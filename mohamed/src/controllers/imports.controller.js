import { assertUploadedCsv } from '../http/upload.js';

/**
 * Import endpoints.
 *
 * The upload arrives as multipart, so by the time this runs `req.file` is a
 * buffer in memory and `req.body` holds the ordinary fields (none, today). The
 * file gate is called here rather than as middleware because the order is part
 * of the contract: authentication, role, presence and size, type, then parse.
 */
export function createImportsController({ imports }) {
  return {
    async create(req, res) {
      const file = assertUploadedCsv(req.file);
      const dryRun = req.query.dryRun === 'true';

      const body = await imports.importCatalogue({
        buffer: file.buffer,
        // Kept as metadata only: the name is shown in the history, never used as
        // a path, so there is nothing for a crafted name to traverse.
        filename: String(file.originalname ?? 'upload.csv').slice(0, 255),
        dryRun,
        actor: req.auth,
      });

      res.status(dryRun ? 200 : 201).json(body);
    },

    async list(req, res) {
      res.json(await imports.list(req.query));
    },

    async get(req, res) {
      res.json(await imports.get(req.params.id));
    },
  };
}
