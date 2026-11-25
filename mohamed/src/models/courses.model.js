import { decodeCursor, parseLimit, toPage } from '../http/pagination.js';

/**
 * The `courses` table. SQL only - no policy, no HTTP, no status codes.
 *
 * Two shapes matter here:
 *
 *  - `sectionCount` is how many **active** sections point at a course. It is
 *    computed in the same query with a correlated subquery, so a list of twenty
 *    courses is still one round trip. Counting archived sections would tell an
 *    admin "this course has 4 sections" for a course with none left.
 *  - Archiving is an update, never a delete. The foreign key from `sections` is
 *    `on delete restrict`, and other services keep copies of these ids.
 */

const COLUMNS = `c.id, c.code, c.title, c.credits, c.archived_at, c.created_at, c.updated_at`;

/** The only fields an update may touch, and the column each one lives in. */
const COLUMN_OF = { code: 'code', title: 'title', credits: 'credits', archivedAt: 'archived_at' };

const ACTIVE_SECTION_COUNT = `(select count(*)::int from sections s
                               where s.course_id = c.id and s.archived_at is null)`;

/** Columns become camelCase here, so nothing above this file speaks SQL dialect. */
function toCourse(row) {
  if (!row) return null;
  return {
    id: row.id,
    code: row.code,
    title: row.title,
    credits: row.credits,
    sectionCount: row.section_count,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createCoursesModel({ query, withTransaction }) {
  if (typeof query !== 'function' || typeof withTransaction !== 'function') {
    throw new Error('createCoursesModel needs query and withTransaction from db.js.');
  }

  /**
   * One page of courses, newest first.
   *
   * The filters are assembled rather than written out because every one of them
   * is optional: building SQL from strings is how injection bugs happen, so each
   * fragment here is a constant and every value travels as a parameter.
   */
  async function list({ q, code, includeArchived, limit: rawLimit, cursor }) {
    const limit = parseLimit(rawLimit);
    const after = decodeCursor(cursor);

    const where = [];
    const params = [];

    if (!includeArchived) where.push('c.archived_at is null');

    if (code) {
      params.push(code);
      where.push(`upper(c.code) = upper($${params.length})`);
    }

    if (q) {
      params.push(`%${q}%`);
      where.push(`(c.code ilike $${params.length} or c.title ilike $${params.length})`);
    }

    if (after) {
      params.push(after.createdAt, after.id);
      // Keyset, newest first: strictly older than the cursor row.
      where.push(`(c.created_at, c.id) < ($${params.length - 1}, $${params.length})`);
    }

    params.push(limit + 1);

    const { rows } = await query(
      `select ${COLUMNS}, ${ACTIVE_SECTION_COUNT} as section_count
         from courses c
        ${where.length > 0 ? `where ${where.join(' and ')}` : ''}
        order by c.created_at desc, c.id desc
        limit $${params.length}`,
      params,
    );

    const page = toPage(rows, limit, (row) => ({ createdAt: row.created_at, id: row.id }));
    return { items: page.items.map(toCourse), nextCursor: page.nextCursor };
  }

  async function findById(id) {
    const { rows } = await query(
      `select ${COLUMNS}, ${ACTIVE_SECTION_COUNT} as section_count
         from courses c where c.id = $1`,
      [id],
    );
    return toCourse(rows[0]);
  }

  /** The normalised code, or null. Used for the 409 before the insert. */
  async function findByCode(code) {
    const { rows } = await query(
      `select ${COLUMNS}, ${ACTIVE_SECTION_COUNT} as section_count
         from courses c where upper(c.code) = upper($1)`,
      [code],
    );
    return toCourse(rows[0]);
  }

  async function insert({ code, title, credits }) {
    const { rows } = await query(
      `insert into courses (code, title, credits)
       values ($1, $2, $3)
       returning id, code, title, credits, archived_at, created_at, updated_at, 0 as section_count`,
      [code, title, credits],
    );
    return toCourse(rows[0]);
  }

  /** A partial update: only the fields present in `patch` are written. */
  async function update(id, patch) {
    const sets = [];
    const params = [id];

    for (const [field, value] of Object.entries(patch)) {
      const column = COLUMN_OF[field];
      if (!column) throw new Error(`courses.update does not know the field "${field}".`);

      params.push(value);
      sets.push(`${column} = $${params.length}`);
    }

    if (sets.length === 0) return findById(id);

    const { rows } = await query(
      `update courses c set ${sets.join(', ')} where c.id = $1
       returning id, code, title, credits, archived_at, created_at, updated_at,
                 ${ACTIVE_SECTION_COUNT} as section_count`,
      params,
    );
    return toCourse(rows[0]);
  }

  /**
   * Insert-or-update by code, for the importer.
   *
   * Takes the transaction's client, unlike the read methods above: the caller is
   * mid-transaction and every statement must land in the same unit of work.
   * An archived course is reported rather than resurrected - silently un-archiving
   * something an admin withdrew would be a data change nobody asked for.
   */
  async function upsert(client, { code, title, credits }) {
    const { rows } = await client.query(
      'select id, title, credits, archived_at from courses where upper(code) = upper($1)',
      [code],
    );

    if (rows.length === 0) {
      const inserted = await client.query(
        'insert into courses (code, title, credits) values ($1, $2, $3) returning id',
        [code, title, credits],
      );
      return { id: inserted.rows[0].id, created: true, updated: false, archived: false };
    }

    const [row] = rows;
    if (row.archived_at) return { id: row.id, created: false, updated: false, archived: true };

    const changed = row.title !== title || row.credits !== credits;
    if (changed) {
      await client.query('update courses set title = $2, credits = $3 where id = $1', [row.id, title, credits]);
    }
    return { id: row.id, created: false, updated: changed, archived: false };
  }

  /** How many sections are still live on this course - what blocks a `code` change. */
  async function countActiveSections(courseId) {
    const { rows } = await query(
      `select count(*)::int as count from sections
        where course_id = $1 and archived_at is null`,
      [courseId],
    );
    return rows[0].count;
  }

  /**
   * Archive the course and its live sections together.
   *
   * One transaction because the two facts belong together: a course nobody offers
   * with four sections still enrolling students is worse than either state alone.
   * Idempotent - archiving twice answers "0 sections", which is true.
   */
  async function archive(id, at = new Date()) {
    return withTransaction(async (client) => {
      const archived = await client.query(
        `update courses set archived_at = coalesce(archived_at, $2)
          where id = $1
          returning id, archived_at`,
        [id, at],
      );

      if (archived.rowCount === 0) return null;

      const sections = await client.query(
        `update sections set archived_at = $2
          where course_id = $1 and archived_at is null
          returning id`,
        [id, at],
      );

      return { id: archived.rows[0].id, archivedAt: archived.rows[0].archived_at, archivedSections: sections.rowCount };
    });
  }

  return { list, findById, findByCode, insert, update, upsert, countActiveSections, archive };
}
