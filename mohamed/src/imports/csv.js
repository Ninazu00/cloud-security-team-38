import { parse as parseCsv } from 'csv-parse/sync';

import { ApiError } from '../errors.js';
import { parseCode, parseCredits, parseTitle } from '../services/courses.service.js';
import {
  parseCapacity,
  parseRoom,
  parseSectionCode,
  parseTime,
  parseType,
} from '../services/sections.service.js';

/**
 * Turning an uploaded CSV into a plan, with no database in sight.
 *
 * Two things live together here on purpose:
 *
 *   1. the *shape* rules - header, column count, row cap - which decide whether
 *      this file even means anything, and
 *   2. the *value* rules - types, ranges, "these rows describe one section and
 *      must agree" - which decide whether each row can be imported.
 *
 * Both kinds become a list of `{ row, field, message }`, because the contract
 * promises a report, not a first failure. A file with nine bad rows should take
 * one upload to fix, not nine.
 *
 * The validators are imported from the services rather than re-implemented here:
 * a CSV row and a JSON body are the same course, and two copies of "credits are
 * 0–30" is how the two paths drift apart. Their `ApiError` is caught and turned
 * into a row-level message, because a report is data, not an exception.
 */

export const HEADER = [
  'course_code',
  'course_title',
  'credits',
  'section_code',
  'type',
  'room',
  'capacity',
  'day_of_week',
  'start_time',
  'end_time',
];

export const ROW_CAP = 5000;

/** Run one service validator and turn its message into a report line. */
function check(run) {
  try {
    return { ok: true, value: run() };
  } catch (error) {
    if (error instanceof ApiError) return { ok: false, message: error.message };
    throw error;
  }
}


/**
 * @returns {{ rowCount: number, courses: Array, sections: Array, errors: Array }}
 *   `errors` non-empty means "do not touch the database"; `courses` and
 *   `sections` are the plan, already grouped.
 */
export function parseCatalogueCsv(buffer) {
  let table;
  try {
    table = parseCsv(buffer, { bom: true, skip_empty_lines: true, relax_column_count: true });
  } catch (error) {
    return { rowCount: 0, courses: [], sections: [], errors: [{ row: 1, field: 'file', message: `could not be read as CSV: ${error.message}` }] };
  }

  if (table.length === 0) {
    return { rowCount: 0, courses: [], sections: [], errors: [{ row: 1, field: 'file', message: 'the file is empty' }] };
  }

  const header = table[0].map((cell) => String(cell).trim().replaceAll('\uFEFF', ''));
  const headerProblems = checkHeader(header);
  if (headerProblems.length > 0) {
    return { rowCount: 0, courses: [], sections: [], errors: headerProblems };
  }

  const column = new Map(header.map((name, index) => [name, index]));
  const dataRows = table.slice(1);
  if (dataRows.length > ROW_CAP) {
    return {
      rowCount: dataRows.length,
      courses: [],
      sections: [],
      errors: [{ row: 1, field: 'file', message: `${dataRows.length} rows is over the ${ROW_CAP}-row limit` }],
    };
  }

  const errors = [];
  const rows = [];

  dataRows.forEach((cells, index) => {
    // The header is row 1, so the first data row is row 2 - the numbers a
    // spreadsheet shows.
    const row = index + 2;

    if (cells.length !== header.length) {
      errors.push({ row, field: 'row', message: `expected ${header.length} columns, found ${cells.length}` });
      return;
    }

    const value = (name) => String(cells[column.get(name)] ?? '').trim();
    const parsed = { row };

    const code = check(() => parseCode(value('course_code')));
    if (!code.ok) errors.push({ row, field: 'course_code', message: code.message });
    else parsed.courseCode = code.value;

    const title = check(() => parseTitle(value('course_title')));
    if (!title.ok) errors.push({ row, field: 'course_title', message: title.message });
    else parsed.courseTitle = title.value;

    const credits = check(() => parseCredits(Number(value('credits'))));
    if (!credits.ok) errors.push({ row, field: 'credits', message: credits.message });
    else parsed.credits = credits.value;

    const sectionCode = check(() => parseSectionCode(value('section_code')));
    if (!sectionCode.ok) errors.push({ row, field: 'section_code', message: sectionCode.message });
    else parsed.sectionCode = sectionCode.value;

    const type = check(() => parseType(value('type')));
    if (!type.ok) errors.push({ row, field: 'type', message: type.message });
    else parsed.type = type.value;

    const room = check(() => parseRoom(value('room')));
    if (!room.ok) errors.push({ row, field: 'room', message: room.message });
    else parsed.room = room.value;

    const capacity = check(() => parseCapacity(Number(value('capacity'))));
    if (!capacity.ok) errors.push({ row, field: 'capacity', message: capacity.message });
    else parsed.capacity = capacity.value;

    const day = Number(value('day_of_week'));
    if (!Number.isInteger(day) || day < 0 || day > 6) {
      errors.push({ row, field: 'day_of_week', message: 'must be an integer from 0 (Sunday) to 6 (Saturday)' });
    } else {
      parsed.dayOfWeek = day;
    }

    const start = check(() => parseTime(value('start_time'), 'start_time'));
    if (!start.ok) errors.push({ row, field: 'start_time', message: start.message });
    else parsed.startTime = start.value;

    const end = check(() => parseTime(value('end_time'), 'end_time'));
    if (!end.ok) errors.push({ row, field: 'end_time', message: end.message });
    else parsed.endTime = end.value;

    if (parsed.startTime && parsed.endTime && parsed.startTime >= parsed.endTime) {
      errors.push({ row, field: 'end_time', message: 'must be after start_time' });
    }

    // A row that already failed is kept out of the plan: it must not create a
    // half-section that then conflicts with something.
    if (errors.every((error) => error.row !== row)) rows.push(parsed);
  });

  const { courses, sections } = group(rows, errors);

  return { rowCount: dataRows.length, courses, sections, errors };
}

function checkHeader(header) {
  const errors = [];
  const seen = new Set();

  for (const name of header) {
    if (!HEADER.includes(name)) {
      errors.push({ row: 1, field: name || '(blank)', message: 'unknown column' });
      continue;
    }
    if (seen.has(name)) errors.push({ row: 1, field: name, message: 'column appears more than once' });
    seen.add(name);
  }
  for (const name of HEADER) {
    if (!seen.has(name)) errors.push({ row: 1, field: name, message: 'missing column' });
  }

  return errors;
}

/**
 * Collapse rows into one course per code and one section per (course, code).
 *
 * This is where "several rows may describe the same section" becomes either a
 * legal multi-block section or a contradiction: a lab meeting twice a week is
 * fine, but the second row cannot disagree about the room.
 */
function group(rows, errors) {
  const courses = new Map();
  const sections = new Map();

  for (const row of rows) {
    const course = courses.get(row.courseCode);
    if (!course) {
      courses.set(row.courseCode, { code: row.courseCode, title: row.courseTitle, credits: row.credits, rows: [row.row] });
    } else if (course.title !== row.courseTitle || course.credits !== row.credits) {
      errors.push({
        row: row.row,
        field: course.title !== row.courseTitle ? 'course_title' : 'credits',
        message: `does not match row ${course.rows[0]} for course ${row.courseCode}`,
      });
      continue;
    }

    const key = `${row.courseCode}|${row.sectionCode}`;
    const section = sections.get(key);
    const block = { dayOfWeek: row.dayOfWeek, startTime: row.startTime, endTime: row.endTime };

    if (!section) {
      sections.set(key, {
        courseCode: row.courseCode,
        sectionCode: row.sectionCode,
        type: row.type,
        room: row.room,
        capacity: row.capacity,
        rows: [row.row],
        times: [block],
      });
      continue;
    }

    const mismatch = section.type !== row.type ? 'type' : section.room !== row.room ? 'room' : section.capacity !== row.capacity ? 'capacity' : null;
    if (mismatch) {
      errors.push({
        row: row.row,
        field: mismatch,
        message: `does not match row ${section.rows[0]} for section ${row.sectionCode}`,
      });
      continue;
    }

    // Same predicate as everywhere else: half-open, so 10:00–11:00 and
    // 11:00–12:00 in one section is a normal lab, not an overlap.
    const clash = section.times.find((other) => other.dayOfWeek === block.dayOfWeek && block.startTime < other.endTime && other.startTime < block.endTime);
    if (clash) {
      errors.push({
        row: row.row,
        field: 'start_time',
        message: `overlaps the block on row ${section.rows[0]} (${clash.startTime}–${clash.endTime})`,
      });
      continue;
    }

    section.times.push(block);
    section.rows.push(row.row);
  }

  for (const section of sections.values()) {
    section.times.sort((a, b) => a.dayOfWeek - b.dayOfWeek || a.startTime.localeCompare(b.startTime));
  }

  return { courses: [...courses.values()], sections: [...sections.values()] };
}


