import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';

import pg from 'pg';

import { createApp } from '../src/app.js';
import { buildCatalogue } from '../src/catalogue/index.js';
import { createAuthMiddleware } from '../src/auth/middleware.js';
import { createTokenService } from '../src/auth/tokens.js';
import { createUsersModel } from '../src/models/users.model.js';

/**
 * The course routes end to end: HTTP in, Postgres underneath, a real RS256 key.
 *
 * The subject is the *rules*: which status comes out for which input, whether a
 * student can write, whether archiving is one operation or two, and whether the
 * archive rules hold. Auth has its own tests; here tokens are minted directly
 * with `tokens.signAccessToken` instead of going through login, because logging
 * in is not what is being tested.
 *
 * Skips itself when DATABASE_URL is absent, like the other database tests.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const skip = DATABASE_URL ? false : 'needs DATABASE_URL (local stack on :5433)';

const PASSWORD = 'correct horse battery';

let pool;
let withTransaction;
let users;
let tokens;
let server;
let baseUrl;
let adminToken;
let studentToken;

const createdEmails = [];
// Its own prefix: `node --test` runs files in parallel against one database.
const CODE_PREFIX = 'CRS';

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

/** A code no other run will collide with, still inside the 20-character limit. */
function nextCode() {
  return `${CODE_PREFIX}${randomUUID().replaceAll('-', '').slice(0, 6).toUpperCase()}`;
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
  const email = `courses-test-${randomUUID()}@example.test`;
  createdEmails.push(email);
  await users.createVerified({ email, password: PASSWORD, role });

  const user = await users.findByEmail(email);
  return tokens.signAccessToken({ sub: user.id, role });
}

async function createCourse(token, overrides = {}) {
  const response = await request('/api/courses', {
    method: 'POST',
    token,
    body: { code: nextCode(), title: 'Software Engineering', credits: 3, ...overrides },
  });
  assert.equal(response.status, 201, `expected 201, got ${response.status}: ${JSON.stringify(response.json)}`);
  return response.json;
}

/** A live section, so a course can be proven to be "in use". */
async function addSection(courseId, { archived = false } = {}) {
  const code = `S${randomUUID().replaceAll('-', '').slice(0, 5).toUpperCase()}`;
  const { rows } = await pool.query(
    `insert into sections (course_id, section_code, type, room, capacity, archived_at)
     values ($1, $2, 'lecture', 'H1', 30, ${archived ? 'now()' : 'null'})
     returning id`,
    [courseId, code],
  );
  return rows[0].id;
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
    // The real guards, because "a student cannot write" is one of the rules.
    middleware: createAuthMiddleware({ tokens, users }),
  });

  adminToken = await createUser('admin');
  studentToken = await createUser('student');

  const app = createApp({ catalogue });
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(() => {
  // Nothing to reset between tests: every test creates its own course.
});

after(async () => {
  if (!DATABASE_URL) return;

  await new Promise((resolve) => server.close(resolve));

  // Sections and their time blocks first: the foreign keys are deliberate.
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
  if (createdEmails.length > 0) {
    await pool.query('delete from users where email = any($1::text[])', [createdEmails]);
  }
  await pool.end();
});

test('a request without a token is refused', { skip }, async () => {
  const response = await request('/api/courses');

  assert.equal(response.status, 401);
  assert.equal(response.json.error.code, 'UNAUTHENTICATED');
});

test('a student may read but not write', { skip }, async () => {
  const read = await request('/api/courses', { token: studentToken });
  assert.equal(read.status, 200);

  const write = await request('/api/courses', {
    method: 'POST',
    token: studentToken,
    body: { code: nextCode(), title: 'Nope', credits: 3 },
  });

  assert.equal(write.status, 403);
  assert.equal(write.json.error.code, 'FORBIDDEN');
});

test('an admin creates a course, normalised and with no sections yet', { skip }, async () => {
  const code = nextCode().toLowerCase();
  const response = await request('/api/courses', {
    method: 'POST',
    token: adminToken,
    body: { code: ` ${code} `, title: '  Databases  ', credits: 3 },
  });

  assert.equal(response.status, 201);
  assert.equal(response.json.code, code.toUpperCase());
  assert.equal(response.json.title, 'Databases');
  assert.equal(response.json.credits, 3);
  assert.equal(response.json.sectionCount, 0);
  assert.equal(response.json.archivedAt, null);
  assert.ok(response.json.id);
});

test('a duplicate code is a 409 that names the code', { skip }, async () => {
  const course = await createCourse(adminToken);

  const response = await request('/api/courses', {
    method: 'POST',
    token: adminToken,
    body: { code: course.code.toLowerCase(), title: 'Another', credits: 2 },
  });

  assert.equal(response.status, 409);
  assert.equal(response.json.error.code, 'DUPLICATE_CODE');
  assert.equal(response.json.error.details.code, course.code);
});

test('spaces inside a code are not a way to smuggle in a duplicate', { skip }, async () => {
  const base = nextCode();

  const spaced = await request('/api/courses', {
    method: 'POST',
    token: adminToken,
    body: { code: `${base.slice(0, 3)} ${base.slice(3)}`, title: 'With a space', credits: 3 },
  });

  assert.equal(spaced.status, 201);
  assert.equal(spaced.json.code, base);

  const tight = await request('/api/courses', {
    method: 'POST',
    token: adminToken,
    body: { code: base, title: 'Without a space', credits: 3 },
  });

  assert.equal(tight.status, 409);
  assert.equal(tight.json.error.code, 'DUPLICATE_CODE');
});

test('invalid input answers 422 and names the field', { skip }, async () => {
  const credits = await request('/api/courses', {
    method: 'POST',
    token: adminToken,
    body: { code: nextCode(), title: 'Fine', credits: 31 },
  });

  assert.equal(credits.status, 422);
  assert.equal(credits.json.error.code, 'VALIDATION_FAILED');
  assert.equal(credits.json.error.details.field, 'credits');

  const code = await request('/api/courses', {
    method: 'POST',
    token: adminToken,
    body: { code: 'has space!', title: 'Fine', credits: 3 },
  });

  assert.equal(code.status, 422);
  assert.equal(code.json.error.details.field, 'code');
});

test('the list filters by q and code together, and hides archived courses', { skip }, async () => {
  const match = await createCourse(adminToken, { title: 'Compiler Construction' });
  const other = await createCourse(adminToken, { title: 'Compilers Are Not This' });

  // `q` is a substring of code or title; `code` is exact. Both apply.
  const found = await request(`/api/courses?q=${encodeURIComponent('Compiler')}&code=${match.code}`, {
    token: studentToken,
  });

  assert.equal(found.status, 200);
  assert.deepEqual(
    found.json.items.map((course) => course.id),
    [match.id],
  );

  await request(`/api/courses/${other.id}`, { method: 'DELETE', token: adminToken });

  const afterArchive = await request(`/api/courses?q=${encodeURIComponent('Compiler')}`, {
    token: studentToken,
  });
  assert.deepEqual(
    afterArchive.json.items.map((course) => course.id),
    [match.id],
  );
});

test('only an admin may ask for archived courses', { skip }, async () => {
  const student = await request('/api/courses?includeArchived=true', { token: studentToken });
  assert.equal(student.status, 403);
  assert.equal(student.json.error.code, 'FORBIDDEN');

  const admin = await request('/api/courses?includeArchived=true', { token: adminToken });
  assert.equal(admin.status, 200);
});

test('an archived course is still readable by id', { skip }, async () => {
  const course = await createCourse(adminToken);
  await request(`/api/courses/${course.id}`, { method: 'DELETE', token: adminToken });

  const response = await request(`/api/courses/${course.id}`, { token: studentToken });

  assert.equal(response.status, 200);
  assert.equal(response.json.id, course.id);
  assert.ok(response.json.archivedAt);
});

test('sending the same code back is a no-op, not a conflict', { skip }, async () => {
  const course = await createCourse(adminToken);
  await addSection(course.id);

  const response = await request(`/api/courses/${course.id}`, {
    method: 'PATCH',
    token: adminToken,
    body: { code: course.code.toLowerCase(), title: 'Renamed' },
  });

  assert.equal(response.status, 200);
  assert.equal(response.json.code, course.code);
  assert.equal(response.json.title, 'Renamed');
  assert.equal(response.json.sectionCount, 1);
});

test('a code cannot change while live sections hang off it', { skip }, async () => {
  const course = await createCourse(adminToken);
  await addSection(course.id);

  const response = await request(`/api/courses/${course.id}`, {
    method: 'PATCH',
    token: adminToken,
    body: { code: nextCode() },
  });

  assert.equal(response.status, 409);
  assert.equal(response.json.error.code, 'CODE_IN_USE');
  assert.equal(response.json.error.details.sectionCount, 1);
});

test('a code may change once every section is archived', { skip }, async () => {
  const course = await createCourse(adminToken);
  await addSection(course.id, { archived: true });

  const renamed = nextCode();
  const response = await request(`/api/courses/${course.id}`, {
    method: 'PATCH',
    token: adminToken,
    body: { code: renamed },
  });

  assert.equal(response.status, 200);
  assert.equal(response.json.code, renamed);
});

test('delete archives the course and its live sections, and is idempotent', { skip }, async () => {
  const course = await createCourse(adminToken);
  await addSection(course.id);
  await addSection(course.id);

  const first = await request(`/api/courses/${course.id}`, { method: 'DELETE', token: adminToken });

  assert.equal(first.status, 200);
  assert.equal(first.json.id, course.id);
  assert.equal(first.json.archivedSections, 2);
  assert.ok(first.json.archivedAt);

  const second = await request(`/api/courses/${course.id}`, { method: 'DELETE', token: adminToken });

  assert.equal(second.status, 200);
  assert.equal(second.json.archivedSections, 0);
  assert.equal(second.json.archivedAt, first.json.archivedAt);
});

test('a restored course comes back without its sections', { skip }, async () => {
  const course = await createCourse(adminToken);
  await addSection(course.id);
  await request(`/api/courses/${course.id}`, { method: 'DELETE', token: adminToken });

  const response = await request(`/api/courses/${course.id}`, {
    method: 'PATCH',
    token: adminToken,
    body: { archived: false },
  });

  assert.equal(response.status, 200);
  assert.equal(response.json.archivedAt, null);
  assert.equal(response.json.sectionCount, 0);
});

test('unknown and malformed ids are 404s, not 500s', { skip }, async () => {
  const missing = await request(`/api/courses/${randomUUID()}`, { token: studentToken });
  assert.equal(missing.status, 404);
  assert.equal(missing.json.error.code, 'COURSE_NOT_FOUND');

  const malformed = await request('/api/courses/not-a-uuid', { token: studentToken });
  assert.equal(malformed.status, 404);
  assert.equal(malformed.json.error.code, 'COURSE_NOT_FOUND');

  const patch = await request('/api/courses/not-a-uuid', {
    method: 'PATCH',
    token: adminToken,
    body: { title: 'x' },
  });
  assert.equal(patch.status, 404);
});

test('the list pages with a cursor instead of an offset', { skip }, async () => {
  for (let index = 0; index < 3; index += 1) await createCourse(adminToken);

  const first = await request('/api/courses?limit=2', { token: studentToken });
  assert.equal(first.status, 200);
  assert.equal(first.json.items.length, 2);
  assert.ok(first.json.nextCursor);

  const second = await request(`/api/courses?limit=2&cursor=${encodeURIComponent(first.json.nextCursor)}`, {
    token: studentToken,
  });
  assert.equal(second.status, 200);
  const seen = new Set([...first.json.items, ...second.json.items].map((course) => course.id));
  assert.equal(seen.size, first.json.items.length + second.json.items.length);
});
