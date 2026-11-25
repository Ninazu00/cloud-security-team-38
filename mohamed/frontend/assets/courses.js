/**
 * The course list.
 *
 * Reads are open to any signed-in account; the mutating controls are drawn only
 * for admins, which is presentation, not protection - the API answers 403 to a
 * student who calls the same routes by hand.
 *
 * Paging is the cursor the server hands back. It is opaque on purpose: a page
 * number would break the moment another admin inserts a course between two
 * requests, and the contract chose keyset paging for exactly that reason.
 */

import { api, ApiError } from './api.js';
import { boot, isAdmin } from './session.js';
import { h, fill, showAlert, hideAlert } from './dom.js';

const rows = document.querySelector('[data-rows]');
const empty = document.querySelector('[data-empty]');
const count = document.querySelector('[data-count]');
const alertBox = document.querySelector('[data-alert]');
const moreButton = document.querySelector('[data-more]');
const search = document.querySelector('#q');
const archived = document.querySelector('#archived');
const newButton = document.querySelector('[data-new]');

const dialog = document.querySelector('[data-dialog]');
const dialogTitle = document.querySelector('[data-dialog-title]');
const dialogAlert = document.querySelector('[data-dialog-alert]');
const courseForm = document.querySelector('[data-form]');

let items = [];
let nextCursor = null;
let editing = null; // the course being edited, or null when creating
let loading = false;

function statusBadge(course) {
  return course.archivedAt
    ? h('span', { class: 'badge archived' }, 'archived')
    : h('span', { class: 'badge live' }, 'live');
}

function actionButtons(course) {
  // Students get no cell at all, not an empty one: an always-present sixth
  // column shifts the table and leaves a blank gutter on the right.
  if (!isAdmin()) return null;

  const edit = h('button', { class: 'btn secondary small', type: 'button', onclick: () => openEdit(course) }, 'Edit');

  const toggle = course.archivedAt
    ? h(
        'button',
        {
          class: 'btn secondary small',
          type: 'button',
          onclick: () => void restore(course),
        },
        'Restore',
      )
    : h('button', { class: 'btn secondary small', type: 'button', onclick: () => void archive(course) }, 'Archive');

  return h('td', { class: 'actions' }, edit, toggle);
}

function courseRow(course) {
  const cells = [
    h('td', {}, h('a', { href: `sections.html?courseId=${course.id}` }, course.code)),
    h('td', {}, course.title),
    h('td', {}, String(course.credits)),
    h('td', {}, String(course.sectionCount)),
    h('td', {}, statusBadge(course)),
    actionButtons(course),
  ];

  return h('tr', {}, ...cells.filter(Boolean));
}

function render() {
  fill(rows, ...items.map(courseRow));
  empty.hidden = items.length > 0;

  const shown = items.length;
  count.textContent = shown === 0 ? 'No courses' : `${shown} course${shown === 1 ? '' : 's'} shown`;
  moreButton.hidden = !nextCursor;
}

async function load({ append = false } = {}) {
  if (loading) return;
  loading = true;

  try {
    const page = await api.listCourses({
      q: search.value.trim() || undefined,
      includeArchived: isAdmin() && archived.value === 'true' ? 'true' : undefined,
      limit: 25,
      cursor: append ? nextCursor : undefined,
    });

    items = append ? [...items, ...page.items] : page.items;
    nextCursor = page.nextCursor ?? null;
    hideAlert(alertBox);
    render();
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      location.replace('index.html');
      return;
    }
    showAlert(alertBox, 'error', error.message ?? 'Could not load courses.');
  } finally {
    loading = false;
  }
}

function openCreate() {
  editing = null;
  dialogTitle.textContent = 'New course';
  courseForm.code.value = '';
  courseForm.title.value = '';
  courseForm.credits.value = '3';
  courseForm.code.disabled = false;
  hideAlert(dialogAlert);
  dialog.showModal();
  courseForm.code.focus();
}

function openEdit(course) {
  editing = course;
  dialogTitle.textContent = `Edit ${course.code}`;
  courseForm.code.value = course.code;
  courseForm.title.value = course.title;
  courseForm.credits.value = String(course.credits);

  // The code is unique among live courses, so moving it is only safe while no
  // live section points at this course. The server enforces this; disabling the
  // field explains why before the request is even sent.
  const codeLocked = course.sectionCount > 0;
  courseForm.code.disabled = codeLocked;
  courseForm.code.title = codeLocked ? 'Archive its sections before changing the code.' : '';

  hideAlert(dialogAlert);
  dialog.showModal();
  courseForm.title.focus();
}

async function save(event) {
  event.preventDefault();
  hideAlert(dialogAlert);

  const body = {
    title: courseForm.title.value.trim(),
    credits: Number(courseForm.credits.value),
  };
  if (!courseForm.code.disabled) body.code = courseForm.code.value.trim();

  if (!body.title) {
    showAlert(dialogAlert, 'error', 'A title is required.');
    return;
  }
  if (!Number.isInteger(body.credits) || body.credits < 0 || body.credits > 30) {
    showAlert(dialogAlert, 'error', 'Credits must be a whole number from 0 to 30.');
    return;
  }

  const saveButton = document.querySelector('[data-save]');
  saveButton.disabled = true;

  try {
    if (editing) await api.updateCourse(editing.id, body);
    else await api.createCourse({ ...body, code: courseForm.code.value.trim() });

    dialog.close();
    await load();
  } catch (error) {
    showAlert(dialogAlert, 'error', error.message ?? 'Could not save the course.');
  } finally {
    saveButton.disabled = false;
  }
}

async function archive(course) {
  if (!window.confirm(`Archive ${course.code} and its live sections?`)) return;

  try {
    await api.archiveCourse(course.id);
    await load();
  } catch (error) {
    showAlert(alertBox, 'error', error.message ?? 'Could not archive the course.');
  }
}

async function restore(course) {
  try {
    await api.updateCourse(course.id, { archived: false });
    await load();
  } catch (error) {
    showAlert(alertBox, 'error', error.message ?? 'Could not restore the course.');
  }
}

// --- wiring ---------------------------------------------------------------

courseForm.addEventListener('submit', save);
document.querySelector('[data-cancel]').addEventListener('click', () => dialog.close());
newButton.addEventListener('click', openCreate);
moreButton.addEventListener('click', () => void load({ append: true }));
document.querySelector('[data-refresh]').addEventListener('click', () => void load());

let typing = null;
search.addEventListener('input', () => {
  clearTimeout(typing);
  typing = setTimeout(() => void load(), 250);
});

archived.addEventListener('change', () => void load());
archived.closest('[data-archived-field]').hidden = !isAdmin();
newButton.hidden = !isAdmin();
// The actions column exists only for admins; hiding its header keeps the five
// visible columns aligned with their cells.
document.querySelector('[data-actions-head]')?.toggleAttribute('hidden', !isAdmin());

const user = await boot({ active: 'courses' });
if (user) {
  if (!isAdmin()) newButton.hidden = true;
  await load();
}
