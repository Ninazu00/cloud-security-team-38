/**
 * Finish a verification link.
 *
 * Three states, all three: verified, expired/bad link, or no token at
 * all (someone opened this page directly). The page never signs anyone in - it
 * confirms an address, and the user then uses the normal sign-in form.
 */

import { api } from './api.js';

const state = document.querySelector('[data-state]');
const errorBox = document.querySelector('[data-error]');
const okBox = document.querySelector('[data-ok]');
const next = document.querySelector('[data-next]');
const retry = document.querySelector('[data-retry]');

const token = new URLSearchParams(location.search).get('token');

function show(node, message) {
  node.textContent = message;
  node.hidden = false;
}

if (!token) {
  state.textContent = 'This page finishes a verification link.';
  show(errorBox, 'Open the link from your email instead of opening this page directly.');
  retry.hidden = false;
} else {
  try {
    await api.verifyEmail(token);

    // The address is only replaced so a reload does not resubmit a spent token.
    history.replaceState(null, '', 'verify-email.html');

    state.textContent = 'Your address is confirmed.';
    show(okBox, 'You can sign in now.');
    next.hidden = false;
  } catch (error) {
    state.textContent = 'This link did not work.';
    show(
      errorBox,
      error?.code === 'INVALID_TOKEN'
        ? 'The link has expired or was already used. Request a new one from the sign-in page.'
        : 'Something went wrong while confirming the address. Try again in a moment.',
    );
    retry.hidden = false;
  }
}
