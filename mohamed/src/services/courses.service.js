import { conflict, forbidden, notFound, unprocessable } from '../errors.js';

/**
 * Catalogue rules for courses.
 *
 * The rules live here and not in the route because two callers need them: the
 * HTTP endpoints below, and the CSV importer, which creates courses from a file
 * and must apply exactly the same validation — one code path, one set of
 * messages, so "422 on row 3" means the same thing however the course arrived.
 *
 * Everything takes plain values and returns plain objects: no `req`, no `res`,
 * no status codes.
 */

const CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]*$/;
const CODE_MIN = 2;
const CODE_MAX = 20;
const TITLE_MAX = 200;
const CREDITS_MIN = 0;
const CREDITS_MAX = 30;
const QUERY_MAX = 64;

/** Field-level validation that answers 422 with the offending field named. */
function invalid(field, message) {
  return unprocessable('VALIDATION_FAILED', message, { field });
}

/**
 * Normalise and check a course code.
 *
 * Upper-cased and stripped of every internal space, because "CS 210", "CS210"
 * and "cs210" are the same course to a human, a timetable and an .ics file. If
 * they were three rows, the unique index would happily store all three and the
 * duplicate would only surface when two timetables disagreed about one class.
 */
export function parseCode(raw) {
  if (typeof raw !== 'string') throw invalid('code', 'Code is required.');

  const code = raw.toUpperCase().replace(/\s+/g, '');
  if (code.length < CODE_MIN || code.length > CODE_MAX) {
    throw invalid('code', `Code must be ${CODE_MIN}–${CODE_MAX} characters.`);
  }
  if (!CODE_PATTERN.test(code)) {
    throw invalid('code', 'Code may contain letters, digits, dashes and underscores.');
  }
  return code;
}

export function parseTitle(raw) {
  if (typeof raw !== 'string') throw invalid('title', 'Title is required.');

  const title = raw.trim();
  if (title.length === 0) throw invalid('title', 'Title is required.');
  if (title.length > TITLE_MAX) throw invalid('title', `Title must be at most ${TITLE_MAX} characters.`);
  return title;
}

export function parseCredits(raw) {
  if (!Number.isInteger(raw)) throw invalid('credits', 'Credits must be a whole number.');
  if (raw < CREDITS_MIN || raw > CREDITS_MAX) {
    throw invalid('credits', `Credits must be between ${CREDITS_MIN} and ${CREDITS_MAX}.`);
  }
  return raw;
}

const courseNotFound = () => notFound('COURSE_NOT_FOUND', 'No such course.');

// A path parameter is user input too. Postgres rejects a non-uuid where a uuid
// is expected with a 22P02 error, which would surface as a 500 for a request
// that is merely wrong — "no such course" is the accurate answer.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (value) => typeof value === 'string' && UUID.test(value);

export function createCoursesService({ courses }) {
  /**
   * Reads are open to any logged-in user; `includeArchived` is the one exception,
   * because archived courses are withdrawn from the catalogue and only the people
   * who maintain it need to see them. A student asking for them gets 403 rather
   * than a silently filtered list: "your filter was ignored" is a worse answer
   * than "you may not".
   */
  async function list({ q, code, includeArchived, limit, cursor, role }) {
    if (includeArchived && role !== 'admin') {
      throw forbidden('FORBIDDEN', 'Only an admin may include archived courses.');
    }
    if (q !== undefined && (typeof q !== 'string' || q.length > QUERY_MAX)) {
      throw invalid('q', `Search text must be at most ${QUERY_MAX} characters.`);
    }

    return courses.list({
      q: q?.trim() || undefined,
      code: code?.trim() || undefined,
      includeArchived: Boolean(includeArchived),
      limit,
      cursor,
    });
  }

  /** Archived courses are still readable: their ids are quoted elsewhere. */
  async function get(id) {
    if (!isUuid(id)) throw courseNotFound();

    const course = await courses.findById(id);
    if (!course) throw courseNotFound();
    return course;
  }

  async function create({ code, title, credits }) {
    const normalisedCode = parseCode(code);
    const normalisedTitle = parseTitle(title);
    const normalisedCredits = parseCredits(credits);

    // Checked before the insert so the answer is `409 DUPLICATE_CODE` with the
    // code in `details`, not a raw unique-violation from Postgres. The unique
    // index is still the real guard: two admins racing get one 201 and one 409.
    const existing = await courses.findByCode(normalisedCode);
    if (existing) {
      throw conflict('DUPLICATE_CODE', 'A course with that code already exists.', {
        code: normalisedCode,
      });
    }

    return courses.insert({
      code: normalisedCode,
      title: normalisedTitle,
      credits: normalisedCredits,
    });
  }

  /**
   * Partial update. `code` is the interesting case:
   *
   *  - sending the same code back is a no-op, because clients send whole objects
   *    and punishing that would be a trap;
   *  - changing it while live sections exist is refused, since every one of those
   *    sections is currently displayed under the old code;
   *  - archived sections do not block it — they are history.
   */
  async function update(id, { code, title, credits, archived }) {
    const current = isUuid(id) ? await courses.findById(id) : null;
    if (!current) throw courseNotFound();

    const patch = {};

    if (title !== undefined) patch.title = parseTitle(title);
    if (credits !== undefined) patch.credits = parseCredits(credits);

    if (code !== undefined) {
      const nextCode = parseCode(code);
      if (nextCode !== current.code.toUpperCase()) {
        const activeSections = await courses.countActiveSections(id);
        if (activeSections > 0) {
          throw conflict('CODE_IN_USE', 'This course still has active sections.', {
            sectionCount: activeSections,
          });
        }

        const existing = await courses.findByCode(nextCode);
        if (existing && existing.id !== id) {
          throw conflict('DUPLICATE_CODE', 'A course with that code already exists.', {
            code: nextCode,
          });
        }
        patch.code = nextCode;
      }
    }

    if (archived !== undefined) {
      if (typeof archived !== 'boolean') throw invalid('archived', 'Archived must be true or false.');

      // Archiving through PATCH is the same operation as DELETE, so it archives
      // the live sections too. Restoring brings back the course only: sections
      // were withdrawn deliberately and a restore must not re-enrol students in
      // a class nobody scheduled.
      if (archived && current.archivedAt === null) {
        await courses.archive(id);
        return courses.findById(id);
      }
      if (!archived && current.archivedAt !== null) {
        patch.archivedAt = null;
      }
    }

    return courses.update(id, patch);
  }

  /** DELETE archives. The response says how many sections went with it. */
  async function remove(id) {
    if (!isUuid(id)) throw courseNotFound();

    const result = await courses.archive(id);
    if (!result) throw courseNotFound();
    return result;
  }

  return { list, get, create, update, remove };
}
