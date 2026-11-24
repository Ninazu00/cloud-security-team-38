import fs from "node:fs";

const fixtureUrl = new URL("../../fixtures/sections.json", import.meta.url);

function loadMockSections() {
  return JSON.parse(fs.readFileSync(fixtureUrl, "utf8"));
}

async function fetchCatalogue(queryString, authHeader) {
  const baseUrl = (process.env.CATALOGUE_URL || "http://127.0.0.1:3001").replace(/\/$/, "");
  const res = await fetch(`${baseUrl}/api/sections?${queryString}`, {
    headers: { Authorization: authHeader },
  });
  if (!res.ok) {
    const err = new Error(`Catalogue returned ${res.status}`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  return Array.isArray(data) ? data : data.items || data.sections || [];
}

export async function getSectionsByCourseIds(courseIds, authHeader) {
  const ids = [...new Set(courseIds.map(String))];
  if ((process.env.DEP_MODE || "mock") === "mock") {
    const set = new Set(ids);
    return loadMockSections().filter((s) => set.has(String(s.courseId)));
  }
  const results = await Promise.all(
    ids.map((id) => fetchCatalogue(`courseId=${encodeURIComponent(id)}`, authHeader))
  );
  const byId = new Map();
  for (const list of results) {
    for (const section of list) {
      byId.set(String(section.id), section);
    }
  }
  return Array.from(byId.values());
}

export async function getSectionsByIds(sectionIds, authHeader) {
  const ids = sectionIds.map(String);
  if ((process.env.DEP_MODE || "mock") === "mock") {
    const set = new Set(ids);
    return loadMockSections().filter((s) => set.has(String(s.id)));
  }
  return fetchCatalogue(`ids=${encodeURIComponent(ids.join(","))}`, authHeader);
}
