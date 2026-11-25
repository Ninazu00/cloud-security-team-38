/**
 * The pages themselves are part of the delivery: the API is useless to a marker
 * who cannot open a browser and sign in.
 *
 * These tests cover the wiring that makes that true - the files are served, the
 * security headers are on every response, and the static mount did not swallow
 * the API's 404 envelope. They do not test the browser behaviour of
 * each page; that is what the manual walkthrough is for.
 */

import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { createApp } from '../src/app.js';
import { noRateLimit } from './no-rate-limit.js';

const staticDir = fileURLToPath(new URL('../frontend', import.meta.url));

async function withServer(run) {
  const app = createApp({ staticDir, rateLimit: noRateLimit });
  const server = app.listen(0);

  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();

  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('the catalogue frontend ships with the service', async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/`);
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/html/);
    assert.match(html, /Class TT/);
    // The sign-in page must load the login module; a rename that missed the page
    // would leave a form that does nothing.
    assert.match(html, /assets\/login\.js/);
  });
});

test('assets are served with the right type', async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/assets/styles.css`);

    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/css/);
    assert.match(await response.text(), /--accent/);
  });
});

test('every response carries the security headers', async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/`);
    const csp = response.headers.get('content-security-policy') ?? '';

    assert.match(csp, /default-src 'self'/);
    // The Turnstile widget and nothing else may come from another origin.
    assert.match(csp, /script-src 'self' https:\/\/challenges\.cloudflare\.com/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /object-src 'none'/);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
    // HSTS only in production, because the local stack speaks plain HTTP and a
    // browser that saw this header here would refuse the next plain request.
    assert.equal(response.headers.get('strict-transport-security'), null);
  });
});

test('the static mount does not shadow the API', async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/api/does-not-exist`);
    const body = await response.json();

    assert.equal(response.status, 404);
    assert.match(response.headers.get('content-type') ?? '', /application\/json/);
    assert.equal(body.error.code, 'NOT_FOUND');
  });
});

test('a missing page answers in the API envelope, not Express HTML', async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/no-such-page.html`);
    const body = await response.json();

    assert.equal(response.status, 404);
    assert.equal(body.error.code, 'NOT_FOUND');
    assert.ok(body.error.requestId);
  });
});

test('the static mount cannot escape its directory', async () => {
  await withServer(async (base) => {
    // `express.static` resolves and normalises the path before touching disk; the
    // assertion is that no traversal shape returns package.json's contents.
    for (const attempt of ['/../package.json', '/assets/../../package.json', '/%2e%2e/package.json']) {
      const response = await fetch(`${base}${attempt}`);
      const text = await response.text();

      assert.notEqual(response.status, 200);
      assert.equal(text.includes('"class-tt-catalogue"'), false, `${attempt} served the manifest`);
    }
  });
});
