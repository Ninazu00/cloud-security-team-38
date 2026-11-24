const DAY_INDEX = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const ICAL_DAY = { sun: "SU", mon: "MO", tue: "TU", wed: "WE", thu: "TH", fri: "FR", sat: "SA" };

function escapeIcsText(str = "") {
  return String(str)
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

function firstOccurrenceDate(termStartDate, targetDay) {
  const [y, m, d] = termStartDate.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const diff = (DAY_INDEX[targetDay] - date.getUTCDay() + 7) % 7;
  date.setUTCDate(date.getUTCDate() + diff);

  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  return `${yyyy}${mm}${dd}`;
}

function formatHHMM(hhmm) {
  return hhmm.replace(":", "") + "00";
}

export function buildIcs(timetable, { termStartDate, termEndDate, timezone = "Africa/Cairo" }) {
  const until = `${termEndDate.replace(/-/g, "")}T235959Z`;
  const dtstamp = new Date().toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Class Timetable Builder//Timetable Service//EN",
    "CALSCALE:GREGORIAN",
    `X-WR-CALNAME:${escapeIcsText(timetable.name || "My Timetable")}`,
    `X-WR-TIMEZONE:${timezone}`,
  ];

  for (const sec of timetable.sections || []) {
    for (let i = 0; i < (sec.times || []).length; i++) {
      const slot = sec.times[i];
      const ymd = firstOccurrenceDate(termStartDate, slot.day);
      const uid = `${timetable.id}-${sec.id}-${i}@class-timetable-builder`;
      const summary = `${sec.courseCode} (${sec.type} ${sec.sectionCode}) - ${sec.courseTitle}`;

      lines.push(
        "BEGIN:VEVENT",
        `UID:${uid}`,
        `DTSTAMP:${dtstamp}`,
        `DTSTART;TZID=${timezone}:${ymd}T${formatHHMM(slot.start)}`,
        `DTEND;TZID=${timezone}:${ymd}T${formatHHMM(slot.end)}`,
        `RRULE:FREQ=WEEKLY;BYDAY=${ICAL_DAY[slot.day]};UNTIL=${until}`,
        `SUMMARY:${escapeIcsText(summary)}`,
        `LOCATION:${escapeIcsText(slot.room || "TBA")}`,
        "END:VEVENT"
      );
    }
  }

  lines.push("END:VCALENDAR", "");
  return lines.join("\r\n");
}
