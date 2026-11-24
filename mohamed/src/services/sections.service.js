import { badRequest, conflict, forbidden, notFound, unprocessable } from '../errors.js';
import { decodeCursor, parseLimit } from '../http/pagination.js';

/**
 * The catalogue's write rules, in one place.
 *
 * The one that matters: a room cannot be double-booked. That is a property of
 * *our* data, not of any student's timetable, so it is enforced here, at write
 * time, inside the same transaction as the insert — see
 * `sections.model.js#findRoomConflict` for the lock that makes it race-free.
 *
 * Deliberately **not** enforced here:
 *   - whether one student can attend two sections at once (Timetable owns the
 *     choice, and it has the `times` this API returns),
 *   - whether a section's course is archived (a section may stay live on a
 *     course that was archived later; only *adding* to an archived course is
 *     refused).
 */

const SECTION_CODE_MAX = 10;
const ROOM_MAX = 32;
const CAPACITY_MIN = 1;
const CAPACITY_MAX = 500;
const TIMES_MIN = 1;
const TIMES_MAX = 5;
const BATCH_MAX = 100;
const TYPES = ['lecture', 'lab', 'tutorial'];

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIME_PATTERN = /^(\d{1,2}):([0-5]\d)$/;

/** Postgres answers 22P02 for a malformed uuid; checking first keeps that a 404. */
export function isUuid(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function invalid(field, message) {
  return unprocessable('VALIDATION_FAILED', message, { field });
}

export function parseTime(value, field) {
  const match = typeof value === 'string' ? TIME_PATTERN.exec(value) : null;
  if (!match) throw invalid(field, `${field} must look like "HH:MM".`);

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23) throw invalid(field, `${field} must be a time of day, 00:00 to 23:59.`);

  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

export function parseSectionCode(value) {
  if (typeof value !== 'string') throw invalid('sectionCode', 'sectionCode is required.');

  const code = value.trim();
  if (code.length === 0 || code.length > SECTION_CODE_MAX) {
    throw invalid('sectionCode', `sectionCode must be 1 to ${SECTION_CODE_MAX} characters.`);
  }
  return code;
}

export function parseType(value) {
  if (!TYPES.includes(value)) {
    throw invalid('type', `type must be one of ${TYPES.join(', ')}.`);
  }
  return value;
}

export function parseRoom(value) {
  if (typeof value !== 'string') throw invalid('room', 'room is required.');

  const room = value.trim();
  if (room.length === 0 || room.length > ROOM_MAX) {
    throw invalid('room', `room must be 1 to ${ROOM_MAX} characters.`);
  }
  return room;
}

export function parseCapacity(value) {
  if (!Number.isInteger(value) || value < CAPACITY_MIN || value > CAPACITY_MAX) {
    throw invalid('capacity', `capacity must be an integer between ${CAPACITY_MIN} and ${CAPACITY_MAX}.`);
  }
  return value;
}

/**
 * Times are validated as a *set*, because the interesting rule is about the
 * relationship between blocks: two of them must not overlap each other.
 */
export function parseTimes(value) {
  if (!Array.isArray(value) || value.length < TIMES_MIN || value.length > TIMES_MAX) {
    throw invalid('times', `times must be an array of ${TIMES_MIN} to ${TIMES_MAX} blocks.`);
  }

  const blocks = value.map((block, index) => {
    if (block === null || typeof block !== 'object') {
      throw invalid(`times[${index}]`, 'each block needs dayOfWeek, startTime and endTime.');
    }

    const { dayOfWeek } = block;
    if (!Number.isInteger(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6) {
      throw invalid('dayOfWeek', 'dayOfWeek must be an integer from 0 (Sunday) to 6 (Saturday).');
    }

    const startTime = parseTime(block.startTime, 'startTime');
    const endTime = parseTime(block.endTime, 'endTime');
    if (startTime >= endTime) {
      throw invalid('endTime', 'a block must end after it starts; overnight classes are not supported.');
    }

    return { dayOfWeek, startTime, endTime };
  });

  // Same predicate as the room check and the CSV validator: half-open blocks,
  // so 10:00–11:00 followed by 11:00–12:00 is legal.
  for (let i = 0; i < blocks.length; i += 1) {
    for (let j = i + 1; j < blocks.length; j += 1) {
      const a = blocks[i];
      const b = blocks[j];
      if (a.dayOfWeek === b.dayOfWeek && a.startTime < b.endTime && b.startTime < a.endTime) {
        throw badRequest(
          'VALIDATION_FAILED',
          `block ${i + 1} and block ${j + 1} overlap; a section cannot be in two places at once.`,
          { field: 'times', blocks: [i, j] },
        );
      }
    }
  }

  return blocks.sort((a, b) => a.dayOfWeek - b.dayOfWeek || a.startTime.localeCompare(b.startTime));
}

/** One message the admin UI can show: "B-204 is booked by CS102-L2, Mon 10:00–11:30". */
function conflictError(conflicts) {
  const [first] = conflicts;
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  return conflict('ROOM_CONFLICT', `That room is already booked: ${first.courseCode}-${first.sectionCode} on ${days[first.dayOfWeek]} ${first.startTime}–${first.endTime}.`, {
    conflictingSectionId: first.sectionId,
    conflictingSectionCode: first.sectionCode,
    courseCode: first.courseCode,
    // The contract names this field `conflict`, and the admin UI shows it verbatim.
    conflict: `${first.courseCode}-${first.sectionCode} ${days[first.dayOfWeek]} ${first.startTime}–${first.endTime}`,
    conflicts,
  });
}

export function createSectionsService({ sections, courses, adminOnly }) {
  /** The room check and the insert share a transaction: that is the whole point. */
  async function assertRoomsFree(client, { room, times, excludeId = null }) {
    const conflicts = [];
    for (const block of times) {
      const conflict = await sections.findRoomConflict(client, {
        room,
        dayOfWeek: block.dayOfWeek,
        startTime: block.startTime,
        endTime: block.endTime,
        excludeId,
      });
      if (conflict) conflicts.push(conflict);
    }
    if (conflicts.length > 0) throw conflictError(conflicts);
  }

  async function list(query, viewer) {
    // Mode B — the frozen call the other services make. It ignores every filter,
    // including paging: the id list is the query.
    if (query.ids !== undefined) {
      const FILTERS = ['courseId', 'courseCode', 'dayOfWeek', 'from', 'to', 'room', 'type', 'includeArchived', 'limit', 'cursor'];
      const mixed = FILTERS.filter((name) => query[name] !== undefined);
      if (mixed.length > 0) {
        throw badRequest('VALIDATION_FAILED', 'ids cannot be combined with filters.', { fields: mixed });
      }

      const ids = String(query.ids)
        .split(',')
        .map((id) => id.trim())
        .filter((id) => id.length > 0);

      if (ids.length === 0) throw badRequest('VALIDATION_FAILED', 'ids must contain at least one id.', { field: 'ids' });
      if (ids.length > BATCH_MAX) throw badRequest('VALIDATION_FAILED', `ids accepts at most ${BATCH_MAX} ids.`, { field: 'ids', count: ids.length });
      const bad = ids.find((id) => !isUuid(id));
      if (bad !== undefined) throw badRequest('VALIDATION_FAILED', `"${bad}" is not a uuid.`, { field: 'ids' });

      return sections.findManyByIds(ids);
    }

    const includeArchived = query.includeArchived === 'true';
    if (includeArchived && viewer.role !== 'admin') {
      throw forbidden('FORBIDDEN', 'Only an admin may ask for archived sections.');
    }

    const { dayOfWeek, from, to } = query;
    const hasWindow = from !== undefined || to !== undefined;
    if (hasWindow && dayOfWeek === undefined) {
      throw badRequest('VALIDATION_FAILED', 'from and to need dayOfWeek: a window is a day plus two times.', { field: 'dayOfWeek' });
    }

    let window = null;
    if (dayOfWeek !== undefined) {
      const day = Number(dayOfWeek);
      if (!Number.isInteger(day) || day < 0 || day > 6) {
        throw badRequest('VALIDATION_FAILED', 'dayOfWeek must be an integer from 0 (Sunday) to 6 (Saturday).', { field: 'dayOfWeek' });
      }
      if (hasWindow && from !== undefined && to !== undefined) {
        const start = parseTime(from, 'from');
        const end = parseTime(to, 'to');
        if (start >= end) throw badRequest('VALIDATION_FAILED', 'to must be after from.', { field: 'to' });

        window = { dayOfWeek: day, from: start, to: end };
      }
    }

    if (query.courseId !== undefined && !isUuid(query.courseId)) {
      throw badRequest('VALIDATION_FAILED', 'courseId must be a uuid.', { field: 'courseId' });
    }

    const page = await sections.search({
      courseId: query.courseId,
      courseCode: query.courseCode,
      dayOfWeek: window?.dayOfWeek,
      from: window?.from,
      to: window?.to,
      room: query.room,
      type: query.type,
      includeArchived,
      limit: parseLimit(query.limit),
      cursor: decodeCursor(query.cursor),
    });

    return { items: page.items, nextCursor: page.nextCursor ?? null, missingIds: [] };
  }

  async function get(id) {
    if (!isUuid(id)) throw notFound('SECTION_NOT_FOUND', 'No such section.');
    const section = await sections.findById(id);
    if (!section) throw notFound('SECTION_NOT_FOUND', 'No such section.');
    return section;
  }

  async function create(body) {
    const courseId = body?.courseId;
    if (!isUuid(courseId)) throw invalid('courseId', 'courseId must be a uuid.');

    const sectionCode = parseSectionCode(body.sectionCode);
    const type = parseType(body.type);
    const room = parseRoom(body.room);
    const capacity = parseCapacity(body.capacity);
    const times = parseTimes(body.times);

    // `courses.get` answers 404 COURSE_NOT_FOUND for an unknown or malformed id,
    // which is the contract's error for this route too.
    const course = await courses.get(courseId);
    if (course.archivedAt) throw conflict('COURSE_ARCHIVED', 'Cannot add a section to an archived course.');

    return sections.withTransaction(async (client) => {
      const taken = await sections.findLiveByCode(client, { courseId, sectionCode });
      if (taken) throw conflict('SECTION_CODE_TAKEN', `This course already has an active section "${sectionCode}".`, { sectionCode });

      await assertRoomsFree(client, { room, times });

      try {
        return await sections.insert(client, { courseId, sectionCode, type, room, capacity, times });
      } catch (error) {
        // Two admins submitting the same code at the same instant: the unique
        // index is the last word, and the loser gets the same 409 as a retry.
        if (error?.code === '23505') {
          throw conflict('SECTION_CODE_TAKEN', `This course already has an active section "${sectionCode}".`, { sectionCode });
        }
        throw error;
      }
    });
  }

  async function update(id, body) {
    if (!isUuid(id)) throw notFound('SECTION_NOT_FOUND', 'No such section.');

    const existing = await sections.findById(id);
    if (!existing) throw notFound('SECTION_NOT_FOUND', 'No such section.');

    const patch = {};
    if (body.sectionCode !== undefined) patch.sectionCode = parseSectionCode(body.sectionCode);
    if (body.type !== undefined) patch.type = parseType(body.type);
    if (body.room !== undefined) patch.room = parseRoom(body.room);
    if (body.capacity !== undefined) patch.capacity = parseCapacity(body.capacity);
    if (body.times !== undefined) patch.times = parseTimes(body.times);
    if (body.archived !== undefined) {
      if (typeof body.archived !== 'boolean') throw invalid('archived', 'archived must be true or false.');
      patch.archivedAt = body.archived ? (existing.archivedAt ?? new Date()) : null;
    }
    if (body.courseId !== undefined && body.courseId !== existing.course.id) {
      throw invalid('courseId', 'courseId cannot be changed; move the offering by creating a new section.');
    }
    if (Object.keys(patch).length === 0) return existing;

    // The state *after* the patch decides whether the room check applies: an
    // archived section reserves nothing, and restoring one must re-check.
    const nextRoom = patch.room ?? existing.room;
    const nextTimes = patch.times ?? existing.times;
    const nextArchived = patch.archivedAt !== undefined ? patch.archivedAt : existing.archivedAt;

    return sections.withTransaction(async (client) => {
      const code = patch.sectionCode ?? existing.sectionCode;
      if (patch.sectionCode !== undefined && nextArchived === null) {
        // Restoring or renaming into a code another live section already holds.
        const taken = await sections.findLiveByCode(client, {
          courseId: existing.course.id,
          sectionCode: code,
          excludeId: id,
        });
        if (taken) throw conflict('SECTION_CODE_TAKEN', `This course already has an active section "${code}".`, { sectionCode: code });
      }

      if (nextArchived === null) {
        await assertRoomsFree(client, { room: nextRoom, times: nextTimes, excludeId: id });
      }

      try {
        return await sections.update(client, id, patch);
      } catch (error) {
        if (error?.code === '23505') {
          throw conflict('SECTION_CODE_TAKEN', `This course already has an active section "${code}".`, { sectionCode: code });
        }
        throw error;
      }
    });
  }

  async function remove(id) {
    if (!isUuid(id)) throw notFound('SECTION_NOT_FOUND', 'No such section.');

    const archived = await sections.archive(id);
    if (!archived) throw notFound('SECTION_NOT_FOUND', 'No such section.');
    return archived;
  }

  return { list, get, create, update, remove, adminOnly };
}
