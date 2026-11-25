import fs from "node:fs";

const fixtureUrl = new URL("../../fixtures/sections.json", import.meta.url);
const MAX_PAGES = 20;
const PAGE_LIMIT = 100;

const DAY_MAP = {
  "0": "Sun", sun: "Sun", sunday: "Sun",
  "1": "Mon", mon: "Mon", monday: "Mon",
  "2": "Tue", tue: "Tue", tuesday: "Tue",
  "3": "Wed", wed: "Wed", wednesday: "Wed",
  "4": "Thu", thu: "Thu", thursday: "Thu",
  "5": "Fri", fri: "Fri", friday: "Fri",
  "6": "Sat", sat: "Sat", saturday: "Sat",
};

function normalizeDay(rawDay) {
  if (rawDay === undefined || rawDay === null) return rawDay;
  const key = String(rawDay).trim().toLowerCase();
  return DAY_MAP[key] || String(rawDay).trim();
}

function normalizeTime(rawTime) {
  if (!rawTime) return rawTime;
  const match = String(rawTime).trim().match(/^(\d{1,2}:\d{2})/);
  if (!match) return String(rawTime).trim();
  const [h, m] = match[1].split(":");
  return `${h.padStart(2, "0")}:${m}`;
}

export function isSectionArchived(raw) {
  if (!raw) return false;
  if (raw.archived === true || raw.isArchived === true) return true;
  return String(raw.status || "").trim().toUpperCase() === "ARCHIVED";
}

export function normalizeSection(raw) {
  const archived = isSectionArchived(raw);
  const status = archived
    ? "ARCHIVED"
    : String(raw.status || "ACTIVE").trim().toUpperCase();

  return {
    id: String(raw.id ?? raw.sectionId),
    courseId: String(raw.courseId ?? raw.course?.id ?? ""),
    courseCode: raw.courseCode ?? raw.course?.code ?? null,
    courseTitle: raw.courseTitle ?? raw.course?.title ?? null,
    sectionNumber: raw.sectionNumber ?? raw.code ?? raw.name ?? null,
    day: normalizeDay(raw.day ?? raw.dayOfWeek),
    start: normalizeTime(raw.start ?? raw.startTime),
    end: normalizeTime(raw.end ?? raw.endTime),
    room: raw.room ?? raw.location ?? null,
    instructor: raw.instructor ?? null,
    status,
  };
}

function loadMockSections() {
  return JSON.parse(fs.readFileSync(fixtureUrl, "utf8")).map(normalizeSection);
}

async function fetchCataloguePaginated(baseParams, authHeader) {
  const baseUrl = (process.env.CATALOGUE_URL || "http://127.0.0.1:3001").replace(/\/$/, "");
  const allItems = [];
  let page = 1;
  let cursor = null;

  while (page <= MAX_PAGES) {
    const params = new URLSearchParams(baseParams);
    params.set("limit", String(PAGE_LIMIT));
    if (cursor) {
      params.set("cursor", cursor);
    } else {
      params.set("page", String(page));
    }

    const res = await fetch(`${baseUrl}/api/sections?${params.toString()}`, {
      headers: { Authorization: authHeader },
    });
    if (!res.ok) {
      const err = new Error(`Catalogue returned ${res.status}`);
      err.status = res.status;
      throw err;
    }

    const data = await res.json();
    const rawItems = Array.isArray(data) ? data : data.items || data.sections || [];
    allItems.push(...rawItems);

    const nextCursor = data.nextCursor ?? data.meta?.nextCursor ?? null;
    const totalPages = data.totalPages ?? data.meta?.totalPages ?? null;
    const total = data.total ?? data.meta?.total ?? null;
    const hasNext =
      Boolean(nextCursor) ||
      data.hasNext === true ||
      data.hasNextPage === true ||
      data.meta?.hasNext === true ||
      data.meta?.hasNextPage === true ||
      (totalPages !== null && page < Number(totalPages)) ||
      (total !== null && allItems.length < Number(total));

    if (!hasNext || rawItems.length === 0) break;

    cursor = nextCursor;
    page += 1;
  }

  return allItems.map(normalizeSection);
}

export async function getSectionsByCourseIds(courseIds, authHeader) {
  const ids = [...new Set(courseIds.map(String))];
  if ((process.env.DEP_MODE || "mock") === "mock") {
    const set = new Set(ids);
    return loadMockSections().filter(
      (s) => set.has(String(s.courseId)) && s.status !== "ARCHIVED"
    );
  }

  const results = await Promise.all(
    ids.map((id) => fetchCataloguePaginated({ courseId: id }, authHeader))
  );
  const byId = new Map();
  for (const list of results) {
    for (const section of list) {
      if (section.status === "ARCHIVED") continue;
      byId.set(String(section.id), section);
    }
  }
  return Array.from(byId.values());
}

export async function getSectionsByIds(sectionIds, authHeader) {
  const ids = [...new Set(sectionIds.map(String))];
  if ((process.env.DEP_MODE || "mock") === "mock") {
    const set = new Set(ids);
    return loadMockSections().filter((s) => set.has(String(s.id)));
  }
  return fetchCataloguePaginated({ ids: ids.join(",") }, authHeader);
}
