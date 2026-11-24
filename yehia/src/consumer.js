import { markSectionChanged } from "./db/timetablesRepo.js";
import { logEvent } from "./middleware/logger.js";

export async function handler(event) {
  let processed = 0;
  for (const record of event.Records || []) {
    const body = typeof record.body === "string" ? JSON.parse(record.body) : record.body;
    const detail = body.detail || body;
    const sectionId = detail?.sectionId || detail?.id;
    if (!sectionId) continue;

    const affected = await markSectionChanged(sectionId);
    processed++;
    logEvent("info", "AUDIT", {
      action: "SECTION_CHANGED_PROCESSED",
      sectionId: String(sectionId),
      affectedTimetables: affected,
    });
  }
  return { processed };
}
