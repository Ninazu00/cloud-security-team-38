import { createHash } from 'node:crypto';

import { conflict, notFound, unprocessable } from '../errors.js';
import { decodeCursor, parseLimit } from '../http/pagination.js';
import { parseCatalogueCsv } from '../imports/csv.js';

/**
 * Bulk import: parse, plan, then either write everything or write nothing.
 *
 * The shape of this service is the contract's promise made executable. The
 * database work happens inside ONE transaction; if any row is unacceptable we
 * throw, the transaction rolls back, and *then* a second, separate write records
 * the failure. That ordering matters: a rejected file still leaves evidence, but
 * never leaves half a catalogue.
 *
 * `dryRun` is the same code path with a deliberate rollback at the end. There is
 * no second validator, because two validators always drift and then the preview
 * lies.
 */

const REPORT_LIMIT = 100;
const STATUSES = ['committed', 'failed'];
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Control flow, not an error: used to roll the transaction back on purpose. */
class Rollback extends Error {}

/** The public report: capped, with the true total alongside it. */
function report(errors) {
  return {
    totalErrors: errors.length,
    truncated: errors.length > REPORT_LIMIT,
    errors: errors
      .slice(0, REPORT_LIMIT)
      .map(({ row, field, message }) => ({ row, field, message })),
  };
}

export function createImportsService({ imports, courses, sections, withTransaction, log }) {
  /**
   * Write the plan. Any row-level refusal lands in `errors` and the caller
   * throws afterwards, so the report can carry every problem instead of the
   * first one.
   */
  async function applyPlan(client, plan, errors) {
    const courseIds = new Map();
    let coursesTouched = 0;

    for (const course of plan.courses) {
      const result = await courses.upsert(client, course);

      if (result.archived) {
        errors.push({
          row: course.rows[0],
          field: 'course_code',
          message: `course ${course.code} is archived; restore it or use a different code`,
        });
        continue;
      }
      if (result.created || result.updated) coursesTouched += 1;
      courseIds.set(course.code, result.id);
    }

    let sectionsInserted = 0;
    let timesInserted = 0;

    for (const section of plan.sections) {
      const courseId = courseIds.get(section.courseCode);
      // The course row was refused above; its sections have nowhere to go.
      if (!courseId) continue;

      const existing = await sections.findLiveByCode(client, { courseId, sectionCode: section.sectionCode });
      if (existing) {
        errors.push({
          row: section.rows[0],
          field: 'section_code',
          message: `section ${section.sectionCode} already exists in ${section.courseCode}`,
        });
        continue;
      }

      // One lookup per block. A section that clashes on Tuesday must report the
      // Tuesday, and blocks inserted earlier in this transaction are visible here
      // — so a file that books one room twice is caught against itself.
      let clash = null;
      for (const block of section.times) {
        clash = await sections.findRoomConflict(client, {
          room: section.room,
          dayOfWeek: block.dayOfWeek,
          startTime: block.startTime,
          endTime: block.endTime,
        });
        if (clash) break;
      }

      if (clash) {
        errors.push({
          row: section.rows[0],
          field: 'room',
          message: `${section.room} is already booked on day ${clash.dayOfWeek}, ${clash.startTime}–${clash.endTime} (${clash.courseCode}-${clash.sectionCode})`,
        });
        continue;
      }

      await sections.insert(client, {
        courseId,
        sectionCode: section.sectionCode,
        type: section.type,
        room: section.room,
        capacity: section.capacity,
        times: section.times,
      });
      sectionsInserted += 1;
      timesInserted += section.times.length;
    }

    return { courses: coursesTouched, sections: sectionsInserted, times: timesInserted };
  }

  async function importCatalogue({ buffer, filename, dryRun, actor }) {
    const hash = createHash('sha256').update(buffer).digest();

    // Before parsing: "this is already in" is the cheapest useful answer, and it
    // applies to a dry run too.
    const already = await imports.findCommittedByHash(hash);
    if (already) {
      throw conflict('ALREADY_IMPORTED', 'This exact file was already imported.', { importId: already });
    }

    const plan = parseCatalogueCsv(buffer);
    const errors = [...plan.errors];
    let counts = null;
    let committed = null;

    try {
      counts = await withTransaction(async (client) => {
        const applied = await applyPlan(client, plan, errors);
        if (errors.length > 0) throw new Rollback();

        if (dryRun) throw new Rollback();

        committed = await imports.insertCommitted(client, {
          hash,
          filename,
          rowCount: plan.rowCount,
          createdBy: actor.userId,
        });
        return applied;
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }

    if (errors.length > 0) {
      // A real attempt keeps a record of the rejection; a dry run writes nothing
      // at all, so there is no id to quote back.
      const record = dryRun
        ? null
        : await imports.insertFailed({
            hash,
            filename,
            rowCount: plan.rowCount,
            errorCount: errors.length,
            report: report(errors),
            createdBy: actor.userId,
          });

      log?.info?.({ msg: 'import.rejected', rowCount: plan.rowCount, errorCount: errors.length, dryRun });

      throw unprocessable(
        'IMPORT_INVALID',
        `${errors.length} ${errors.length === 1 ? 'row could' : 'rows could'} not be imported.`,
        {
          ...(record ? { importId: record.id } : {}),
          ...report(errors),
        },
      );
    }

    if (dryRun) {
      log?.info?.({ msg: 'import.validated', rowCount: plan.rowCount });
      return { valid: true, rowCount: plan.rowCount, errors: [] };
    }

    log?.info?.({ msg: 'import.committed', importId: committed.id, rowCount: plan.rowCount, ...counts });
    return { importId: committed.id, status: 'committed', rowCount: plan.rowCount, imported: counts };
  }

  async function list(query) {
    // A value that parsed but is not one of the two statuses is a rule broken,
    // not a request we could not read — the same 422 the other filters use.
    if (query.status !== undefined && !STATUSES.includes(query.status)) {
      throw unprocessable('VALIDATION_FAILED', `status must be one of ${STATUSES.join(', ')}.`, { field: 'status' });
    }

    const page = await imports.list({
      status: query.status,
      limit: parseLimit(query.limit),
      cursor: decodeCursor(query.cursor),
    });

    return { items: page.items, nextCursor: page.nextCursor ?? null };
  }

  async function get(id) {
    const record = UUID_PATTERN.test(id ?? '') ? await imports.findById(id) : null;
    if (!record) throw notFound('IMPORT_NOT_FOUND', 'No such import.');

    // The stored report is already capped; the shape is fixed here so the read
    // endpoint does not leak the internal jsonb layout.
    return {
      ...record,
      report: record.report ? { errors: record.report.errors ?? [] } : null,
    };
  }

  return { importCatalogue, list, get };
}
