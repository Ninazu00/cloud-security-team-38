import { markSectionChanged } from "./db/timetablesRepo.js";
import { logEvent } from "./middleware/logger.js";

const STALE_EVENT_TYPES = new Set([
  "section.updated",
  "section.deleted",
  "section.archived",
  "catalogue-section-changed",
]);

export async function handler(event) {
  let processed = 0;
  for (const record of event.Records || []) {
    const body = typeof record.body === "string" ? JSON.parse(record.body) : record.body;
    const detailType = body["detail-type"] || body.detailType || "section.updated";
    const detail = body.detail || body;
    const sectionId = detail?.sectionId || detail?.id;
    const isArchived =
      detailType === "section.archived" ||
      detail?.archived === true ||
      String(detail?.status || "").toUpperCase() === "ARCHIVED";

    if (!sectionId) continue;
    if (!STALE_EVENT_TYPES.has(detailType) && !isArchived) continue;

    const affected = await markSectionChanged(sectionId);
    processed++;
    logEvent("info", "AUDIT", {
      action: isArchived ? "SECTION_ARCHIVED_PROCESSED" : "SECTION_CHANGED_PROCESSED",
      eventType: detailType,
      sectionId: String(sectionId),
      affectedTimetables: affected,
    });
  }
  return { processed };
}
