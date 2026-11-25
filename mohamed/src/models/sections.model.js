import { toPage } from '../http/pagination.js';

/**
 * Sections and their weekly time blocks: SQL only.
 *
 * The room invariant lives here rather than in the service because it is one
 * query plus one lock, and both belong next to the tables they read. The service
 * decides *when* to call it; this file decides *how* to ask.
 *
 * The overlap predicate is the contract's, verbatim: same room, same day, and
 * `existing.start < new.end && existing.end > new.start` on a half-open interval.
 * Back-to-back blocks (10:00–11:00 then 11:00–12:00) must not clash, and this is
 * the only form that gets that right.
 */

const SECTION_COLUMNS = `
  s.id, s.section_code, s.type, s.room, s.capacity, s.archived_at, s.created_at, s.updated_at,
  c.id as course_id, c.code as course_code, c.title as course_title`;

const FROM_SECTIONS = `
  from sections s
  join courses c on c.id = s.course_id`;

/** The embedders live: a caller renders "CS101 - Introduction to Programming - L1". */
function toCourse(row) {
  return { id: row.course_id, code: row.course_code, title: row.course_title };
}

/** `time` columns come back as `10:00:00`; the contract says `10:00`. */
function toHhMm(value) {
  return String(value).slice(0, 5);
}

function toTime(row) {
  return {
    dayOfWeek: row.day_of_week,
    startTime: toHhMm(row.start_time),
    endTime: toHhMm(row.end_time),
  };
}

export function toSection(row, times = []) {
  return {
    id: row.id,
    sectionCode: row.section_code,
    type: row.type,
    room: row.room,
    capacity: row.capacity,
    course: toCourse(row),
    times,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Time blocks for a set of sections, keyed by section id. */
async function timesFor(query, ids) {
  const byId = new Map();
  if (ids.length === 0) return byId;

  const { rows } = await query(
    `select section_id, day_of_week, start_time, end_time
       from section_times
      where section_id = any($1::uuid[])
      order by day_of_week, start_time`,
    [ids],
  );

  for (const row of rows) {
    const list = byId.get(row.section_id) ?? [];
    list.push(toTime(row));
    byId.set(row.section_id, list);
  }
  return byId;
}

/** Attach `times` to rows in one extra query instead of one query per section. */
async function withTimes(query, rows) {
  const byId = await timesFor(
    query,
    rows.map((row) => row.id),
  );
  return rows.map((row) => toSection(row, byId.get(row.id) ?? []));
}

export function createSectionsModel({ query, withTransaction }) {
  if (!query || !withTransaction) {
    throw new Error('createSectionsModel needs query and withTransaction from db.js.');
  }

  async function findById(id) {
    const { rows } = await query(`select ${SECTION_COLUMNS} ${FROM_SECTIONS} where s.id = $1`, [id]);
    if (rows.length === 0) return null;

    const [section] = await withTimes(query, rows);
    return section;
  }

  /**
   * Mode A (availability search) and the batch read share this, because they
   * return the same object; only the `where` differs.
   */
  async function search({ courseId, courseCode, dayOfWeek, from, to, room, type, includeArchived, limit, cursor }) {
    const conditions = [];
    const params = [];

    if (!includeArchived) conditions.push('s.archived_at is null');
    if (courseId) {
      params.push(courseId);
      conditions.push(`s.course_id = $${params.length}`);
    }
    if (courseCode) {
      params.push(courseCode);
      conditions.push(`upper(c.code) = upper($${params.length})`);
    }
    if (room) {
      params.push(room);
      conditions.push(`upper(s.room) = upper($${params.length})`);
    }
    if (type) {
      params.push(type);
      conditions.push(`s.type = $${params.length}`);
    }

    // A window is a filter on the blocks, not on the section: a section matches
    // when at least one of its blocks overlaps [from, to) on that day.
    if (dayOfWeek !== undefined && from !== undefined && to !== undefined) {
      params.push(dayOfWeek, from, to);
      conditions.push(`exists (
        select 1 from section_times t
         where t.section_id = s.id
           and t.day_of_week = $${params.length - 2}
           and t.start_time < $${params.length}
           and t.end_time > $${params.length - 1})`);
    }

    if (cursor) {
      params.push(cursor.createdAt.toISOString(), cursor.id);
      conditions.push(`(s.created_at, s.id) < ($${params.length - 1}, $${params.length})`);
    }

    params.push(limit + 1);
    const { rows } = await query(
      `select ${SECTION_COLUMNS} ${FROM_SECTIONS}
        ${conditions.length > 0 ? `where ${conditions.join(' and ')}` : ''}
        order by s.created_at desc, s.id desc
        limit $${params.length}`,
      params,
    );

    return toPage(await withTimes(query, rows), limit);
  }

  /** Mode B: one round trip for a list of ids, in the order the caller asked. */
  async function findManyByIds(ids) {
    if (ids.length === 0) return { items: [], missingIds: [] };

    const { rows } = await query(
      `select ${SECTION_COLUMNS} ${FROM_SECTIONS} where s.id = any($1::uuid[])`,
      [ids],
    );
    const sections = new Map((await withTimes(query, rows)).map((section) => [section.id, section]));

    return {
      // Archived sections come back with `archivedAt` set: a saved timetable can
      // say "no longer offered" instead of showing a hole.
      items: ids.map((id) => sections.get(id)).filter(Boolean),
      missingIds: ids.filter((id) => !sections.has(id)),
    };
  }

  async function findLiveByCode(client, { courseId, sectionCode, excludeId = null }) {
    const { rows } = await client.query(
      `select id from sections
        where course_id = $1
          and upper(section_code) = upper($2)
          and archived_at is null
          and ($3::uuid is null or id <> $3)
        limit 1`,
      [courseId, sectionCode, excludeId],
    );
    return rows[0] ?? null;
  }

  /**
   * The room check, in the one order that works:
   *
   *   lock, then query. `SELECT … FOR UPDATE` cannot help here - the row that
   *   would conflict does not exist yet, so there is nothing to lock. A
   *   transaction-scoped advisory lock keyed on the room serialises the two
   *   writers that would otherwise both see "free" and both insert.
   *
   * Returns the first conflicting block, or null.
   */
  async function findRoomConflict(client, { room, dayOfWeek, startTime, endTime, excludeId = null }) {
    await client.query('select pg_advisory_xact_lock(hashtext($1))', [`room:${room}`]);

    const { rows } = await client.query(
      `select s.id as section_id, s.section_code, c.code as course_code,
              t.day_of_week, t.start_time, t.end_time
         from sections s
         join courses c on c.id = s.course_id
         join section_times t on t.section_id = s.id
        where s.archived_at is null
          and upper(s.room) = upper($1)
          and t.day_of_week = $2
          and t.start_time < $4
          and t.end_time > $3
          and ($5::uuid is null or s.id <> $5)
        order by t.start_time
        limit 1`,
      [room, dayOfWeek, startTime, endTime, excludeId],
    );

    if (rows.length === 0) return null;

    const [row] = rows;
    return {
      sectionId: row.section_id,
      sectionCode: row.section_code,
      courseCode: row.course_code,
      dayOfWeek: row.day_of_week,
      startTime: toHhMm(row.start_time),
      endTime: toHhMm(row.end_time),
    };
  }

  async function insert(client, { courseId, sectionCode, type, room, capacity, times }) {
    const { rows } = await client.query(
      `insert into sections (course_id, section_code, type, room, capacity)
       values ($1, $2, $3, $4, $5)
       returning id`,
      [courseId, sectionCode, type, room, capacity],
    );
    const id = rows[0].id;

    await insertTimes(client, id, times);
    return readBack(client, id);
  }

  async function insertTimes(client, sectionId, times) {
    if (times.length === 0) return;

    // One round trip for all blocks. Only the placeholders are generated; every
    // value travels as a parameter.
    const values = times.map((_, index) => `($1, $${index * 3 + 2}, $${index * 3 + 3}::time, $${index * 3 + 4}::time)`).join(', ');
    const params = [sectionId];
    for (const block of times) params.push(block.dayOfWeek, block.startTime, block.endTime);

    await client.query(
      `insert into section_times (section_id, day_of_week, start_time, end_time)
       values ${values}`,
      params,
    );
  }

  /** Re-read inside the same transaction, so the response reflects what was written. */
  async function readBack(client, id) {
    const { rows } = await client.query(`select ${SECTION_COLUMNS} ${FROM_SECTIONS} where s.id = $1`, [id]);
    if (rows.length === 0) return null;

    const { rows: timeRows } = await client.query(
      `select day_of_week, start_time, end_time from section_times
        where section_id = $1 order by day_of_week, start_time`,
      [id],
    );
    return toSection(rows[0], timeRows.map(toTime));
  }

  async function update(client, id, patch) {
    const sets = [];
    const params = [id];

    const COLUMN_OF = { sectionCode: 'section_code', type: 'type', room: 'room', capacity: 'capacity', archivedAt: 'archived_at' };
    for (const [field, value] of Object.entries(patch)) {
      // `times` are rows in another table, handled after the section row itself.
      if (field === 'times') continue;

      const column = COLUMN_OF[field];
      if (!column) throw new Error(`sections.update does not know the field "${field}".`);

      params.push(value);
      sets.push(`${column} = $${params.length}`);
    }

    if (sets.length > 0) {
      await client.query(`update sections set ${sets.join(', ')} where id = $1`, params);
    }

    if (patch.times !== undefined) {
      await client.query('delete from section_times where section_id = $1', [id]);
      await insertTimes(client, id, patch.times);
    }

    return readBack(client, id);
  }

  /**
   * Archiving is a single statement, and it is idempotent: the second call
   * returns the timestamp written by the first rather than moving it.
   */
  async function archive(id) {
    const { rows } = await query(
      `update sections
          set archived_at = coalesce(archived_at, now())
        where id = $1
        returning id, archived_at`,
      [id],
    );
    if (rows.length === 0) return null;

    return { id: rows[0].id, archivedAt: rows[0].archived_at };
  }

  return {
    findById,
    search,
    findManyByIds,
    findLiveByCode,
    findRoomConflict,
    insert,
    update,
    archive,
    withTransaction,
  };
}
