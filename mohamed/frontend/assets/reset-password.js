/**
 * Password reset, both halves.
 *
 * One page, two states, because the user arrives from two directions: with a token
 * from the email (choose a new password), or without one (ask for the email). The
 * token is read from the query string, used once, and then stripped from the
 * address bar so it cannot be copied out of history or a shared screenshot.
 *
 * Nothing here can tell you whether an address has an account: the request form
 * shows the same sentence either way, which is the server's behaviour mirrored in
 * the UI.
 */

import { api } from './api.js';
import { h, fill, showAlert, hideAlert } from './dom.js';

const SITE_KEY = '1x00000000000000000000AA'; // Cloudflare's "always passes" test key.

const requestSection = document.querySelector('[data-request]');
const confirmSection = document.querySelector('[data-confirm]');

const requestForm = document.querySelector('[data-request-form]');
const emailInput = document.querySelector('#email');
const turnstileHost = document.querySelector('[data-turnstile]');
const requestSubmit = document.querySelector('[data-submit]');
const alertBox = document.querySelector('[data-alert]');
const noteBox = document.querySelector('[data-note]');

const confirmForm = document.querySelector('[data-confirm-form]');
const passwordInput = document.querySelector('#newPassword');
const confirmSubmit = document.querySelector('[data-confirm-submit]');
const confirmAlert = document.querySelector('[data-confirm-alert]');
const confirmNote = document.querySelector('[data-confirm-note]');

let turnstileToken = '';
let widgetId = null;

/**
 * The token has to be read *now* and kept in a variable: the address bar is
 * cleaned a few lines below, so anything that reads `location.search` later gets
 * an empty string. That mistake is invisible until someone actually submits, and
 * it looks like a server bug when it happens.
 */
const resetToken = new URLSearchParams(location.search).get('token') ?? '';

function mountTurnstile() {
  if (!window.turnstile) return false;

  widgetId = window.turnstile.render(turnstileHost, {
    sitekey: SITE_KEY,
    callback: (token) => {
      turnstileToken = token;
    },
    'expired-callback': () => {
      turnstileToken = '';
    },
    'error-callback': () => {
      turnstileToken = '';
    },
  });

  return true;
}

function explain(error) {
  const { code, details, message } = error;

  if (code === 'INVALID_TOKEN') return 'That link is no longer valid. Ask for a new one.';
  if (code === 'TURNSTILE_FAILED') return 'The verification check failed. Reload the page and try again.';
  if (code === 'RATE_LIMITED') return 'Too many requests. Give it an hour before asking again.';
  if (code === 'VALIDATION_FAILED') {
    return details?.field ? `${message} (${details.field})` : message;
  }
  return message ?? 'Something went wrong.';
}

requestForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  hideAlert(alertBox);
  hideAlert(noteBox);

  const email = emailInput.value.trim();
  if (!email) {
    showAlert(alertBox, 'error', 'Enter the address on your account.');
    return;
  }

  if (!turnstileToken) {
    showAlert(alertBox, 'error', 'Complete the verification check first.');
    return;
  }

  requestSubmit.disabled = true;
  requestSubmit.textContent = 'Sending…';

  try {
    await api.requestPasswordReset(email, turnstileToken);
    // Same sentence for a known and an unknown address, because the server cannot
    // tell the difference from the outside either.
    noteBox.className = 'alert ok';
    noteBox.hidden = false;
    fill(noteBox, 'If that address has an account, a link is on its way. It expires in 30 minutes.');
    emailInput.value = '';
  } catch (error) {
    showAlert(alertBox, 'error', explain(error));
    if (widgetId !== null && window.turnstile) window.turnstile.reset(widgetId);
    turnstileToken = '';
  } finally {
    requestSubmit.disabled = false;
    requestSubmit.textContent = 'Send the link';
  }
});

confirmForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  hideAlert(confirmAlert);
  hideAlert(confirmNote);

  const newPassword = passwordInput.value;

  if (!newPassword) {
    showAlert(confirmAlert, 'error', 'Choose a new password.');
    return;
  }

  confirmSubmit.disabled = true;
  confirmSubmit.textContent = 'Saving…';

  try {
    await api.confirmPasswordReset(resetToken, newPassword);
    passwordInput.value = '';
    confirmNote.className = 'alert ok';
    confirmNote.hidden = false;
    fill(
      confirmNote,
      'Your password is changed and every other session was signed out. ',
      h('a', { href: 'index.html' }, 'Sign in'),
      '.',
    );
    confirmForm.hidden = true;
  } catch (error) {
    showAlert(confirmAlert, 'error', explain(error));
    confirmSubmit.disabled = false;
    confirmSubmit.textContent = 'Set the new password';
  }
});

const token = new URLSearchParams(location.search).get('token');

if (resetToken) {
  // Strip the token from the address bar immediately: it is already spent by the
  // time the form is submitted, and a token in history is a token in a screenshot.
  history.replaceState({}, '', 'reset-password.html');

  requestSection.hidden = true;
  confirmSection.hidden = false;
  passwordInput.focus();
} else {
  requestSection.hidden = false;
  confirmSection.hidden = true;

  const started = Date.now();
  const wait = setInterval(() => {
    if (mountTurnstile()) {
      clearInterval(wait);
    } else if (Date.now() - started > 8000) {
      clearInterval(wait);
      showAlert(alertBox, 'error', 'The verification widget could not load. Check your connection and reload.');
      requestSubmit.disabled = true;
    }
  }, 200);
}
