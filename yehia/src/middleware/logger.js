import { getAwsClientConfig } from "../db/awsConfig.js";
import {
  CloudWatchLogsClient,
  CreateLogStreamCommand,
  PutLogEventsCommand,
} from "@aws-sdk/client-cloudwatch-logs";

const cw = new CloudWatchLogsClient(getAwsClientConfig());

const LOG_GROUP = process.env.LOG_GROUP_NAME || "/timetable-service/app";
const LOG_STREAM = `instance-${Date.now()}`;
let streamReady = false;

const REDACTED_KEYS = new Set(["authorization", "token", "password", "secret", "jwt"]);

function sanitize(obj = {}) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (REDACTED_KEYS.has(k.toLowerCase())) continue;
    out[k] = v;
  }
  return out;
}

async function shipToCloudWatch(entry) {
  if (process.env.DISABLE_CW_LOGS === "true") return;
  try {
    if (!streamReady) {
      await cw.send(new CreateLogStreamCommand({ logGroupName: LOG_GROUP, logStreamName: LOG_STREAM }));
      streamReady = true;
    }
    await cw.send(
      new PutLogEventsCommand({
        logGroupName: LOG_GROUP,
        logStreamName: LOG_STREAM,
        logEvents: [{ timestamp: Date.now(), message: JSON.stringify(entry) }],
      })
    );
  } catch {
    // Logging must never break an API request
  }
}

export function logEvent(level, event, details = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    service: "timetable-service",
    level,
    event,
    ...sanitize(details),
  };
  if (process.env.NODE_ENV !== "test") {
    console.log(JSON.stringify(entry));
    void shipToCloudWatch(entry);
  }
}
