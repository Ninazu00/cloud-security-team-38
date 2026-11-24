// Transport-level tests: no database fixture, no fixtures at all. They start the
// real app on an ephemeral port and talk to it over HTTP, so what is tested is
// what a client would see.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';

async function withServer(fn) {
  const app = createApp();
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('GET /healthz answers 200 without a database', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/healthz`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: 'ok' });
  });
});

// The counterpart to the test above: readiness *is* allowed to depend on the
// database, so it can only be asserted where one is reachable. The local compose
// stack provides it; a machine without Postgres skips instead of failing.
test(
  'GET /readyz reports ready when the database answers',
  { skip: process.env.DATABASE_URL ? false : 'needs DATABASE_URL (local stack on :5433)' },
  async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/readyz`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.status, 'ready');
      assert.equal(body.db, 'ok');
      assert.equal(typeof body.ms, 'number');
    });
  },
);

test('every response carries a request id header', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/healthz`);
    assert.match(res.headers.get('x-request-id'), /^[0-9a-f-]{36}$/);
  });
});

test('an inbound request id is echoed back when it is sane', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/healthz`, { headers: { 'x-request-id': 'test-abc-123' } });
    assert.equal(res.headers.get('x-request-id'), 'test-abc-123');
  });
});

test('an unsane inbound request id is replaced, not echoed', async () => {
  await withServer(async (base) => {
    // Newlines cannot travel in a header at all, so the realistic attack is a
    // value that is legal in HTTP but not legal in our logs: spaces, or a
    // one-character id that says nothing and correlates with everything.
    for (const hostile of ['has space inside', 'x', '']) {
      const res = await fetch(`${base}/healthz`, { headers: { 'x-request-id': hostile } });
      assert.match(res.headers.get('x-request-id'), /^[0-9a-f-]{36}$/);
    }
  });
});

test('unknown api route returns the error envelope, not html', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/does-not-exist`);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.error.code, 'NOT_FOUND');
    assert.ok(body.error.requestId);
    assert.equal(res.headers.get('content-type').includes('application/json'), true);
  });
});

test('malformed json is a 400 with a stable code', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/courses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"broken": ',
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, 'MALFORMED_JSON');
  });
});

test('a body over 100 KB is refused with 413', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/courses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ padding: 'x'.repeat(120 * 1024) }),
    });
    assert.equal(res.status, 413);
    assert.equal((await res.json()).error.code, 'PAYLOAD_TOO_LARGE');
  });
});
