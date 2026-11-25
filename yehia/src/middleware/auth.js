import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import jwt from "jsonwebtoken";
import { logEvent } from "./logger.js";

const cachedKeys = new Map();
let cachedDefaultKey = null;

function getAllowedRoles() {
  return new Set(
    (process.env.JWT_ALLOWED_ROLES || "student,admin")
      .split(",")
      .map((r) => r.trim().toLowerCase())
      .filter(Boolean)
  );
}

function resolveJwksUrl() {
  if (process.env.CATALOGUE_JWKS_URL) return process.env.CATALOGUE_JWKS_URL;
  if (process.env.CATALOGUE_PUBLIC_KEY_URL) return process.env.CATALOGUE_PUBLIC_KEY_URL;
  const baseUrl = (process.env.CATALOGUE_URL || "http://127.0.0.1:3001").replace(/\/$/, "");
  return `${baseUrl}/.well-known/jwks.json`;
}

async function getPublicKey(kid) {
  if ((process.env.DEP_MODE || "mock") === "mock") {
    if (cachedDefaultKey) return cachedDefaultKey;
    const pubPath = path.join(process.cwd(), "local-public.pem");
    if (!fs.existsSync(pubPath)) {
      throw new Error("local-public.pem not found. Run: node scripts/mint-token.js");
    }
    cachedDefaultKey = fs.readFileSync(pubPath, "utf8");
    return cachedDefaultKey;
  }

  if (kid && cachedKeys.has(kid)) return cachedKeys.get(kid);
  if (!kid && cachedDefaultKey) return cachedDefaultKey;

  const url = resolveJwksUrl();
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch public key (${res.status})`);
  const text = await res.text();

  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed.keys)) {
      for (const jwk of parsed.keys) {
        if (jwk.kty !== "RSA") continue;
        const keyObj = crypto.createPublicKey({ key: jwk, format: "jwk" });
        if (jwk.kid) cachedKeys.set(jwk.kid, keyObj);
        if (!cachedDefaultKey) cachedDefaultKey = keyObj;
      }
      const matched = kid ? cachedKeys.get(kid) : cachedDefaultKey;
      if (!matched) throw new Error(`No matching JWK found for kid=${kid || "default"}`);
      return matched;
    }
    cachedDefaultKey = parsed.publicKey || parsed.key || text;
  } catch (err) {
    if (err.message.startsWith("No matching JWK")) throw err;
    cachedDefaultKey = text;
  }

  return cachedDefaultKey;
}

export function clearPublicKeyCache() {
  cachedKeys.clear();
  cachedDefaultKey = null;
}

export async function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  if (!header.startsWith("Bearer ")) {
    logEvent("warn", "AUTH_MISSING_TOKEN", { path: req.originalUrl, statusCode: 401 });
    return res.status(401).json({
      error: { code: "UNAUTHORIZED", message: "Missing or invalid Authorization header" },
    });
  }

  const token = header.slice(7).trim();
  const isLive = (process.env.DEP_MODE || "mock") === "live";
  const verifyOptions = { algorithms: ["RS256"] };
  const issuer = process.env.JWT_ISSUER || (isLive ? "catalogue-service" : undefined);
  const audience = process.env.JWT_AUDIENCE || (isLive ? "timetable-service" : undefined);
  if (issuer) verifyOptions.issuer = issuer;
  if (audience) verifyOptions.audience = audience;

  let payload;
  try {
    const decoded = jwt.decode(token, { complete: true });
    const kid = decoded?.header?.kid;
    const publicKey = await getPublicKey(kid);
    payload = jwt.verify(token, publicKey, verifyOptions);
    if (!payload.sub || !payload.role) {
      throw new Error("Missing required claims");
    }
  } catch (err) {
    logEvent("warn", "AUTH_INVALID_TOKEN", {
      path: req.originalUrl,
      statusCode: 401,
      reason: err.name || err.message,
    });
    return res.status(401).json({
      error: { code: "UNAUTHORIZED", message: "Invalid or expired token" },
    });
  }

  const normalizedRole = String(payload.role).trim().toLowerCase();
  if (!getAllowedRoles().has(normalizedRole)) {
    logEvent("warn", "AUTH_ROLE_NOT_ALLOWED", {
      path: req.originalUrl,
      statusCode: 403,
      userId: String(payload.sub),
      role: normalizedRole,
    });
    return res.status(403).json({
      error: { code: "FORBIDDEN", message: "Role not permitted for timetable service" },
    });
  }

  req.user = { id: String(payload.sub), role: normalizedRole };
  req.authHeader = header;
  return next();
}

export function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== "admin") {
    logEvent("warn", "AUTH_FORBIDDEN", {
      path: req.originalUrl,
      statusCode: 403,
      userId: req.user?.id,
    });
    return res.status(403).json({
      error: { code: "FORBIDDEN", message: "Administrator role required" },
    });
  }
  return next();
}
