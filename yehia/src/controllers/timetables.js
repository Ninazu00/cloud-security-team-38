import { findClashes } from "../domain/clash.js";
import { generateTimetables, MAX_COURSES, MAX_RESULTS } from "../domain/generator.js";
import { buildIcs } from "../domain/ics.js";
import { getSectionsByCourseIds, getSectionsByIds } from "../clients/sectionsClient.js";
import * as repo from "../db/timetablesRepo.js";
import { sanitizeText } from "../middleware/security.js";
import { logEvent } from "../middleware/logger.js";

function sendError(res, status, code, message, extra = {}) {
  return res.status(status).json({ error: { code, message, ...extra } });
}

function requireJson(req, res) {
  if (!req.is("application/json")) {
    sendError(res, 415, "UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/json.");
    return false;
  }
  return true;
}

function isNonEmptyIdArray(arr, maxLen = 50) {
  return (
    Array.isArray(arr) &&
    arr.length > 0 &&
    arr.length <= maxLen &&
    arr.every((v) => (typeof v === "string" || typeof v === "number") && String(v).trim().length > 0)
  );
}

async function hydrateTimetable(record, authHeader) {
  const sectionIds = record.sectionIds || [];
  const foundSections = sectionIds.length
    ? await getSectionsByIds(sectionIds, authHeader)
    : [];
  const foundMap = new Map(foundSections.map((s) => [String(s.id), s]));
  const missingSectionIds = sectionIds.filter((id) => !foundMap.has(String(id)));
  const archivedSectionIds = foundSections
    .filter((s) => s.status === "ARCHIVED")
    .map((s) => String(s.id));
  const stale =
    Boolean(record.stale) ||
    missingSectionIds.length > 0 ||
    archivedSectionIds.length > 0;

  return {
    id: record.timetableId,
    ownerId: record.userId,
    name: record.name,
    createdAt: record.createdAt,
    sectionIds,
    sections: foundSections,
    missingSectionIds,
    archivedSectionIds,
    stale,
  };
}

export async function checkClashes(req, res, next) {
  try {
    if (!requireJson(req, res)) return;
    const { sectionIds } = req.body || {};
    if (!isNonEmptyIdArray(sectionIds, 30)) {
      return sendError(res, 400, "VALIDATION_ERROR", "sectionIds must be a non-empty array of IDs.");
    }

    const ids = [...new Set(sectionIds.map(String))];
    const sections = await getSectionsByIds(ids, req.authHeader);
    const foundIds = new Set(sections.map((s) => String(s.id)));
    const missing = ids.filter((id) => !foundIds.has(id));
    if (missing.length > 0) {
      return sendError(res, 404, "SECTION_NOT_FOUND", `Unknown section IDs: ${missing.join(", ")}`);
    }

    const clashes = findClashes(sections);
    return res.status(200).json({ hasClashes: clashes.length > 0, clashes });
  } catch (err) {
    return next(err);
  }
}

export async function generate(req, res, next) {
  try {
    if (!requireJson(req, res)) return;
    const { courseIds } = req.body || {};
    if (!isNonEmptyIdArray(courseIds, MAX_COURSES)) {
      return sendError(
        res,
        400,
        "VALIDATION_ERROR",
        `courseIds must be a non-empty array of at most ${MAX_COURSES} course IDs.`
      );
    }

    const ids = [...new Set(courseIds.map(String))];
    const sections = await getSectionsByCourseIds(ids, req.authHeader);
    const result = generateTimetables(ids, sections, MAX_RESULTS);

    if (!result.ok && result.reason === "MISSING_COURSES") {
      return sendError(
        res,
        404,
        "COURSE_NOT_FOUND",
        `No sections found for course IDs: ${result.missingCourseIds.join(", ")}`
      );
    }

    if (!result.ok && result.reason === "NO_VALID_TIMETABLE") {
      return sendError(
        res,
        422,
        "NO_VALID_TIMETABLE",
        "No clash-free timetable exists for the selected courses.",
        {
          conflictingCourseIds: result.conflictingCourseIds,
          conflictingPairs: result.conflictingPairs,
        }
      );
    }

    return res.status(200).json({
      count: result.timetables.length,
      capped: result.timetables.length >= MAX_RESULTS,
      timetables: result.timetables,
    });
  } catch (err) {
    return next(err);
  }
}

export async function createTimetable(req, res, next) {
  try {
    if (!requireJson(req, res)) return;
    const { name, sectionIds } = req.body || {};

    if (typeof name !== "string" || name.trim().length < 2 || name.trim().length > 80) {
      return sendError(res, 400, "VALIDATION_ERROR", "Name must be between 2 and 80 characters.");
    }
    if (!isNonEmptyIdArray(sectionIds, 30)) {
      return sendError(res, 400, "VALIDATION_ERROR", "sectionIds must be a non-empty array of IDs.");
    }

    const cleanName = sanitizeText(name);
    if (cleanName.length < 2) {
      return sendError(res, 400, "VALIDATION_ERROR", "Name is invalid after sanitization.");
    }

    const ids = [...new Set(sectionIds.map(String))];
    const sections = await getSectionsByIds(ids, req.authHeader);
    const foundIds = new Set(sections.map((s) => String(s.id)));
    const missing = ids.filter((id) => !foundIds.has(id));
    if (missing.length > 0) {
      return sendError(res, 404, "SECTION_NOT_FOUND", `Unknown section IDs: ${missing.join(", ")}`);
    }

    const archived = sections.filter((s) => s.status === "ARCHIVED").map((s) => s.id);
    if (archived.length > 0) {
      return sendError(
        res,
        422,
        "SECTION_ARCHIVED",
        `Cannot save timetable with archived sections: ${archived.join(", ")}`
      );
    }

    const clashes = findClashes(sections);
    if (clashes.length > 0) {
      return sendError(res, 422, "TIMETABLE_CLASH", "Selected sections contain time clashes.", {
        clashes,
      });
    }

    // Owner always comes from verified JWT, never from req.body
    const saved = await repo.createTimetable({
      userId: req.user.id,
      name: cleanName,
      sectionIds: ids,
    });

    logEvent("info", "AUDIT", {
      action: "TIMETABLE_CREATED",
      userId: req.user.id,
      timetableId: saved.timetableId,
    });

    return res.status(201).json({
      id: saved.timetableId,
      ownerId: saved.userId,
      name: saved.name,
      createdAt: saved.createdAt,
      sectionIds: saved.sectionIds,
      sections,
      missingSectionIds: [],
      archivedSectionIds: [],
      stale: false,
    });
  } catch (err) {
    return next(err);
  }
}

export async function listTimetables(req, res, next) {
  try {
    const items = await repo.listTimetables(req.user.id);
    const result = items.map((r) => ({
      id: r.timetableId,
      ownerId: r.userId,
      name: r.name,
      createdAt: r.createdAt,
      sectionIds: r.sectionIds || [],
      stale: Boolean(r.stale),
    }));
    return res.status(200).json(result);
  } catch (err) {
    return next(err);
  }
}

export async function getTimetableById(req, res, next) {
  try {
    const record = await repo.getTimetable(req.user.id, req.params.id);
    if (!record) {
      return sendError(res, 404, "TIMETABLE_NOT_FOUND", "Timetable not found.");
    }
    const hydrated = await hydrateTimetable(record, req.authHeader);
    return res.status(200).json(hydrated);
  } catch (err) {
    return next(err);
  }
}

export async function downloadIcs(req, res, next) {
  try {
    const record = await repo.getTimetable(req.user.id, req.params.id);
    if (!record) {
      return sendError(res, 404, "TIMETABLE_NOT_FOUND", "Timetable not found.");
    }
    const hydrated = await hydrateTimetable(record, req.authHeader);
    const ics = buildIcs(hydrated, {
      termStartDate: process.env.TERM_START_DATE || "2026-09-20",
      termEndDate: process.env.TERM_END_DATE || "2026-12-24",
      timezone: process.env.TIMEZONE || "Africa/Cairo",
    });

    res.setHeader("Content-Type", "text/calendar; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="timetable-${hydrated.id}.ics"`);
    return res.status(200).send(ics);
  } catch (err) {
    return next(err);
  }
}

export async function deleteTimetable(req, res, next) {
  try {
    const deleted = await repo.deleteTimetable(req.user.id, req.params.id);
    if (!deleted) {
      return sendError(res, 404, "TIMETABLE_NOT_FOUND", "Timetable not found.");
    }
    logEvent("info", "AUDIT", {
      action: "TIMETABLE_DELETED",
      userId: req.user.id,
      timetableId: req.params.id,
    });
    return res.status(204).send();
  } catch (err) {
    return next(err);
  }
}
