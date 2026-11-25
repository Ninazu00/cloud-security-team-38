import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import app from "../../src/app.js";
import { resetRateLimiter } from "../../src/middleware/security.js";
import { handler as consumerHandler } from "../../src/consumer.js";

process.env.NODE_ENV = "test";
process.env.DEP_MODE = "mock";
process.env.DISABLE_CW_LOGS = "true";

const privPath = path.join(process.cwd(), "local-private.pem");
const pubPath = path.join(process.cwd(), "local-public.pem");
let generatedTestKeys = false;
if (!fs.existsSync(privPath) || !fs.existsSync(pubPath)) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" }
  });
  fs.writeFileSync(privPath, privateKey, { mode: 0o600 });
  fs.writeFileSync(pubPath, publicKey);
  generatedTestKeys = true;
}
after(() => {
  if (generatedTestKeys) {
    fs.rmSync(privPath, { force: true });
    fs.rmSync(pubPath, { force: true });
  }
});
const privKey = fs.readFileSync(privPath, "utf8");
const mint = (sub, role = "student", expiresIn = "2h") =>
  jwt.sign({ sub, role }, privKey, { algorithm: "RS256", expiresIn });

const student1Token = mint("student-1", "student");
const student2Token = mint("student-2", "student");
const adminToken = mint("admin-1", "admin");

let server;
let baseUrl;
const createdIds = [];

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

beforeEach(() => {
  resetRateLimiter();
  delete process.env.RATE_LIMIT_MAX;
});

after(async () => {
  for (const id of createdIds) {
    await fetch(`${baseUrl}/api/timetables/${id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${student1Token}` },
    }).catch(() => {});
  }
  await new Promise((resolve) => server.close(resolve));
});

test("S1: missing Authorization header returns 401", async () => {
  const res = await fetch(`${baseUrl}/api/timetables`);
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.error.code, "UNAUTHORIZED");
});

test("S2: forged JWT (wrong key) and expired JWT both return 401", async () => {
  const { privateKey: rogueKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const forged = jwt.sign({ sub: "student-1", role: "admin" }, rogueKey, { algorithm: "RS256" });
  const expired = mint("student-1", "student", "-120s");

  const r1 = await fetch(`${baseUrl}/api/timetables`, {
    headers: { Authorization: `Bearer ${forged}` },
  });
  const r2 = await fetch(`${baseUrl}/api/timetables`, {
    headers: { Authorization: `Bearer ${expired}` },
  });
  assert.equal(r1.status, 401);
  assert.equal(r2.status, 401);
});

test("S3: student calling admin-only /api/health returns 403; admin gets 200", async () => {
  const rStudent = await fetch(`${baseUrl}/api/health`, {
    headers: { Authorization: `Bearer ${student1Token}` },
  });
  assert.equal(rStudent.status, 403);

  const rAdmin = await fetch(`${baseUrl}/api/health`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  assert.equal(rAdmin.status, 200);
  const body = await rAdmin.json();
  assert.equal(body.status, "ok");
});

test("S4: security headers are present and x-powered-by is hidden", async () => {
  const res = await fetch(`${baseUrl}/api/timetables`, {
    headers: { Authorization: `Bearer ${student1Token}` },
  });
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("x-frame-options"), "DENY");
  assert.ok(res.headers.get("content-security-policy"));
  assert.equal(res.headers.get("x-powered-by"), null);
});

test("S5: non-JSON Content-Type returns 415 UNSUPPORTED_MEDIA_TYPE", async () => {
  const res = await fetch(`${baseUrl}/api/timetables/check`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${student1Token}`,
      "Content-Type": "text/plain",
    },
    body: "sectionIds=101",
  });
  assert.equal(res.status, 415);
  const body = await res.json();
  assert.equal(body.error.code, "UNSUPPORTED_MEDIA_TYPE");
});

test("S6: malformed JSON returns 400 VALIDATION_ERROR", async () => {
  const res = await fetch(`${baseUrl}/api/timetables/check`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${student1Token}`,
      "Content-Type": "application/json",
    },
    body: '{"sectionIds":["101",]}',
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error.code, "VALIDATION_ERROR");
});

test("S7: oversized body (>16kb) returns 413 PAYLOAD_TOO_LARGE", async () => {
  const huge = JSON.stringify({ name: "a".repeat(25_000), sectionIds: ["101"] });
  const res = await fetch(`${baseUrl}/api/timetables`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${student1Token}`,
      "Content-Type": "application/json",
    },
    body: huge,
  });
  assert.equal(res.status, 413);
  const body = await res.json();
  assert.equal(body.error.code, "PAYLOAD_TOO_LARGE");
});

test("S8: >8 courses in generate returns 400 (combinatorial DoS limit)", async () => {
  const res = await fetch(`${baseUrl}/api/timetables/generate`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${student1Token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ courseIds: ["1", "2", "3", "4", "5", "6", "7", "8", "9"] }),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error.code, "VALIDATION_ERROR");
});

test("S9: XSS script tag in timetable name is stripped before saving", async () => {
  const res = await fetch(`${baseUrl}/api/timetables`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${student1Token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: "<script>alert(1)</script>Fall Plan",
      sectionIds: ["101", "103"],
    }),
  });
  assert.equal(res.status, 201);
  const body = await res.json();
  createdIds.push(body.id);
  assert.equal(body.name, "Fall Plan");
});

test("S10: IDOR protection — student-2 gets 404 on student-1's timetable (GET, ICS, DELETE)", async () => {
  const createRes = await fetch(`${baseUrl}/api/timetables`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${student1Token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name: "Private Schedule", sectionIds: ["101", "202"] }),
  });
  assert.equal(createRes.status, 201);
  const saved = await createRes.json();
  createdIds.push(saved.id);

  const getOther = await fetch(`${baseUrl}/api/timetables/${saved.id}`, {
    headers: { Authorization: `Bearer ${student2Token}` },
  });
  const icsOther = await fetch(`${baseUrl}/api/timetables/${saved.id}/calendar.ics`, {
    headers: { Authorization: `Bearer ${student2Token}` },
  });
  const delOther = await fetch(`${baseUrl}/api/timetables/${saved.id}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${student2Token}` },
  });
  assert.equal(getOther.status, 404);
  assert.equal(icsOther.status, 404);
  assert.equal(delOther.status, 404);

  // Owner can still download .ics
  const icsOwn = await fetch(`${baseUrl}/api/timetables/${saved.id}/calendar.ics`, {
    headers: { Authorization: `Bearer ${student1Token}` },
  });
  assert.equal(icsOwn.status, 200);
  assert.match(icsOwn.headers.get("content-type"), /text\/calendar/);
  const icsText = await icsOwn.text();
  assert.match(icsText, /BEGIN:VCALENDAR/);
});

test("S11: rate limiter returns 429 and ignores spoofed X-Forwarded-For", async () => {
  process.env.RATE_LIMIT_MAX = "5";
  for (let i = 0; i < 5; i++) {
    const r = await fetch(`${baseUrl}/api/timetables`, {
      headers: { Authorization: `Bearer ${student1Token}` },
    });
    assert.equal(r.status, 200);
  }
  const blocked = await fetch(`${baseUrl}/api/timetables`, {
    headers: {
      Authorization: `Bearer ${student1Token}`,
      "X-Forwarded-For": "9.9.9.9",
    },
  });
  assert.equal(blocked.status, 429);
  const body = await blocked.json();
  assert.equal(body.error.code, "RATE_LIMIT_EXCEEDED");
});

test("S12: async section-changed consumer marks affected saved timetable as stale", async () => {
  const createRes = await fetch(`${baseUrl}/api/timetables`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${student1Token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name: "Event Watch Plan", sectionIds: ["101", "202"] }),
  });
  assert.equal(createRes.status, 201);
  const saved = await createRes.json();
  createdIds.push(saved.id);
  assert.equal(saved.stale, false);

  const res = await consumerHandler({
    Records: [{ body: JSON.stringify({ detail: { sectionId: "101" } }) }],
  });
  assert.ok(res.processed >= 1);

  const getAfter = await fetch(`${baseUrl}/api/timetables/${saved.id}`, {
    headers: { Authorization: `Bearer ${student1Token}` },
  });
  assert.equal(getAfter.status, 200);
  const updated = await getAfter.json();
  assert.equal(updated.stale, true);
});
