import express from "express";
import cors from "cors";
import { securityHeaders, rateLimiter } from "./middleware/security.js";
import { requireAuth, requireAdmin } from "./middleware/auth.js";
import { logEvent } from "./middleware/logger.js";
import timetableRoutes from "./routes/timetables.js";

const app = express();
app.disable("x-powered-by");

const allowedOrigins = (process.env.CORS_ORIGINS || "http://localhost:8080,http://localhost:4566")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

app.use(securityHeaders);
app.use(
  cors({
    origin(origin, callback) {
      // Allow non-browser clients (curl/Postman/service-to-service) and exact allow-listed origins
      if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
      return callback(null, false);
    },
  })
);
app.use(rateLimiter);

// Request logger: time, method, path only (never logs bodies or tokens)
app.use((req, res, next) => {
  logEvent("info", "HTTP_REQUEST", { method: req.method, path: req.originalUrl });
  next();
});

app.use(express.json({ limit: "16kb" }));

app.get("/api/health", requireAuth, requireAdmin, (req, res) => {
  const runtime = process.env.AWS_LAMBDA_FUNCTION_NAME ? "lambda" : "pc";
  res.status(200).json({
    status: "ok",
    service: "timetable-service",
    environment: process.env.NODE_ENV || "development",
    runtime,
  });
});

app.use("/api/timetables", timetableRoutes);

// 404 fallback (Lab 4 pattern)
app.use((req, res) => {
  res.status(404).json({
    error: { code: "ROUTE_NOT_FOUND", message: "Route not found." },
  });
});

// Central error handler (Lab 4 pattern)
app.use((error, req, res, next) => {
  if (error.type === "entity.parse.failed") {
    return res.status(400).json({
      error: { code: "VALIDATION_ERROR", message: "Request body is not valid JSON." },
    });
  }
  if (error.type === "entity.too.large") {
    return res.status(413).json({
      error: { code: "PAYLOAD_TOO_LARGE", message: "Request body exceeds maximum allowed size." },
    });
  }
  logEvent("error", "INTERNAL_ERROR", { message: error.message });
  return res.status(500).json({
    error: { code: "INTERNAL_ERROR", message: "An unexpected server error occurred." },
  });
});

export default app;
