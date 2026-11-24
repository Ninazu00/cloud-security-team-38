import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';

import pg from 'pg';

import { createApp } from '../src/app.js';
import { buildCatalogue } from '../src/catalogue/index.js';
import { createAuthMiddleware } from '../src/auth/middleware.js';
import { createTokenService } from '../src/auth/tokens.js';
import { createUsersModel } from '../src/models/users.model.js';

/**
 * The import route end to end.
 *
 * The contract's promises are unusual enough to be worth proving one by one:
 * all-or-nothing (a bad row leaves no partial course), `dryRun` writing nothing
 * at all, duplicates caught by the file's hash, a rejected import still leaving
 * a history row, and the report naming rows and fields without quoting anyone's
 * data.
 *
 * Skips itself when DATABASE_URL is absent, like the other database tests.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const skip = DATABASE_URL ? false : 'needs DATABASE_URL (local stack on :5433)';

const PASSWORD = 'correct horse battery';
// Its own prefix, because `node --test` runs files in parallel and the
// courses, sections and imports suites share one database: a cleanup that
// matched `TST%` would delete rows another file is still using.
const CODE_PREFIX = 'IMP';
const HEADER = 'course_code,course_title,credits,section_code,type,room,capacity,day_of_week,start_time,end_time';

let pool;
let withTransaction;
let users;
let tokens;
let server;
let baseUrl;
let adminToken;
let studentToken;

const createdEmails = [];

function ephemeralKeystore() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const publicJwk = publicKey.export({ format: 'jwk' });
  const kid = 'test-kid';

  return {
    source: 'test',
    current: { kid, privateKey },
    published: [{ ...publicJwk, kid, use: 'sig', alg: 'RS256' }],
  };
}

function suffix() {
  return randomUUID().replaceAll('-', '').slice(0, 6).toUpperCase();
}

function nextCode() {
  return `${CODE_PREFIX}${suffix()}`;
}

function nextRoom() {
  return `R-${suffix()}`;
}

/** One CSV row, with every field overridable so a test can break exactly one. */
function row(code, sectionCode, options = {}) {
  const {
    title = 'Algorithms',
    credits = 3,
    type = 'lecture',
    room = nextRoom(),
    capacity = 30,
    day = 1,
    start = '10:00',
    end = '11:30',
  } = options;

  return [code, title, credits, sectionCode, type, room, capacity, day, start, end].join(',');
}

function csv(...rows) {
  return `${[HEADER, ...rows].join('\n')}\n`;
}

async function request(path, { method = 'GET', body, token, headers = {} } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await response.text();
  return {
    status: response.status,
    json: text.length > 0 && response.headers.get('content-type')?.includes('json') ? JSON.parse(text) : null,
  };
}

/**
 * Multipart upload. `FormData` and `Blob` are global in Node 24, so no library is
 * needed and the request the test sends is the request a browser sends.
 */
async function upload(body, { token = adminToken, filename = 'catalogue.csv', type = 'text/csv', dryRun = false } = {}) {
  const form = new FormData();
  form.set('file', new Blob([body], { type }), filename);

  const response = await fetch(`${baseUrl}/api/imports${dryRun ? '?dryRun=true' : ''}`, {
    method: 'POST',
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body: form,
  });

  const text = await response.text();
  return {
    status: response.status,
    json: text.length > 0 && response.headers.get('content-type')?.includes('json') ? JSON.parse(text) : null,
  };
}

async function createUser(role) {
  const email = `imports-test-${randomUUID()}@example.test`;
  createdEmails.push(email);
  await users.createVerified({ email, password: PASSWORD, role });

  const user = await users.findByEmail(email);
  return tokens.signAccessToken({ sub: user.id, role });
}

async function createCourse(token = adminToken) {
  const response = await request('/api/courses', {
    method: 'POST',
    token,
    body: { code: nextCode(), title: 'Algorithms', credits: 3 },
  });
  assert.equal(response.status, 201, `expected 201, got ${response.status}: ${JSON.stringify(response.json)}`);
  return response.json;
}

async function createSection(body, token = adminToken) {
  const response = await request('/api/sections', { method: 'POST', token, body });
  assert.equal(response.status, 201, `expected 201, got ${response.status}: ${JSON.stringify(response.json)}`);
  return response.json;
}

async function importCount() {
  const { rows } = await pool.query('select count(*)::int as count from imports');
  return rows[0].count;
}

before(async () => {
  if (!DATABASE_URL) return;

  pool = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });
  withTransaction = async (fn) => {
    const client = await pool.connect();
    try {
      await client.query('begin');
      const result = await fn(client);
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  };

  const query = (text, params) => pool.query(text, params);
  tokens = createTokenService({ keystore: ephemeralKeystore(), accessTtlSeconds: 7200 });
  users = createUsersModel({ query, withTransaction });

  const catalogue = buildCatalogue({
    query,
    withTransaction,
    middleware: createAuthMiddleware({ tokens, users }),
  });

  adminToken = await createUser('admin');
  studentToken = await createUser('student');

  const app = createApp({ catalogue });
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (!DATABASE_URL) return;

  await new Promise((resolve) => server.close(resolve));

  await pool.query("delete from imports where filename like 'IMP%'");
  await pool.query(
    `delete from section_times where section_id in
       (select s.id from sections s join courses c on c.id = s.course_id where c.code like $1)`,
    [`${CODE_PREFIX}%`],
  );
  await pool.query(
    `delete from sections where course_id in (select id from courses where code like $1)`,
    [`${CODE_PREFIX}%`],
  );
  await pool.query('delete from courses where code like $1', [`${CODE_PREFIX}%`]);
  await pool.query('delete from users where email = any($1)', [createdEmails]);
  await pool.end();
});

test('imports need a login', { skip }, async () => {
  const response = await upload(csv(row(nextCode(), 'L1')), { token: null });
  assert.equal(response.status, 401);
  assert.equal(response.json.error.code, 'UNAUTHENTICATED');
});

test('imports need an admin', { skip }, async () => {
  const response = await upload(csv(row(nextCode(), 'L1')), { token: studentToken });
  assert.equal(response.status, 403);
  assert.equal(response.json.error.code, 'FORBIDDEN');
});

test('a good file creates the course, the section and its blocks', { skip }, async () => {
  const code = nextCode();
  const room = nextRoom();

  const response = await upload(
    csv(row(code, 'L1', { room, day: 1 }), row(code, 'L1', { room, day: 3, start: '14:00', end: '15:30' })),
    { filename: `IMP-a-good-file-${suffix()}.csv` },
  );

  assert.equal(response.status, 201, JSON.stringify(response.json));
  assert.equal(response.json.status, 'committed');
  assert.equal(response.json.rowCount, 2);
  assert.deepEqual(response.json.imported, { courses: 1, sections: 1, times: 2 });

  const section = await request(`/api/sections?courseCode=${code}`, { token: adminToken });
  assert.equal(section.status, 200);
  assert.equal(section.json.items.length, 1);
  assert.equal(section.json.items[0].times.length, 2);
  assert.equal(section.json.items[0].course.code, code);
});

test('a dry run answers 200 and writes nothing at all', { skip }, async () => {
  const before = await importCount();

  const response = await upload(csv(row(nextCode(), 'L1')), { dryRun: true, filename: `IMP-dry-${suffix()}.csv` });

  assert.equal(response.status, 200, JSON.stringify(response.json));
  assert.deepEqual(response.json, { valid: true, rowCount: 1, errors: [] });
  assert.equal(await importCount(), before, 'a dry run must not write history either');
});

test('the same file twice is refused by its hash, and the id points at the first import', { skip }, async () => {
  const body = csv(row(nextCode(), 'L1'));
  const filename = `IMP-duplicate-${suffix()}.csv`;

  const first = await upload(body, { filename });
  assert.equal(first.status, 201, JSON.stringify(first.json));

  const second = await upload(body, { filename });
  assert.equal(second.status, 409);
  assert.equal(second.json.error.code, 'ALREADY_IMPORTED');
  assert.equal(second.json.error.details.importId, first.json.importId);

  const dry = await upload(body, { filename, dryRun: true });
  assert.equal(dry.status, 409, 'a dry run still reports that the file would change nothing');
});

test('a file over 2 MB is refused before it is parsed', { skip }, async () => {
  const body = `${HEADER}\n${'x'.repeat(2 * 1024 * 1024 + 100)}\n`;
  const response = await upload(body, { filename: `IMP-large-${suffix()}.csv` });

  assert.equal(response.status, 413);
  assert.equal(response.json.error.code, 'FILE_TOO_LARGE');
});

test('a non-CSV media type is refused', { skip }, async () => {
  const response = await upload(csv(row(nextCode(), 'L1')), {
    filename: 'notes.pdf',
    type: 'application/pdf',
  });

  assert.equal(response.status, 415);
  assert.equal(response.json.error.code, 'UNSUPPORTED_MEDIA_TYPE');
});

test('a request with no file part is a 400', { skip }, async () => {
  const response = await fetch(`${baseUrl}/api/imports`, {
    method: 'POST',
    headers: { authorization: `Bearer ${adminToken}` },
    body: new FormData(),
  });

  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, 'VALIDATION_FAILED');
});

test('an unknown column is reported against the header row', { skip }, async () => {
  const body = `${HEADER},notes\n${row(nextCode(), 'L1')},hello\n`;
  const response = await upload(body, { filename: `IMP-header-${suffix()}.csv` });

  assert.equal(response.status, 422);
  assert.equal(response.json.error.code, 'IMPORT_INVALID');
  assert.equal(response.json.error.details.errors[0].row, 1);
  assert.equal(response.json.error.details.errors[0].field, 'notes');
});

test('a row with the wrong number of cells is reported against that row', { skip }, async () => {
  const response = await upload(`${HEADER}\n${nextCode()},Only,Three\n`, { filename: `IMP-cells-${suffix()}.csv` });

  assert.equal(response.status, 422);
  const [error] = response.json.error.details.errors;
  assert.equal(error.row, 2);
  assert.equal(error.field, 'row');
});

test('a bad value names the row and the field, and nothing is committed', { skip }, async () => {
  const code = nextCode();
  const response = await upload(csv(row(code, 'L1', { capacity: 0 })), { filename: `IMP-value-${suffix()}.csv` });

  assert.equal(response.status, 422);
  assert.ok(response.json.error.details.importId, 'a real attempt leaves an import id to look up');
  const [error] = response.json.error.details.errors;
  assert.equal(error.row, 2);
  assert.equal(error.field, 'capacity');

  const courses = await request(`/api/courses?code=${code}`, { token: adminToken });
  assert.equal(courses.json.items.length, 0, 'one bad row must leave no course behind');
});

test('a failed import still leaves a history row, with no committed timestamp', { skip }, async () => {
  const filename = `IMP-failed-${suffix()}.csv`;
  const response = await upload(csv(row(nextCode(), 'L1', { day: 9 })), { filename });
  assert.equal(response.status, 422);

  const id = response.json.error.details.importId;
  const detail = await request(`/api/imports/${id}`, { token: adminToken });

  assert.equal(detail.status, 200);
  assert.equal(detail.json.status, 'failed');
  assert.equal(detail.json.committedAt, null);
  assert.ok(detail.json.errorCount >= 1);
  assert.equal(detail.json.filename, filename);
});

test('two rows for one section must agree on type, room and capacity', { skip }, async () => {
  const code = nextCode();
  const response = await upload(
    csv(row(code, 'L1', { room: 'H-1' }), row(code, 'L1', { room: 'H-2', day: 2 })),
    { filename: `IMP-agree-${suffix()}.csv` },
  );

  assert.equal(response.status, 422);
  assert.ok(
    response.json.error.details.errors.some((error) => error.field === 'room'),
    JSON.stringify(response.json.error.details),
  );
});

test('a section that books one room twice inside the file is caught against itself', { skip }, async () => {
  const code = nextCode();
  const room = nextRoom();
  const response = await upload(
    csv(row(code, 'L1', { room, day: 2, start: '10:00', end: '11:30' }), row(code, 'L2', { room, day: 2, start: '11:00', end: '12:00' })),
    { filename: `IMP-selfclash-${suffix()}.csv` },
  );

  assert.equal(response.status, 422);
  assert.ok(
    response.json.error.details.errors.some((error) => /already booked/i.test(error.message)),
    JSON.stringify(response.json.error.details),
  );
});

test('a room already booked by an existing section blocks the import', { skip }, async () => {
  const course = await createCourse();
  const room = nextRoom();

  await createSection({
    courseId: course.id,
    sectionCode: 'L1',
    type: 'lecture',
    room,
    capacity: 30,
    times: [{ dayOfWeek: 4, startTime: '09:00', endTime: '10:30' }],
  });

  const response = await upload(
    csv(row(nextCode(), 'L1', { room, day: 4, start: '10:00', end: '11:00' })),
    { filename: `IMP-roomclash-${suffix()}.csv` },
  );

  assert.equal(response.status, 422);
  assert.ok(
    response.json.error.details.errors.some((error) => /already booked/i.test(error.message)),
    JSON.stringify(response.json.error.details),
  );
});

test('an archived course is reported instead of being resurrected', { skip }, async () => {
  const course = await createCourse();
  await request(`/api/courses/${course.id}`, { method: 'DELETE', token: adminToken });

  const response = await upload(csv(row(course.code, 'L9')), { filename: `IMP-archived-${suffix()}.csv` });

  assert.equal(response.status, 422);
  assert.ok(
    response.json.error.details.errors.some((error) => /archived/i.test(error.message)),
    JSON.stringify(response.json.error.details),
  );

  const detail = await request(`/api/courses/${course.id}`, { token: adminToken });
  assert.ok(detail.json.archivedAt, 'the archived course stays archived');
  assert.equal(detail.json.sectionCount, 0, 'and gains no sections');
});

test('the import history lists what happened, newest first, filterable by status', { skip }, async () => {
  const filename = `IMP-history-${suffix()}.csv`;
  const created = await upload(csv(row(nextCode(), 'L1')), { filename });
  assert.equal(created.status, 201);

  const listed = await request(`/api/imports?limit=100`, { token: adminToken });
  assert.equal(listed.status, 200);
  assert.ok(listed.json.items.length >= 1);
  assert.ok(listed.json.items.some((item) => item.id === created.json.importId));
  assert.ok(listed.json.items[0].uploadedBy.email, 'the history names who imported it');

  const committed = await request('/api/imports?status=committed&limit=5', { token: adminToken });
  assert.equal(committed.status, 200);
  assert.ok(committed.json.items.every((item) => item.status === 'committed'));

  const failed = await request('/api/imports?status=failed&limit=5', { token: adminToken });
  assert.equal(failed.status, 200);
  assert.ok(failed.json.items.every((item) => item.status === 'failed'));
});

test('an unknown import id is a 404, and a malformed one is a 404 rather than a crash', { skip }, async () => {
  const unknown = await request(`/api/imports/${randomUUID()}`, { token: adminToken });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.json.error.code, 'IMPORT_NOT_FOUND');

  const malformed = await request('/api/imports/not-a-uuid', { token: adminToken });
  assert.equal(malformed.status, 404);

  const badStatus = await request('/api/imports?status=maybe', { token: adminToken });
  assert.equal(badStatus.status, 422);
  assert.equal(badStatus.json.error.details.field, 'status');
});

test('the report is capped at 100 rows but the true count is reported', { skip }, async () => {
  const code = nextCode();
  const rows = Array.from({ length: 120 }, (_, index) => row(code, `L${index}`, { capacity: 0 }));
  const response = await upload(csv(...rows), { filename: `IMP-capped-${suffix()}.csv` });

  assert.equal(response.status, 422);
  assert.equal(response.json.error.details.errors.length, 100);
  assert.equal(response.json.error.details.truncated, true);
  assert.equal(response.json.error.details.totalErrors, 120);
});
