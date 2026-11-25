import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import jwt from "jsonwebtoken";
import {
  normalizeSection,
  getSectionsByCourseIds,
  getSectionsByIds,
} from "../../src/clients/sectionsClient.js";
import { generateTimetables } from "../../src/domain/generator.js";
import { findClashes } from "../../src/domain/clash.js";
import { requireAuth, clearPublicKeyCache } from "../../src/middleware/auth.js";

test("normalizeSection preserves times[], type, sectionCode, and Fri/Sat days", () => {
  const normalized = normalizeSection({
    id: 42,
    course: { id: "1", code: "CS401", title: "Cloud Security" },
    sectionCode: "G1",
    type: "LECTURE",
    archivedAt: null,
    times: [
      { dayOfWeek: "SUNDAY", startTime: "09:00:00", endTime: "10:30:00" },
      { dayOfWeek: "FRIDAY", startTime: "11:00:00", endTime: "12:30:00" },
      { dayOfWeek: "SATURDAY", startTime: "13:00:00", endTime: "14:30:00" },
    ],
  });

  assert.deepEqual(normalized, {
    id: "42",
    courseId: "1",
    courseCode: "CS401",
    courseTitle: "Cloud Security",
    sectionCode: "G1",
    type: "lecture",
    status: "ACTIVE",
    times: [
      { day: "Sun", start: "09:00", end: "10:30" },
      { day: "Fri", start: "11:00", end: "12:30" },
      { day: "Sat", start: "13:00", end: "14:30" },
    ],
  });
});

test("normalizeSection detects archived sections via archivedAt", () => {
  const archived = normalizeSection({
    id: "s1",
    course: { id: "1" },
    sectionCode: "G1",
    type: "lab",
    archivedAt: "2026-11-25T10:00:00.000Z",
    times: [{ dayOfWeek: "Mon", startTime: "11:00", endTime: "12:30" }],
  });
  assert.equal(archived.status, "ARCHIVED");
});

test("getSectionsByIds does NOT send limit or page query params", async () => {
  const prevMode = process.env.DEP_MODE;
  const prevFetch = globalThis.fetch;
  process.env.DEP_MODE = "live";
  process.env.CATALOGUE_URL = "http://mock-catalogue.local";

  let capturedUrl = null;
  globalThis.fetch = async (url) => {
    capturedUrl = new URL(String(url));
    return {
      ok: true,
      json: async () => ({
        items: [
          {
            id: "42",
            course: { id: "1", code: "CS401", title: "Cloud Security" },
            sectionCode: "G1",
            type: "lecture",
            archivedAt: null,
            times: [{ dayOfWeek: "Sun", startTime: "09:00", endTime: "10:30" }],
          },
        ],
      }),
    };
  };

  try {
    const sections = await getSectionsByIds(["42", "43"], "Bearer tok");
    assert.equal(capturedUrl.searchParams.get("ids"), "42,43");
    assert.equal(capturedUrl.searchParams.has("limit"), false);
    assert.equal(capturedUrl.searchParams.has("page"), false);
    assert.equal(sections.length, 1);
    assert.equal(sections[0].times[0].day, "Sun");
  } finally {
    globalThis.fetch = prevFetch;
    process.env.DEP_MODE = prevMode;
  }
});

test("getSectionsByCourseIds paginates, filters archivedAt, and generator picks lecture + lab + tutorial", async () => {
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
            {
              id: "lec-1",
              course: { id: "1", code: "CS401", title: "Cloud Security" },
              sectionCode: "L1",
              type: "lecture",
              archivedAt: null,
              times: [
                { dayOfWeek: "Sun", startTime: "09:00", endTime: "10:30" },
                { dayOfWeek: "Tue", startTime: "09:00", endTime: "10:30" },
              ],
            },
            {
              id: "lab-archived",
              course: { id: "1", code: "CS401", title: "Cloud Security" },
              sectionCode: "LAB-OLD",
              type: "lab",
              archivedAt: "2026-11-20T00:00:00Z",
              times: [{ dayOfWeek: "Wed", startTime: "09:00", endTime: "10:30" }],
            },
          ],
          totalPages: 2,
        }),
      };
    }
    return {
      ok: true,
      json: async () => ({
        items: [
          {
            id: "lab-clash",
            course: { id: "1", code: "CS401", title: "Cloud Security" },
            sectionCode: "LAB1",
            type: "lab",
            archivedAt: null,
            times: [{ dayOfWeek: "Tue", startTime: "09:30", endTime: "11:00" }],
          },
          {
            id: "lab-ok",
            course: { id: "1", code: "CS401", title: "Cloud Security" },
            sectionCode: "LAB2",
            type: "lab",
            archivedAt: null,
            times: [{ dayOfWeek: "Fri", startTime: "10:00", endTime: "11:30" }],
          },
          {
            id: "tut-ok",
            course: { id: "1", code: "CS401", title: "Cloud Security" },
            sectionCode: "T1",
            type: "tutorial",
            archivedAt: null,
            times: [{ dayOfWeek: "Sat", startTime: "12:00", endTime: "13:00" }],
          },
        ],
        totalPages: 2,
      }),
    };
  };

  try {
    const sections = await getSectionsByCourseIds(["1"], "Bearer tok");
    assert.equal(requestedUrls.length, 2);
    assert.equal(sections.some((s) => s.id === "lab-archived"), false);

    const generated = generateTimetables(["1"], sections);
    assert.equal(generated.ok, true);
    assert.equal(generated.timetables.length, 1);
    const chosen = generated.timetables[0].sections;
    assert.deepEqual(
      chosen.map((s) => `${s.type}:${s.id}`).sort(),
      ["lab:lab-ok", "lecture:lec-1", "tutorial:tut-ok"]
    );
    assert.equal(findClashes(chosen).length, 0);
  } finally {
    globalThis.fetch = prevFetch;
    process.env.DEP_MODE = prevMode;
  }
});

test("requireAuth validates JWT issuer class-tt, audience class-tt, and allowed roles", async () => {
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
  process.env.JWT_ISSUER = "class-tt";
  process.env.JWT_AUDIENCE = "class-tt";

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
      issuer: "class-tt",
      audience: "class-tt",
    });
    const wrongIss = jwt.sign({ sub: "u1", role: "student" }, privateKey, {
      algorithm: "RS256",
      issuer: "other-iss",
      audience: "class-tt",
    });
    const wrongAud = jwt.sign({ sub: "u1", role: "student" }, privateKey, {
      algorithm: "RS256",
      issuer: "class-tt",
      audience: "other-aud",
    });
    const badRole = jwt.sign({ sub: "u1", role: "guest" }, privateKey, {
      algorithm: "RS256",
      issuer: "class-tt",
      audience: "class-tt",
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
