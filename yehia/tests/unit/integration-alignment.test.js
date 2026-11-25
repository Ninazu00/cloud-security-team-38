import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import jwt from "jsonwebtoken";
import { normalizeSection, getSectionsByCourseIds } from "../../src/clients/sectionsClient.js";
import { requireAuth, clearPublicKeyCache } from "../../src/middleware/auth.js";

test("normalizeSection maps Mohamed live Catalogue fields to canonical shape", () => {
  const normalized = normalizeSection({
    id: 42,
    course: { id: "CS401", code: "CS401", title: "Cloud Security" },
    sectionNumber: "G1",
    dayOfWeek: "SUNDAY",
    startTime: "09:00:00",
    endTime: "10:30:00",
    location: "B-204",
    instructor: "Dr. Ahmed",
    status: "active",
  });

  assert.deepEqual(normalized, {
    id: "42",
    courseId: "CS401",
    courseCode: "CS401",
    courseTitle: "Cloud Security",
    sectionNumber: "G1",
    day: "Sun",
    start: "09:00",
    end: "10:30",
    room: "B-204",
    instructor: "Dr. Ahmed",
    status: "ACTIVE",
  });
});

test("normalizeSection marks archived sections with status ARCHIVED", () => {
  const fromBool = normalizeSection({
    id: "s1",
    course: { id: "c1" },
    dayOfWeek: "Mon",
    startTime: "11:00",
    endTime: "12:30",
    archived: true,
  });
  assert.equal(fromBool.status, "ARCHIVED");
});

test("getSectionsByCourseIds follows Catalogue pagination and filters archived sections", async () => {
  const prevMode = process.env.DEP_MODE;
  const prevFetch = globalThis.fetch;
  process.env.DEP_MODE = "live";
  process.env.CATALOGUE_URL = "http://mock-catalogue.local";

  const requestedUrls = [];
  globalThis.fetch = async (url) => {
    requestedUrls.push(String(url));
    const page = new URL(url).searchParams.get("page");
    if (page === "1") {
      return {
        ok: true,
        json: async () => ({
          items: [
            { id: "s1", course: { id: "c1" }, dayOfWeek: "Sun", startTime: "09:00:00", endTime: "10:00:00", status: "ACTIVE" },
            { id: "s2", course: { id: "c1" }, dayOfWeek: "Mon", startTime: "09:00:00", endTime: "10:00:00", status: "ARCHIVED" },
          ],
          totalPages: 2,
        }),
      };
    }
    return {
      ok: true,
      json: async () => ({
        items: [
          { id: "s3", course: { id: "c1" }, dayOfWeek: "Tue", startTime: "10:00:00", endTime: "11:30:00", status: "ACTIVE" },
        ],
        totalPages: 2,
      }),
    };
  };

  try {
    const sections = await getSectionsByCourseIds(["c1"], "Bearer tok");
    assert.equal(requestedUrls.length, 2);
    assert.deepEqual(sections.map((s) => s.id), ["s1", "s3"]);
    assert.equal(sections[0].courseId, "c1");
    assert.equal(sections[0].start, "09:00");
  } finally {
    globalThis.fetch = prevFetch;
    process.env.DEP_MODE = prevMode;
  }
});

test("requireAuth validates JWT issuer, audience, and allowed roles", async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

  const pubPath = path.join(process.cwd(), "local-public.pem");
  const hadOriginal = fs.existsSync(pubPath);
  const originalPem = hadOriginal ? fs.readFileSync(pubPath, "utf8") : null;
  fs.writeFileSync(pubPath, publicKey);
  clearPublicKeyCache();

  const prevIss = process.env.JWT_ISSUER;
  const prevAud = process.env.JWT_AUDIENCE;
  const prevMode = process.env.DEP_MODE;
  process.env.DEP_MODE = "mock";
  process.env.JWT_ISSUER = "catalogue-service";
  process.env.JWT_AUDIENCE = "timetable-service";

  const runAuth = (token) =>
    new Promise((resolve) => {
      const req = { headers: { authorization: `Bearer ${token}` }, originalUrl: "/api/timetables" };
      const res = {
        statusCode: 200,
        status(c) { this.statusCode = c; return this; },
        json(b) { resolve({ status: this.statusCode, body: b }); },
      };
      requireAuth(req, res, () => resolve({ status: 200, user: req.user }));
    });

  try {
    const valid = jwt.sign({ sub: "u1", role: "student" }, privateKey, {
      algorithm: "RS256",
      issuer: "catalogue-service",
      audience: "timetable-service",
    });
    const wrongIss = jwt.sign({ sub: "u1", role: "student" }, privateKey, {
      algorithm: "RS256",
      issuer: "evil-issuer",
      audience: "timetable-service",
    });
    const wrongAud = jwt.sign({ sub: "u1", role: "student" }, privateKey, {
      algorithm: "RS256",
      issuer: "catalogue-service",
      audience: "other-service",
    });
    const badRole = jwt.sign({ sub: "u1", role: "guest" }, privateKey, {
      algorithm: "RS256",
      issuer: "catalogue-service",
      audience: "timetable-service",
    });

    assert.equal((await runAuth(valid)).status, 200);
    assert.equal((await runAuth(wrongIss)).status, 401);
    assert.equal((await runAuth(wrongAud)).status, 401);
    assert.equal((await runAuth(badRole)).status, 403);
  } finally {
    if (hadOriginal) fs.writeFileSync(pubPath, originalPem);
    else fs.rmSync(pubPath, { force: true });
    clearPublicKeyCache();
    if (prevIss === undefined) delete process.env.JWT_ISSUER; else process.env.JWT_ISSUER = prevIss;
    if (prevAud === undefined) delete process.env.JWT_AUDIENCE; else process.env.JWT_AUDIENCE = prevAud;
    if (prevMode === undefined) delete process.env.DEP_MODE; else process.env.DEP_MODE = prevMode;
  }
});
