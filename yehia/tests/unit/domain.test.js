import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { timesClash, findClashes } from "../../src/domain/clash.js";
import { generateTimetables } from "../../src/domain/generator.js";
import { buildIcs } from "../../src/domain/ics.js";

const mockSections = JSON.parse(
  fs.readFileSync(new URL("../../fixtures/sections.json", import.meta.url), "utf8")
);

test("clash: overlapping intervals on same day clash", () => {
  assert.equal(
    timesClash({ day: "sun", start: "09:00", end: "10:30" }, { day: "sun", start: "09:30", end: "11:00" }),
    true
  );
});

test("clash: boundary end == start is NOT a clash", () => {
  assert.equal(
    timesClash({ day: "sun", start: "09:00", end: "10:30" }, { day: "sun", start: "10:30", end: "12:00" }),
    false
  );
});

test("clash: identical times on different days do NOT clash", () => {
  assert.equal(
    timesClash({ day: "sun", start: "09:00", end: "10:30" }, { day: "mon", start: "09:00", end: "10:30" }),
    false
  );
});

test("findClashes returns clashing pair details", () => {
  const s101 = mockSections.find((s) => s.id === "101");
  const s201 = mockSections.find((s) => s.id === "201");
  const clashes = findClashes([s101, s201]);
  assert.equal(clashes.length, 1);
  assert.equal(clashes[0].sectionAId, "101");
  assert.equal(clashes[0].sectionBId, "201");
});

test("generator produces valid clash-free timetables for courses 1, 2, 3", () => {
  const res = generateTimetables(["1", "2", "3"], mockSections);
  assert.equal(res.ok, true);
  assert.ok(res.timetables.length > 0);
  // Every generated timetable must have zero clashes
  for (const tt of res.timetables) {
    assert.equal(findClashes(tt.sections).length, 0);
  }
});

test("generator explains conflict when impossible course 4 is combined with course 1", () => {
  const res = generateTimetables(["1", "4"], mockSections);
  assert.equal(res.ok, false);
  assert.equal(res.reason, "NO_VALID_TIMETABLE");
  assert.deepEqual(res.conflictingCourseIds.sort(), ["1", "4"]);
});

test("ics builder outputs valid VCALENDAR with Africa/Cairo TZID", () => {
  const ics = buildIcs(
    { id: "tt-1", name: "Fall Plan", sections: [mockSections[0]] },
    { termStartDate: "2026-09-20", termEndDate: "2026-12-24", timezone: "Africa/Cairo" }
  );
  assert.match(ics, /BEGIN:VCALENDAR/);
  assert.match(ics, /DTSTART;TZID=Africa\/Cairo:20260920T090000/);
  assert.match(ics, /RRULE:FREQ=WEEKLY;BYDAY=SU;UNTIL=20261224T235959Z/);
  assert.match(ics, /END:VCALENDAR/);
});
