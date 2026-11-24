import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createApp } from '../src/app.js';
import { createRateLimit } from '../src/http/rate-limit.js';

/**
 * The limiter has its own suite because every other HTTP suite turns it off.
 *
 * Two requests per 150 ms, probes exempt (the load balancer asks every 15 s and a
 * 429 on a probe would take the task out of rotation for being healthy), and the
 * window is short enough that "it recovers" can be observed in a test rather than
 * argued about.
 */

const WINDOW_MS = 150;
const MAX = 2;

async function withServer(fn) {
  const app = createApp({
    rateLimit: createRateLimit({
      windowMs: WINDOW_MS,
      max: MAX,
      skip: (req) => req.path === '/healthz' || req.path === '/readyz',
    }),
  });

  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    await fn(base);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('the third request inside the window is refused with 429 and a retry hint', async () => {
  await withServer(async (base) => {
    const first = await fetch(`${base}/api/nothing`);
    const second = await fetch(`${base}/api/nothing`);
    const third = await fetch(`${base}/api/nothing`);

    assert.equal(first.status, 404);
    assert.equal(second.status, 404);
    assert.equal(third.status, 429);

    const body = await third.json();
    assert.equal(body.error.code, 'RATE_LIMITED');
    assert.equal(body.error.details.scope, 'rate_limit');
    assert.equal(body.error.details.limit, MAX);
    assert.ok(body.error.details.retryAfterSeconds >= 1);
    assert.ok(body.error.requestId, 'the refusal is traceable like every other error');

    assert.equal(third.headers.get('retry-after'), String(body.error.details.retryAfterSeconds));
    assert.equal(third.headers.get('ratelimit-limit'), String(MAX));
    assert.equal(third.headers.get('ratelimit-remaining'), '0');
  });
});

test('the remaining count falls before the limit is reached', async () => {
  await withServer(async (base) => {
    const first = await fetch(`${base}/api/nothing`);
    assert.equal(first.headers.get('ratelimit-remaining'), '1');

    const second = await fetch(`${base}/api/nothing`);
    assert.equal(second.headers.get('ratelimit-remaining'), '0');
  });
});

test('a client is allowed again once the window has passed', async () => {
  await withServer(async (base) => {
    await fetch(`${base}/api/nothing`);
    await fetch(`${base}/api/nothing`);
    assert.equal((await fetch(`${base}/api/nothing`)).status, 429);

    await new Promise((resolve) => setTimeout(resolve, WINDOW_MS + 50));

    assert.equal((await fetch(`${base}/api/nothing`)).status, 404);
  });
});

test('two clients are counted separately', async () => {
  await withServer(async (base) => {
    const one = { headers: { 'x-forwarded-for': '203.0.113.7' } };
    const two = { headers: { 'x-forwarded-for': '198.51.100.9' } };

    assert.equal((await fetch(`${base}/api/nothing`, one)).status, 404);
    assert.equal((await fetch(`${base}/api/nothing`, one)).status, 404);
    assert.equal((await fetch(`${base}/api/nothing`, one)).status, 429);

    // A different client, same instant: its own budget, not the first one's.
    assert.equal((await fetch(`${base}/api/nothing`, two)).status, 404);
  });
});

test('health probes are never limited', async () => {
  await withServer(async (base) => {
    for (let i = 0; i < 6; i += 1) {
      const response = await fetch(`${base}/healthz`);
      assert.equal(response.status, 200, `probe ${i + 1} must not be throttled`);
    }
  });
});

test('a limiter can be pointed at a different window without touching the app', async () => {
  const limiter = createRateLimit({ windowMs: 1000, max: 1, now: () => 1_000 });

  const calls = [];
  const res = {
    setHeader: (name, value) => calls.push([name, value]),
    status(code) {
      calls.push(['status', code]);
      return this;
    },
    json(body) {
      calls.push(['body', body]);
      return this;
    },
  };

  let passed = 0;
  const next = () => {
    passed += 1;
  };

  limiter({ ip: '10.0.0.1', path: '/api/x', id: 'req-1' }, res, next);
  limiter({ ip: '10.0.0.1', path: '/api/x', id: 'req-2' }, res, next);

  assert.equal(passed, 1, 'only the first request reached the handler');
  assert.ok(calls.some(([name, value]) => name === 'status' && value === 429));
});
