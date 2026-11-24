// One JSON object per line, because that is what CloudWatch Logs Insights can
// query. The log line is also the reason there is no request-body logging
// anywhere in this service: a log is a copy of the data that survives every
// deletion policy.

import { config } from './config.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, fatal: 50 };
const threshold = LEVELS[config.logLevel] ?? LEVELS.info;

function emit(level, fields) {
  if (LEVELS[level] < threshold) return;
  const line = {
    level,
    time: new Date().toISOString(),
    service: config.serviceName,
    ...fields,
  };
  const out = JSON.stringify(line);
  if (level === 'error' || level === 'fatal') process.stderr.write(out + '\n');
  else process.stdout.write(out + '\n');
}

export const log = {
  debug: (fields) => emit('debug', fields),
  info: (fields) => emit('info', fields),
  warn: (fields) => emit('warn', fields),
  error: (fields) => emit('error', fields),
  fatal: (fields) => emit('fatal', fields),
};
