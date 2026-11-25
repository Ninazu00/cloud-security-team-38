/**
 * Session state and the shared shell.
 *
 * A page boots by calling `boot()`, which tries the refresh cookie, loads `/me`,
 * draws the top bar and - if the page asked for it - refuses to render for a
 * non-admin. The refusal here is **cosmetic**: every route checks the role on the
 * server. Hiding a button is not access control; the API is what decides.
 */

import { api, setAccessToken, refreshSession, ApiError } from './api.js';
import { h, fill } from './dom.js';

let user = null;

export function currentUser() {
  return user;
}

export function isAdmin() {
  return user?.role === 'admin';
}

/** Exchange the refresh cookie for an access token and load who we are. */
export async function restore() {
  const ok = await refreshSession();
  if (!ok) return null;

  try {
    user = await api.me();
    return user;
  } catch {
    setAccessToken(null);
    user = null;
    return null;
  }
}

export async function signIn(email, password, turnstileToken) {
  const payload = await api.login(email, password, turnstileToken);
  setAccessToken(payload.accessToken);
  user = payload.user;
  return user;
}

export async function signOut() {
  try {
    await api.logout();
  } catch {
    // The cookie may already be gone; the local state still has to be cleared.
  } finally {
    setAccessToken(null);
    user = null;
    location.replace('index.html');
  }
}

function mountTopbar(active) {
  const host = document.querySelector('[data-topbar]');
  if (!host) return;

  const links = [
    { href: 'courses.html', label: 'Courses', key: 'courses' },
    ...(isAdmin() ? [{ href: 'imports.html', label: 'Imports', key: 'imports' }] : []),
    ...(isAdmin() ? [{ href: 'admin.html', label: 'Accounts', key: 'admin' }] : []),
  ];

  fill(
    host,
    h(
      'div',
      { class: 'topbar' },

      h('a', { class: 'brand', href: 'courses.html' }, 'Class TT ', h('span', {}, '· Catalogue')),

      h(
        'nav',
        { 'aria-label': 'Main' },
        ...links.map((link) =>
          h('a', { href: link.href, ...(link.key === active ? { 'aria-current': 'page' } : {}) }, link.label),
        ),
      ),

      h(
        'div',
        { class: 'who' },
        h('span', { class: `badge ${user.role}` }, user.role),
        h('span', {}, user.email),
        h('button', { class: 'btn ghost small', type: 'button', onclick: () => void signOut() }, 'Sign out'),
      ),
    ),
  );
}

/** Full-page message for the one case a redirect would be rude: signed in, wrong role. */
function renderForbidden() {
  const main = document.querySelector('main');
  if (!main) return;
  fill(
    main,
    h(
      'div',
      { class: 'card' },
      h('h1', {}, 'Admins only'),
      h('p', { class: 'muted' }, 'This page manages the catalogue. Your account can browse courses instead.'),
      h('p', {}, h('a', { href: 'courses.html' }, 'Back to courses')),
    ),
  );
}

/**
 * Resolve the session, then either draw the page or redirect to sign-in.
 *
 * Returns the user, or null when the caller should stop.
 */
export async function boot({ active = '', admin = false } = {}) {
  const me = await restore();

  if (!me) {
    location.replace('index.html');
    return null;
  }

  mountTopbar(active);

  if (admin && me.role !== 'admin') {
    renderForbidden();
    return null;
  }

  return me;
}

/** Re-exported so pages do not import two modules to catch one error type. */
export { ApiError };
