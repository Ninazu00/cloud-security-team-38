export function toMinutes(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

export function timesClash(slotA, slotB) {
  if (slotA.day !== slotB.day) return false;
  const startA = toMinutes(slotA.start);
  const endA = toMinutes(slotA.end);
  const startB = toMinutes(slotB.start);
  const endB = toMinutes(slotB.end);
  return startA < endB && startB < endA;
}

export function sectionsClash(secA, secB) {
  for (const tA of secA.times || []) {
    for (const tB of secB.times || []) {
      if (timesClash(tA, tB)) {
        return { day: tA.day, slotA: tA, slotB: tB };
      }
    }
  }
  return null;
}

export function findClashes(sections) {
  const clashes = [];
  for (let i = 0; i < sections.length; i++) {
    for (let j = i + 1; j < sections.length; j++) {
      const overlap = sectionsClash(sections[i], sections[j]);
      if (overlap) {
        clashes.push({
          sectionAId: String(sections[i].id),
          sectionBId: String(sections[j].id),
          courseA: sections[i].courseCode,
          courseB: sections[j].courseCode,
          day: overlap.day,
          timeA: `${overlap.slotA.start}-${overlap.slotA.end}`,
          timeB: `${overlap.slotB.start}-${overlap.slotB.end}`,
        });
      }
    }
  }
  return clashes;
}
