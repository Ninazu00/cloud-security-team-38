import fs from "node:fs";
import path from "node:path";
import jwt from "jsonwebtoken";
import { logEvent } from "./logger.js";

let cachedPublicKey = null;

async function getPublicKey() {
  if (cachedPublicKey) return cachedPublicKey;

  if ((process.env.DEP_MODE || "mock") === "mock") {
    const pubPath = path.join(process.cwd(), "local-public.pem");
    if (!fs.existsSync(pubPath)) {
      throw new Error("local-public.pem not found. Run: node scripts/mint-token.js");
    }
    cachedPublicKey = fs.readFileSync(pubPath, "utf8");
    return cachedPublicKey;
  }

  const url = process.env.CATALOGUE_PUBLIC_KEY_URL;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch public key (${res.status})`);
  const text = await res.text();
  try {
    const parsed = JSON.parse(text);
    cachedPublicKey = parsed.publicKey || parsed.key || text;
  } catch {
    cachedPublicKey = text;
  }
  return cachedPublicKey;
}

export function clearPublicKeyCache() {
  cachedPublicKey = null;
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
  try {
    const publicKey = await getPublicKey();
    const payload = jwt.verify(token, publicKey, { algorithms: ["RS256"] });
    if (!payload.sub || !payload.role) {
      throw new Error("Missing required claims");
    }
    req.user = { id: String(payload.sub), role: String(payload.role) };
    req.authHeader = header;
    return next();
  } catch (err) {
    logEvent("warn", "AUTH_INVALID_TOKEN", {
      path: req.originalUrl,
      statusCode: 401,
      reason: err.name,
    });
    return res.status(401).json({
      error: { code: "UNAUTHORIZED", message: "Invalid or expired token" },
    });
  }
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
