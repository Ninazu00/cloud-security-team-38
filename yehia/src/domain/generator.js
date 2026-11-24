import { sectionsClash } from "./clash.js";

export const MAX_COURSES = 8;
export const MAX_RESULTS = 50;

function buildSlots(courseIds, sections) {
  const byCourse = new Map();
  for (const cid of courseIds) {
    byCourse.set(String(cid), new Map());
  }

  for (const sec of sections) {
    const cid = String(sec.courseId);
    if (!byCourse.has(cid)) continue;
    const typeMap = byCourse.get(cid);
    if (!typeMap.has(sec.type)) typeMap.set(sec.type, []);
    typeMap.get(sec.type).push(sec);
  }

  const slots = [];
  for (const [courseId, typeMap] of byCourse.entries()) {
    for (const [type, options] of typeMap.entries()) {
      slots.push({ courseId, type, options });
    }
  }

  // Pick slots with the fewest options first so conflicts prune immediately
  slots.sort((a, b) => a.options.length - b.options.length);
  return slots;
}

function backtrack(slots, limit) {
  const results = [];
  const chosen = [];

  function dfs(index) {
    if (results.length >= limit) return;
    if (index === slots.length) {
      results.push([...chosen]);
      return;
    }

    for (const candidate of slots[index].options) {
      let conflict = false;
      for (const picked of chosen) {
        if (sectionsClash(candidate, picked)) {
          conflict = true;
          break;
        }
      }
      if (conflict) continue;

      chosen.push(candidate);
      dfs(index + 1);
      chosen.pop();
      if (results.length >= limit) return;
    }
  }

  dfs(0);
  return results;
}

function explainConflicts(courseIds, sections) {
  const conflictingCourses = new Set();
  const pairs = [];

  // 1. Check if any single course conflicts with itself (e.g. its lecture vs its lab)
  for (const cid of courseIds) {
    const slots = buildSlots([cid], sections);
    if (slots.length === 0 || backtrack(slots, 1).length === 0) {
      conflictingCourses.add(String(cid));
    }
  }

  // 2. Check all course pairs
  for (let i = 0; i < courseIds.length; i++) {
    for (let j = i + 1; j < courseIds.length; j++) {
      const a = String(courseIds[i]);
      const b = String(courseIds[j]);
      if (conflictingCourses.has(a) || conflictingCourses.has(b)) continue;
      const slots = buildSlots([a, b], sections);
      if (backtrack(slots, 1).length === 0) {
        conflictingCourses.add(a);
        conflictingCourses.add(b);
        pairs.push([a, b]);
      }
    }
  }

  // 3. Fallback for 3+ way clashes where every individual pair works
  if (conflictingCourses.size === 0) {
    for (const cid of courseIds) conflictingCourses.add(String(cid));
  }

  return {
    conflictingCourseIds: [...conflictingCourses],
    conflictingPairs: pairs,
  };
}

export function generateTimetables(courseIds, sections, maxResults = MAX_RESULTS) {
  const uniqueIds = [...new Set(courseIds.map(String))];
  const slots = buildSlots(uniqueIds, sections);

  const missingCourseIds = uniqueIds.filter(
    (cid) => !slots.some((s) => s.courseId === cid)
  );
  if (missingCourseIds.length > 0) {
    return { ok: false, reason: "MISSING_COURSES", missingCourseIds };
  }

  const timetables = backtrack(slots, maxResults);
  if (timetables.length === 0) {
    return {
      ok: false,
      reason: "NO_VALID_TIMETABLE",
      ...explainConflicts(uniqueIds, sections),
    };
  }

  return {
    ok: true,
    timetables: timetables.map((secs) => ({
      sectionIds: secs.map((s) => String(s.id)),
      sections: secs,
    })),
  };
}
