import { logEvent } from "./logger.js";

const WINDOW_MS = 60_000;
const requestHits = new Map();

export function securityHeaders(req, res, next) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
  next();
}

export function rateLimiter(req, res, next) {
  const maxRequests = Number(process.env.RATE_LIMIT_MAX) || 60;
  // Ignore spoofed X-Forwarded-For unless explicitly behind our own trusted proxy
  const clientIp = req.socket?.remoteAddress || req.ip || "unknown";
  const now = Date.now();
  const cutoff = now - WINDOW_MS;

  const timestamps = (requestHits.get(clientIp) || []).filter((ts) => ts > cutoff);
  if (timestamps.length >= maxRequests) {
    requestHits.set(clientIp, timestamps);
    logEvent("warn", "SECURITY_ALERT", {
      type: "RATE_LIMIT_EXCEEDED",
      ip: clientIp,
      path: req.originalUrl,
      statusCode: 429,
    });
    return res.status(429).json({
      error: { code: "RATE_LIMIT_EXCEEDED", message: "Too many requests. Try again later." },
    });
  }

  timestamps.push(now);
  requestHits.set(clientIp, timestamps);
  return next();
}

export function resetRateLimiter() {
  requestHits.clear();
}

export function sanitizeText(value) {
  return String(value)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .trim();
}
