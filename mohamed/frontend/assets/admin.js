import { api, ApiError } from './api.js';
import { boot, currentUser } from './session.js';
import { fill, fmtDate, h, hideAlert, showAlert } from './dom.js';

/**
 * The accounts screen.
 *
 * Two things worth knowing while reading this:
 *
 * 1. The role control sends a PATCH and then re-renders from the server's answer.
 *    It never assumes the write worked, and it never hides the row on success -
 *    what you see afterwards is what the database says.
 * 2. The button is disabled for your own account. That is a courtesy: the API
 *    refuses a self role change with 403 whatever the browser sends.
 */

const tbody = document.querySelector('[data-rows]');
const empty = document.querySelector('[data-empty]');
const count = document.querySelector('[data-count]');
const alertBox = document.querySelector('[data-alert]');
const more = document.querySelector('[data-more]');
const search = document.querySelector('#q');
const roleFilter = document.querySelector('#role');

let items = [];
let nextCursor = null;
let loading = false;

function rowFor(user) {
  const isSelf = user.id === currentUser()?.id;

  const role = h('span', { class: `badge ${user.role === 'admin' ? 'admin' : 'student'}` }, user.role);

  const picker = h(
    'select',
    {
      'aria-label': `Set role for ${user.email}`,
      disabled: isSelf,
      title: isSelf ? 'You cannot change your own role.' : '',
    },
    h('option', { value: 'student', selected: user.role === 'student' }, 'student'),
    h('option', { value: 'admin', selected: user.role === 'admin' }, 'admin'),
  );

  picker.addEventListener('change', async () => {
    picker.disabled = true;
    try {
      const updated = await api.setUserRole(user.id, picker.value);
      const index = items.findIndex((item) => item.id === user.id);
      if (index !== -1) items[index] = { ...items[index], role: updated.role };
      fill(tbody, ...items.map(rowFor));
      showAlert(alertBox, 'ok', `${user.email} is now ${updated.role}.`);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        location.replace('index.html');
        return;
      }
      picker.value = user.role;
      picker.disabled = false;
      showAlert(alertBox, 'error', explain(error));
    }
  });

  const verified = user.emailVerifiedAt
    ? h('span', { class: 'badge live' }, 'yes')
    : h('span', { class: 'badge' }, 'no');

  return h(
    'tr',
    {},
    h('td', {}, user.email),
    h('td', {}, role),
    h('td', {}, verified),
    h('td', { class: 'muted' }, fmtDate(user.createdAt)),
    h('td', {}, picker),
  );
}

function explain(error) {
  if (!(error instanceof ApiError)) return 'Something went wrong. Try again.';
  if (error.code === 'SELF_ROLE_CHANGE') return 'You cannot change your own role.';
  if (error.code === 'LAST_ADMIN') return 'This is the last admin, so the change was refused.';
  if (error.code === 'USER_NOT_FOUND') return 'That account no longer exists.';
  if (error.code === 'FORBIDDEN') return 'Only an admin can change roles.';
  if (error.code === 'VALIDATION_FAILED') return error.details?.field ? `Check the ${error.details.field}.` : 'Check the filter.';
  return error.message;
}

async function load({ append = false } = {}) {
  if (loading) return;
  loading = true;
  more.disabled = true;

  try {
    const page = await api.listUsers({
      q: search.value.trim() || undefined,
      role: roleFilter.value || undefined,
      limit: 25,
      cursor: append && nextCursor ? nextCursor : undefined,
    });

    items = append ? [...items, ...page.items] : page.items;
    nextCursor = page.nextCursor ?? null;

    fill(tbody, ...items.map(rowFor));
    empty.hidden = items.length > 0;
    more.hidden = nextCursor === null;
    count.textContent = `${items.length} account${items.length === 1 ? '' : 's'} shown`;
    hideAlert(alertBox);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      location.replace('index.html');
      return;
    }
    if (error instanceof ApiError && error.status === 403) {
      location.replace('courses.html');
      return;
    }
    showAlert(alertBox, 'error', explain(error));
  } finally {
    loading = false;
    more.disabled = false;
  }
}

let debounce = null;
search.addEventListener('input', () => {
  clearTimeout(debounce);
  debounce = setTimeout(() => load(), 250);
});

roleFilter.addEventListener('change', () => load());
document.querySelector('[data-refresh]').addEventListener('click', () => load());
more.addEventListener('click', () => load({ append: true }));

boot({ active: 'admin', admin: true })
  .then((user) => (user ? load() : undefined))
  .catch(() => {
    location.replace('index.html');
  });
