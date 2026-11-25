// The probe guard has to do two things: refuse a public peer, and leave every
// other route exactly as it was. The first part is tested against the matcher
// directly, because a test cannot easily connect from a public address; the
// second is tested over HTTP with a guard that only allows a range this machine
// is not in.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createApp } from '../src/app.js';
import { createProbeGuard } from '../src/http/probe-guard.js';
import { noRateLimit } from './no-rate-limit.js';

async function withServer(app, fn) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(base);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('private peers are allowed and public peers are not', () => {
  const { isAllowed } = createProbeGuard();

  for (const peer of ['10.20.0.5', '172.17.0.2', '192.168.1.5', '127.0.0.1', '::1', '::ffff:10.20.0.5', 'fd00::1']) {
    assert.equal(isAllowed(peer), true, `${peer} should be allowed`);
  }

  for (const peer of ['8.8.8.8', '203.0.113.9', '1.1.1.1', '2001:4860:4860::8888', '', null]) {
    assert.equal(isAllowed(peer), false, `${peer} should be refused`);
  }
});

test('the prefix length is respected, not just the first byte', () => {
  const { isAllowed } = createProbeGuard({ cidrs: ['10.20.0.0/16'] });

  assert.equal(isAllowed('10.20.0.5'), true);
  assert.equal(isAllowed('10.20.255.254'), true);
  assert.equal(isAllowed('10.21.0.5'), false, 'a neighbouring /16 must not match');
});

test('a range with a /0 prefix would match everything, and is parsed rather than ignored', () => {
  const { isAllowed } = createProbeGuard({ cidrs: ['0.0.0.0/0'] });
  assert.equal(isAllowed('203.0.113.9'), true);
});

test('malformed configuration fails at construction, not on the first request', () => {
  assert.throws(() => createProbeGuard({ cidrs: ['not-an-address'] }), /not a CIDR/);
  assert.throws(() => createProbeGuard({ cidrs: ['10.0.0.0/99'] }), /out-of-range/);
});

test('a refused probe answers the same 404 envelope as an unknown path', async () => {
  // 127.0.0.1 is not in this range, so every probe from this machine is refused.
  const guard = createProbeGuard({ cidrs: ['10.99.0.0/16'] });
  const app = createApp({ rateLimit: noRateLimit, probeGuard: guard });

  await withServer(app, async (base) => {
    for (const path of ['/healthz', '/readyz']) {
      const response = await fetch(`${base}${path}`);
      assert.equal(response.status, 404, `${path} should be hidden`);
      const body = await response.json();
      assert.equal(body.error.code, 'NOT_FOUND');
      assert.equal(body.error.message, 'No such endpoint.');
    }
  });
});

test('the guard only sees probe paths', async () => {
  const seen = [];
  const spy = { guard: (req, _res, next) => (seen.push(req.path), next()) };
  const app = createApp({ rateLimit: noRateLimit, probeGuard: spy });

  await withServer(app, async (base) => {
    await fetch(`${base}/api/courses`);
    await fetch(`${base}/courses.html`);
    assert.deepEqual(seen, [], 'no ordinary request reached the guard');

    await fetch(`${base}/healthz`);
    await fetch(`${base}/readyz`);
    assert.deepEqual(seen, ['/healthz', '/readyz']);
  });
});

test('a private caller still gets the probes', async () => {
  const app = createApp({ rateLimit: noRateLimit });

  await withServer(app, async (base) => {
    const live = await fetch(`${base}/healthz`);
    assert.equal(live.status, 200);
    assert.deepEqual(await live.json(), { status: 'ok' });
  });
});
