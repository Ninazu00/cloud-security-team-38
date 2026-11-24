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
 * The section routes end to end, with the room rule as the subject.
 *
 * What is worth testing here is the invariant, not the CRUD: two sections in one
 * room at overlapping times are refused, back-to-back blocks are allowed, the
 * check re-runs when times change, and archiving releases the room. Those are
 * the sentences the report will claim, so they are the sentences a test proves.
 *
 * Skips itself when DATABASE_URL is absent, like the other database tests.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const skip = DATABASE_URL ? false : 'needs DATABASE_URL (local stack on :5433)';

const PASSWORD = 'correct horse battery';
// Its own prefix: `node --test` runs files in parallel against one database.
const CODE_PREFIX = 'SEC';

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

/** Unique per test run, and inside the contract's 32-character limit. */
function nextRoom() {
  return `R-${suffix()}`;
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

async function createUser(role) {
  const email = `sections-test-${randomUUID()}@example.test`;
  createdEmails.push(email);
  await users.createVerified({ email, password: PASSWORD, role });

  const user = await users.findByEmail(email);
  return tokens.signAccessToken({ sub: user.id, role });
}

async function createCourse(token = adminToken) {
  const response = await request('/api/courses', {
    method: 'POST',
    token,
    body: { code: `${CODE_PREFIX}${suffix()}`, title: 'Algorithms', credits: 3 },
  });
  assert.equal(response.status, 201, `expected 201, got ${response.status}: ${JSON.stringify(response.json)}`);
  return response.json;
}

async function createSection(body, token = adminToken) {
  return request('/api/sections', { method: 'POST', token, body });
}

async function createSectionOk(body, token = adminToken) {
  const response = await createSection(body, token);
  assert.equal(response.status, 201, `expected 201, got ${response.status}: ${JSON.stringify(response.json)}`);
  return response.json;
}

function block(dayOfWeek, startTime, endTime) {
  return { dayOfWeek, startTime, endTime };
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

test('sections need a login', { skip }, async () => {
  const response = await request('/api/sections');
  assert.equal(response.status, 401);
  assert.equal(response.json.error.code, 'UNAUTHENTICATED');
});

test('a student may read sections but not write them', { skip }, async () => {
  const course = await createCourse();
  const list = await request('/api/sections', { token: studentToken });
  assert.equal(list.status, 200);
  assert.deepEqual(list.json.missingIds, []);

  const write = await createSection(
    { courseId: course.id, sectionCode: 'L1', type: 'lab', room: nextRoom(), capacity: 20, times: [block(1, '10:00', '11:00')] },
    studentToken,
  );
  assert.equal(write.status, 403);
  assert.equal(write.json.error.code, 'FORBIDDEN');
});

test('a created section embeds its course and sorts its blocks', { skip }, async () => {
  const course = await createCourse();
  const room = nextRoom();

  const section = await createSectionOk({
    courseId: course.id,
    sectionCode: 'L1',
    type: 'lab',
    room,
    capacity: 30,
    times: [block(3, '14:00', '15:30'), block(1, '10:00', '11:30')],
  });

  assert.equal(section.course.id, course.id);
  assert.equal(section.course.code, course.code);
  assert.equal(section.room, room);
  assert.equal(section.archivedAt, null);
  assert.deepEqual(section.times, [block(1, '10:00', '11:30'), block(3, '14:00', '15:30')]);
});

test('a room cannot be double-booked', { skip }, async () => {
  const course = await createCourse();
  const room = nextRoom();

  const first = await createSectionOk({
    courseId: course.id, sectionCode: 'L1', type: 'lecture', room, capacity: 40, times: [block(1, '10:00', '11:30')],
  });

  const second = await createSection({
    courseId: course.id, sectionCode: 'L2', type: 'lecture', room, capacity: 40, times: [block(1, '11:00', '12:00')],
  });

  assert.equal(second.status, 409);
  assert.equal(second.json.error.code, 'ROOM_CONFLICT');
  assert.equal(second.json.error.details.conflictingSectionId, first.id);
  assert.match(second.json.error.message, /already booked/i);
  assert.match(second.json.error.details.conflict, /Mon 10:00–11:30/);
});

test('back-to-back blocks in one room are legal', { skip }, async () => {
  const course = await createCourse();
  const room = nextRoom();

  await createSectionOk({
    courseId: course.id, sectionCode: 'A', type: 'lecture', room, capacity: 40, times: [block(2, '10:00', '11:00')],
  });
  await createSectionOk({
    courseId: course.id, sectionCode: 'B', type: 'lecture', room, capacity: 40, times: [block(2, '11:00', '12:00')],
  });
});

test('a section whose own blocks overlap is a 400, not a conflict', { skip }, async () => {
  const course = await createCourse();

  const response = await createSection({
    courseId: course.id,
    sectionCode: 'L1',
    type: 'lab',
    room: nextRoom(),
    capacity: 20,
    times: [block(4, '09:00', '11:00'), block(4, '10:00', '12:00')],
  });

  assert.equal(response.status, 400);
  assert.equal(response.json.error.code, 'VALIDATION_FAILED');
  assert.deepEqual(response.json.error.details.blocks, [0, 1]);
});

test('a section code is unique among live sections of its course', { skip }, async () => {
  const course = await createCourse();

  await createSectionOk({
    courseId: course.id, sectionCode: 'L1', type: 'lab', room: nextRoom(), capacity: 20, times: [block(1, '09:00', '10:00')],
  });

  const duplicate = await createSection({
    courseId: course.id, sectionCode: 'L1', type: 'lab', room: nextRoom(), capacity: 20, times: [block(2, '09:00', '10:00')],
  });

  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.json.error.code, 'SECTION_CODE_TAKEN');
});

test('capacity, type and times are validated with the field named', { skip }, async () => {
  const course = await createCourse();
  const base = { courseId: course.id, sectionCode: 'L1', type: 'lab', room: nextRoom(), capacity: 20, times: [block(1, '09:00', '10:00')] };

  const capacity = await createSection({ ...base, capacity: 900 });
  assert.equal(capacity.status, 422);
  assert.equal(capacity.json.error.code, 'VALIDATION_FAILED');
  assert.equal(capacity.json.error.details.field, 'capacity');

  const type = await createSection({ ...base, type: 'seminar' });
  assert.equal(type.status, 422);
  assert.equal(type.json.error.details.field, 'type');

  const overnight = await createSection({ ...base, times: [block(1, '22:00', '01:00')] });
  assert.equal(overnight.status, 422);
  assert.equal(overnight.json.error.details.field, 'endTime');

  const empty = await createSection({ ...base, times: [] });
  assert.equal(empty.status, 422);
  assert.equal(empty.json.error.details.field, 'times');
});

test('a section cannot be added to an archived course', { skip }, async () => {
  const course = await createCourse();
  await request(`/api/courses/${course.id}`, { method: 'DELETE', token: adminToken });

  const response = await createSection({
    courseId: course.id, sectionCode: 'L1', type: 'lab', room: nextRoom(), capacity: 20, times: [block(1, '09:00', '10:00')],
  });

  assert.equal(response.status, 409);
  assert.equal(response.json.error.code, 'COURSE_ARCHIVED');
});

test('an unknown course is a 404, not a foreign key error', { skip }, async () => {
  const response = await createSection({
    courseId: randomUUID(), sectionCode: 'L1', type: 'lab', room: nextRoom(), capacity: 20, times: [block(1, '09:00', '10:00')],
  });

  assert.equal(response.status, 404);
  assert.equal(response.json.error.code, 'COURSE_NOT_FOUND');
});

test('times are replaced, not merged, and the old block is released', { skip }, async () => {
  const course = await createCourse();
  const room = nextRoom();

  const section = await createSectionOk({
    courseId: course.id,
    sectionCode: 'L1',
    type: 'lab',
    room,
    capacity: 20,
    times: [block(1, '10:00', '11:00'), block(3, '14:00', '15:00')],
  });

  const patched = await request(`/api/sections/${section.id}`, {
    method: 'PATCH',
    token: adminToken,
    body: { times: [block(2, '09:00', '10:00')] },
  });

  assert.equal(patched.status, 200);
  assert.deepEqual(patched.json.times, [block(2, '09:00', '10:00')]);

  // Monday 10:00 is free again in that room, so another section may take it.
  const reused = await createSection({
    courseId: course.id, sectionCode: 'L2', type: 'lab', room, capacity: 20, times: [block(1, '10:00', '11:00')],
  });
  assert.equal(reused.status, 201);
});

test('changing times into an existing booking is refused', { skip }, async () => {
  const course = await createCourse();
  const room = nextRoom();

  await createSectionOk({
    courseId: course.id, sectionCode: 'L1', type: 'lab', room, capacity: 20, times: [block(1, '10:00', '11:00')],
  });
  const other = await createSectionOk({
    courseId: course.id, sectionCode: 'L2', type: 'lab', room: nextRoom(), capacity: 20, times: [block(1, '15:00', '16:00')],
  });

  const patched = await request(`/api/sections/${other.id}`, {
    method: 'PATCH',
    token: adminToken,
    body: { room, times: [block(1, '10:30', '11:30')] },
  });

  assert.equal(patched.status, 409);
  assert.equal(patched.json.error.code, 'ROOM_CONFLICT');
});

test('courseId is immutable', { skip }, async () => {
  const course = await createCourse();
  const otherCourse = await createCourse();
  const section = await createSectionOk({
    courseId: course.id, sectionCode: 'L1', type: 'lab', room: nextRoom(), capacity: 20, times: [block(1, '09:00', '10:00')],
  });

  const patched = await request(`/api/sections/${section.id}`, {
    method: 'PATCH',
    token: adminToken,
    body: { courseId: otherCourse.id },
  });

  assert.equal(patched.status, 422);
  assert.equal(patched.json.error.details.field, 'courseId');
});

test('deleting archives, is idempotent, and hides the section from search', { skip }, async () => {
  const course = await createCourse();
  const room = nextRoom();
  const section = await createSectionOk({
    courseId: course.id, sectionCode: 'L1', type: 'lab', room, capacity: 20, times: [block(5, '08:00', '09:00')],
  });

  const first = await request(`/api/sections/${section.id}`, { method: 'DELETE', token: adminToken });
  assert.equal(first.status, 200);
  assert.equal(first.json.id, section.id);
  assert.ok(first.json.archivedAt);

  const second = await request(`/api/sections/${section.id}`, { method: 'DELETE', token: adminToken });
  assert.equal(second.status, 200);
  assert.equal(second.json.archivedAt, first.json.archivedAt, 'the archive timestamp must not move');

  // Still resolvable by id, with the flag set; gone from the default search.
  const byId = await request(`/api/sections/${section.id}`, { token: adminToken });
  assert.equal(byId.status, 200);
  assert.ok(byId.json.archivedAt);

  const search = await request(`/api/sections?courseId=${course.id}`, { token: adminToken });
  assert.equal(search.json.items.length, 0);

  // And the room is free again for the same slot.
  const reuse = await createSection({
    courseId: course.id, sectionCode: 'L2', type: 'lab', room, capacity: 20, times: [block(5, '08:00', '09:00')],
  });
  assert.equal(reuse.status, 201);
});

test('restoring a section whose code has been reused is refused', { skip }, async () => {
  const course = await createCourse();
  const original = await createSectionOk({
    courseId: course.id, sectionCode: 'A', type: 'lecture', room: nextRoom(), capacity: 30, times: [block(1, '09:00', '10:00')],
  });

  await request(`/api/sections/${original.id}`, { method: 'DELETE', token: adminToken });

  // The archive freed the code, so reusing it is legitimate.
  await createSectionOk({
    courseId: course.id, sectionCode: 'A', type: 'lecture', room: nextRoom(), capacity: 30, times: [block(2, '09:00', '10:00')],
  });

  const restore = await request(`/api/sections/${original.id}`, {
    method: 'PATCH',
    token: adminToken,
    body: { archived: false },
  });

  assert.equal(restore.status, 409);
  assert.equal(restore.json.error.code, 'SECTION_CODE_TAKEN');
});

test('availability search returns sections whose block overlaps the window', { skip }, async () => {
  const course = await createCourse();
  const section = await createSectionOk({
    courseId: course.id, sectionCode: 'L1', type: 'lab', room: nextRoom(), capacity: 20, times: [block(2, '10:00', '11:30')],
  });

  const overlapping = await request('/api/sections?dayOfWeek=2&from=11:00&to=12:00', { token: adminToken });
  assert.equal(overlapping.status, 200);
  assert.ok(overlapping.json.items.some((item) => item.id === section.id));
  assert.deepEqual(overlapping.json.missingIds, []);

  const clean = await request('/api/sections?dayOfWeek=2&from=11:30&to=12:30', { token: adminToken });
  assert.ok(!clean.json.items.some((item) => item.id === section.id), 'back-to-back must not overlap');
});

test('a window without a day, or a reversed window, is a 400', { skip }, async () => {
  const noDay = await request('/api/sections?from=10:00&to=11:00', { token: adminToken });
  assert.equal(noDay.status, 400);
  assert.equal(noDay.json.error.code, 'VALIDATION_FAILED');

  const reversed = await request('/api/sections?dayOfWeek=1&from=11:00&to=10:00', { token: adminToken });
  assert.equal(reversed.status, 400);
  assert.equal(reversed.json.error.details.field, 'to');
});

test('batch mode returns archived rows and reports missing ids', { skip }, async () => {
  const course = await createCourse();
  const live = await createSectionOk({
    courseId: course.id, sectionCode: 'L1', type: 'lab', room: nextRoom(), capacity: 20, times: [block(1, '08:00', '09:00')],
  });
  const archived = await createSectionOk({
    courseId: course.id, sectionCode: 'L2', type: 'lab', room: nextRoom(), capacity: 20, times: [block(1, '09:00', '10:00')],
  });
  await request(`/api/sections/${archived.id}`, { method: 'DELETE', token: adminToken });

  const unknown = randomUUID();
  const response = await request(`/api/sections?ids=${live.id},${archived.id},${unknown}`, { token: studentToken });

  assert.equal(response.status, 200);
  assert.equal(response.json.items.length, 2);
  assert.deepEqual(
    response.json.items.map((item) => item.id),
    [live.id, archived.id],
    'the caller gets the ids back in the order it asked for them',
  );
  assert.ok(response.json.items[1].archivedAt);
  assert.deepEqual(response.json.missingIds, [unknown]);
});

test('batch mode rejects filters, empty lists and more than 100 ids', { skip }, async () => {
  const mixed = await request('/api/sections?ids=abc&limit=5', { token: adminToken });
  assert.equal(mixed.status, 400);
  assert.equal(mixed.json.error.code, 'VALIDATION_FAILED');

  const empty = await request('/api/sections?ids=', { token: adminToken });
  assert.equal(empty.status, 400);

  const many = Array.from({ length: 101 }, () => randomUUID()).join(',');
  const tooMany = await request(`/api/sections?ids=${many}`, { token: adminToken });
  assert.equal(tooMany.status, 400);
  assert.equal(tooMany.json.error.details.count, 101);
});

test('only an admin may ask for archived sections', { skip }, async () => {
  const response = await request('/api/sections?includeArchived=true', { token: studentToken });
  assert.equal(response.status, 403);
  assert.equal(response.json.error.code, 'FORBIDDEN');

  const admin = await request('/api/sections?includeArchived=true', { token: adminToken });
  assert.equal(admin.status, 200);
});
