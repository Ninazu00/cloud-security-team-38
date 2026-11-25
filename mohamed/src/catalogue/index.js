import express from 'express';

import { createCoursesModel } from '../models/courses.model.js';
import { createSectionsModel } from '../models/sections.model.js';
import { createImportsModel } from '../models/imports.model.js';
import { createCoursesService } from '../services/courses.service.js';
import { createSectionsService } from '../services/sections.service.js';
import { createImportsService } from '../services/imports.service.js';
import { createCoursesController } from '../controllers/courses.controller.js';
import { createSectionsController } from '../controllers/sections.controller.js';
import { createImportsController } from '../controllers/imports.controller.js';
import { createCoursesRouter } from '../routes/courses.js';
import { createSectionsRouter } from '../routes/sections.js';
import { createImportsRouter } from '../routes/imports.js';

/**
 * The catalogue, assembled: models → services → controllers → routers.
 *
 * Same shape as `auth/index.js`, for the same reason: the composition lives in
 * one place, so `app.js` never constructs a model and a test can build the same
 * graph against a throwaway database without reaching into the app.
 *
 * `middleware` is passed in rather than imported: the guards belong to auth, and
 * a catalogue that imported them directly would be a second place to remember
 * when authentication changes.
 *
 * The importer is the one service that talks to two other models instead of one:
 * it writes courses, sections and times in a single transaction, so "all or
 * nothing" is decided by the caller rather than by three services agreeing to
 * cooperate. It also reuses the *model* layer directly - the HTTP services add
 * validation and status codes it does not want, since its errors become rows in
 * a report rather than responses.
 */
export function buildCatalogue({ query, withTransaction, middleware, log = null }) {
  const coursesModel = createCoursesModel({ query, withTransaction });
  const courses = createCoursesService({ courses: coursesModel });
  const coursesController = createCoursesController({ courses });

  const sectionsModel = createSectionsModel({ query, withTransaction });
  const sections = createSectionsService({ sections: sectionsModel, courses });

  const importsModel = createImportsModel({ query });
  const imports = createImportsService({
    imports: importsModel,
    courses: coursesModel,
    sections: sectionsModel,
    withTransaction,
    log,
  });

  const router = express.Router();
  router.use(createCoursesRouter({ controller: coursesController, middleware }));
  router.use(createSectionsRouter({ controller: createSectionsController({ sections }), middleware }));
  router.use(createImportsRouter({ controller: createImportsController({ imports }), middleware }));

  return { router, courses, sections, imports };
}
