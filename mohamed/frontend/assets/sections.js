/**
 * The sections of one course.
 *
 * Every block is `[start, end)` on one day. The server rejects a block whose end
 * is not after its start, a block that clashes with another block of the same
 * section, and a block that double-books a room - the last one is what
 * `ROOM_CONFLICT` reports, and it is the rule that actually belongs to this
 * service rather than to the timetable student.
 */

import { api, ApiError } from './api.js';
import { boot, isAdmin } from './session.js';
import { h, fill, showAlert, hideAlert, DAYS, TYPES, timeRange, sortTimes } from './dom.js';

const params = new URLSearchParams(location.search);
const courseId = params.get('courseId');

const title = document.querySelector('[data-course-title]');
const meta = document.querySelector('[data-course-meta]');
const rows = document.querySelector('[data-rows]');
const empty = document.querySelector('[data-empty]');
const alertBox = document.querySelector('[data-alert]');
const newButton = document.querySelector('[data-new]');

const dialog = document.querySelector('[data-dialog]');
const dialogTitle = document.querySelector('[data-dialog-title]');
const dialogAlert = document.querySelector('[data-dialog-alert]');
const sectionForm = document.querySelector('[data-form]');
const blocksBox = document.querySelector('[data-blocks]');

let course = null;
let items = [];
let editing = null;

/* --- the block rows ------------------------------------------------------ */

function blockRow(block = { dayOfWeek: 1, startTime: '09:00', endTime: '10:00' }) {
  const day = h(
    'select',
    { class: 'block-day' },
    ...DAYS.map((label, value) =>
      h('option', { value: String(value), selected: value === block.dayOfWeek }, label),
    ),
  );

  const start = h('input', { type: 'time', value: block.startTime, required: true });
  const end = h('input', { type: 'time', value: block.endTime, required: true });

  const row = h(
    'div',
    { class: 'block-row' },
    day,
    start,
    h('span', { class: 'muted' }, 'to'),
    end,
    h('button', { class: 'btn secondary small', type: 'button', onclick: () => removeBlock(row) }, 'Remove'),
  );

  row.dataset.block = '';
  return row;
}

function addBlock(block) {
  const existing = blocksBox.querySelectorAll('[data-block]').length;
  if (existing >= 5) {
    showAlert(dialogAlert, 'error', 'A section can have at most five time blocks.');
    return;
  }
  blocksBox.append(blockRow(block));
}

function removeBlock(row) {
  if (blocksBox.querySelectorAll('[data-block]').length === 1) {
    showAlert(dialogAlert, 'error', 'A section needs at least one time block.');
    return;
  }
  row.remove();
}

function readBlocks() {
  return [...blocksBox.querySelectorAll('[data-block]')].map((row) => ({
    dayOfWeek: Number(row.querySelector('.block-day').value),
    startTime: row.querySelector('input[type="time"]').value,
    endTime: row.querySelectorAll('input[type="time"]')[1].value,
  }));
}

/* --- the table ----------------------------------------------------------- */

function timeCell(section) {
  const chips = sortTimes(section.times).map((block) =>
    h('span', { class: 'time-chip' }, timeRange(block)),
  );
  return h('td', {}, ...chips);
}

function statusBadge(section) {
  return section.archivedAt
    ? h('span', { class: 'badge archived' }, 'archived')
    : h('span', { class: 'badge live' }, 'live');
}

function actionButtons(section) {
  // No cell at all for students: an always-present seventh column leaves a
  // blank gutter and misaligns every other column with the header.
  if (!isAdmin()) return null;

  const edit = h('button', { class: 'btn secondary small', type: 'button', onclick: () => openEdit(section) }, 'Edit');
  const toggle = section.archivedAt
    ? h('button', { class: 'btn secondary small', type: 'button', onclick: () => void restore(section) }, 'Restore')
    : h('button', { class: 'btn secondary small', type: 'button', onclick: () => void archive(section) }, 'Archive');

  return h('td', { class: 'actions' }, edit, toggle);
}

function render() {
  fill(
    rows,
    ...items.map((section) => {
      const cells = [
        h('td', {}, section.sectionCode),
        h('td', {}, section.type),
        h('td', {}, section.room),
        h('td', {}, String(section.capacity)),
        timeCell(section),
        h('td', {}, statusBadge(section)),
        actionButtons(section),
      ];
      return h('tr', {}, ...cells.filter(Boolean));
    }),
  );
  empty.hidden = items.length > 0;

  // `archivedAt` is null for a live course - `??` would treat that null as
  // "unknown" and hide the button, so the check is an explicit truthiness test.
  newButton.hidden = !isAdmin() || Boolean(course?.archivedAt);
}

async function load() {
  try {
    const [fresh, page] = await Promise.all([
      api.listCourses({ limit: 100 }),
      api.listSections({ courseId, includeArchived: isAdmin() ? 'true' : undefined, limit: 100 }),
    ]);

    course = fresh.items.find((candidate) => candidate.id === courseId) ?? null;
    items = page.items;

    title.textContent = course ? `${course.code} - ${course.title}` : 'Section list';
    meta.textContent = course
      ? `${course.credits} credits · ${course.sectionCount} live section(s)${course.archivedAt ? ' · archived' : ''}`
      : 'This course is not in the current page of results.';

    hideAlert(alertBox);
    render();
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      location.replace('index.html');
      return;
    }
    showAlert(alertBox, 'error', error.message ?? 'Could not load sections.');
  }
}

/* --- the dialog ---------------------------------------------------------- */

function openCreate() {
  editing = null;
  dialogTitle.textContent = 'New section';
  sectionForm.sectionCode.value = '';
  sectionForm.type.value = 'lecture';
  sectionForm.room.value = '';
  sectionForm.capacity.value = '30';
  fill(blocksBox);
  addBlock();
  hideAlert(dialogAlert);
  dialog.showModal();
  sectionForm.sectionCode.focus();
}

function openEdit(section) {
  editing = section;
  dialogTitle.textContent = `Edit ${section.sectionCode}`;
  sectionForm.sectionCode.value = section.sectionCode;
  sectionForm.type.value = section.type;
  sectionForm.room.value = section.room;
  sectionForm.capacity.value = String(section.capacity);
  fill(blocksBox);
  for (const block of sortTimes(section.times)) addBlock(block);
  hideAlert(dialogAlert);
  dialog.showModal();
  sectionForm.room.focus();
}

async function save(event) {
  event.preventDefault();
  hideAlert(dialogAlert);

  const body = {
    sectionCode: sectionForm.sectionCode.value.trim(),
    type: sectionForm.type.value,
    room: sectionForm.room.value.trim(),
    capacity: Number(sectionForm.capacity.value),
    times: readBlocks(),
  };

  const saveButton = document.querySelector('[data-save]');
  saveButton.disabled = true;

  try {
    if (editing) await api.updateSection(editing.id, body);
    else await api.createSection({ courseId, ...body });

    dialog.close();
    await load();
  } catch (error) {
    // A room clash is the interesting failure: the server names the section that
    // holds the room, so the message can say what to do next.
    const detail = error.details?.conflict;
    showAlert(dialogAlert, 'error', detail ? `${error.message}` : (error.message ?? 'Could not save.'));
  } finally {
    saveButton.disabled = false;
  }
}

async function archive(section) {
  if (!window.confirm(`Archive section ${section.sectionCode}?`)) return;
  try {
    await api.archiveSection(section.id);
    await load();
  } catch (error) {
    showAlert(alertBox, 'error', error.message ?? 'Could not archive the section.');
  }
}

async function restore(section) {
  try {
    await api.updateSection(section.id, { archived: false });
    await load();
  } catch (error) {
    showAlert(alertBox, 'error', error.message ?? 'Could not restore the section.');
  }
}

/* --- wiring -------------------------------------------------------------- */

sectionForm.addEventListener('submit', save);
document.querySelector('[data-cancel]').addEventListener('click', () => dialog.close());
document.querySelector('[data-add-block]').addEventListener('click', () => addBlock());
newButton.addEventListener('click', openCreate);

if (!courseId) {
  title.textContent = 'Pick a course';
  meta.textContent = 'Sections are listed per course. Open a course first.';
  newButton.hidden = true;
} else {
  const user = await boot({ active: 'courses' });
  if (user) {
    if (!isAdmin()) newButton.hidden = true;
    document.querySelector('[data-actions-head]')?.toggleAttribute('hidden', !isAdmin());
    await load();
  }
}
