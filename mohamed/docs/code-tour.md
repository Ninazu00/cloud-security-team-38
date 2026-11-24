# Code tour — catalogue service

A guided read of everything in `mohamed/src/` and `mohamed/db/`, in the order that makes
it click. Nothing here is longer than it needs to be; every layer is small because it only
answers one question.

Read in this order: **one request's journey** (below), then `config → logger → db → errors`,
then `app → server`, then `auth/` (passwords → keystore → tokens → sessions → middleware →
service → controller), then `models → routes → controllers → services`, then the schema.

---

## 1. One request's journey

`GET /readyz` from inside a container:

```
ALB health check
  → node: src/server.js listens on :3000
  → src/app.js: request-id middleware mints or validates an id
  → src/app.js: express.json() parses (here: no body)
  → src/routes/health.js: router matches GET /readyz → readiness
  → src/controllers/health.controller.js: calls the service, maps ok → 200
  → src/services/health.service.js: calls db.ping(1000)
  → src/db.js: SELECT 1 against Postgres, raced with a 1 s timeout
  ← {ok: true, ms: 2}
  ← 200 {"status":"ready","db":"ok","ms":2} + x-request-id
  → src/app.js: on res 'finish', one JSON log line
```

Nothing in that path is longer than a screen. That is the point of the layering.

---

## 2. `src/config.js` — fail at boot, not at 3 a.m.

```js
function required(name) {
  const value = process.env[name];
  if (!value) fatal(`${name} is required`);
  return value;
}
```

Environment is read **once**, validated, frozen. A missing `DATABASE_URL` cannot reach
production as a `500` on the first request: the process exits with a JSON line that names
the variable, and the platform restarts it (which is what you want — a task that cannot
work should never report healthy).

Two numbers live here that look arbitrary and are not:

| Setting | Value | Why that value |
|---|---|---|
| `dbPoolMax` | 5 | tasks × pool must stay under the database's connection limit. 4 tasks × 5 = 20. |
| `dbQueryTimeoutMs` | 3000 | a query slower than this is a bug or a deadlock, not "slow". |
| `readyTimeoutMs` | 1000 | the ALB gives up at 3 s; the probe must answer first. |

## 3. `src/logger.js` — one JSON object per line

```js
function line(level, msg, extra) {
  return JSON.stringify({ level, time: new Date().toISOString(), service, msg, ...extra });
}
```

CloudWatch Logs Insights queries structured lines (`fields @timestamp, status | filter
level = "error"`); it cannot query prose. Printing `console.log('user', id, 'failed')`
gives you a line you can only read with your eyes.

**Never put a password, token, or request body in here.** That rule is why the access log
records method, path, status and duration only.

## 4. `src/db.js` — one pool, two helpers

```js
export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: config.dbPoolMax,
  connectionTimeoutMillis: config.dbConnectTimeoutMs,
  idleTimeoutMillis: 30_000,
  application_name: config.serviceName,
});
```

- **One pool per process**, exported. Creating a pool per request is the classic way to
  exhaust Postgres connections under load.
- `application_name` shows up in `pg_stat_activity`, so "who is holding 20 connections" is
  a query, not a guess.
- `pg.types.setTypeParser(20, ...)` — Postgres returns `bigint` as a **string** to avoid
  precision loss; we convert to `Number` once, centrally, instead of sprinkling `Number()`
  through the code.

Three helpers carry the rest of the service:

```js
export function query(text, params)   { /* one statement, no transaction */ }
export async function ping(timeoutMs) { /* SELECT 1, raced with a timeout */ }
export async function withTransaction(fn) { /* BEGIN → fn(client) → COMMIT/ROLLBACK */ }
```

`ping` is what `/readyz` calls. `query` is the default for models: most calls are a single
`select` or `update`, and wrapping one statement in BEGIN/COMMIT is two extra round trips
that imply an atomicity nobody asked for. `withTransaction` is for the cases that genuinely
need "all of it or none of it" — the import, the room-overlap check, and the failure counter
(which reads a row `for update` and then writes it).

**TLS is decided by the connection string, not by the hostname.** An earlier version
sniffed the host and turned TLS on for anything that wasn't `localhost` — which broke the
moment the app ran in a container and reached Postgres at `host.docker.internal`, because
plain local Postgres does not speak TLS and answered *"The server does not support SSL
connections"*. Neon hands out a URL with `?sslmode=require`; `pg` honours it. One rule,
no guessing.

## 5. `src/errors.js` — one error shape for the whole API

```js
export class ApiError extends Error {
  constructor(status, code, message, details) { … }
}
export const badRequest = (code, message, details) => new ApiError(400, code, message, details);
```

Every failure the API can produce is `{"error":{"code","message","requestId","details"?}}`.
The client branches on `code` (stable, part of the contract) and never on `message`
(human text, allowed to be reworded). That is why the contract's error tables list codes
and why `400 INVALID_TOKEN` covers unknown, expired, used and wrong-purpose tokens alike:
the caller must not learn which one it was.

## 6. `src/app.js` — everything that is not a route

Four things happen here, in order:

**a. Request id** — accepted from the caller only if it looks like an id:

```js
const INBOUND = /^[A-Za-z0-9._-]{8,64}$/;
req.id = INBOUND.test(req.get('x-request-id') ?? '') ? req.get('x-request-id') : randomUUID();
```

A header cannot inject a newline into a log line (HTTP forbids it), but it can inject spaces,
quotes or a 4-character string that collides with another request. The regex makes an id
either trustworthy or replaced.

**b. Access log on `finish`**, not on request start: you want the status code and the
duration, and those only exist at the end.

**c. Body limit**

```js
app.use(express.json({ limit: '100kb' }));
```

The JSON parser rejects over-size bodies *before* a handler allocates anything, and the
error handler turns its `entity.too.large` into `413 PAYLOAD_TOO_LARGE`. This is the same
defence the import gets at 2 MB — but per route, later.

**d. The 404 and the error handler.** Any unmatched `/api` path returns the envelope, not
Express's HTML page. A 4-argument middleware is Express's error handler; it maps three
known cases and degrades everything else to `500 INTERNAL` **with the stack logged and not
returned**.

## 7. `src/server.js` — the only file that owns the process

`server.js` owns `listen`, the shutdown sequence and the pool teardown:

```js
server.close(async () => { await closePool(); process.exit(0); });
forceTimer = setTimeout(() => process.exit(1), 10_000).unref();
```

On `SIGTERM` (what ECS sends before killing a task) the server stops accepting, finishes
in-flight requests, closes the pool, exits. The 10 s timer is the escape hatch for a
connection that will not drain — `unref()` so it never keeps the process alive by itself.

There is deliberately no second transport. The service is a container: `app.js` stays free
of `listen` so routes are testable on an ephemeral port, but the process that serves them
exists once. (An earlier `lambda.js` + `serverless-http` wrapper was removed — see the note
in `docs/11` if probe A3 ever forces the API Gateway fallback.)

## 8. `src/routes/` — a table of URLs

```js
healthRouter.get('/healthz', liveness);
healthRouter.get('/readyz', readiness);
```

No logic. Reading this file tells you every endpoint the service has, and nothing else.

## 9. `src/controllers/` — HTTP in, HTTP out

```js
export async function readiness(_req, res) {
  const result = await checkReadiness();
  if (result.ok) return res.status(200).json({ status: 'ready', db: 'ok', ms: result.ms });
  res.status(503).json({ status: 'not_ready', db: 'unreachable', ms: result.ms });
}
```

A controller may read `req`, pick a status, and build a body. It may not run SQL and may
not contain a rule. The moment a rule lives here it can only be reached through HTTP — and
the overlap rule needs to be reachable from three places.

## 10. `src/services/` — where the rules live

```js
export async function checkReadiness() {
  return ping(config.readyTimeoutMs);
}
```

Small now, and it will be where the interesting code goes: `assertRoomFree`,
`parseCsvFile`, `issueAccessToken`. These are plain functions over plain data — no `req`,
no `res` — which is what makes the room-clash race testable without a network.

## 11. `src/models/` — the only layer that knows table names

`users.model.js` is the first and only member so far. The rule: SQL and row shapes here,
decisions elsewhere — it exports `findByEmail`, `findById`, `recordFailedAttempt`,
`clearFailures`, `setPasswordHash`, `createVerified`, and never `login()`. Each method is one
statement through `query`, except `recordFailedAttempt`, which reads a row `for update` and
then writes it and therefore needs the transaction it is given.

## 12. `db/schema.sql` — eight tables, two ideas

**Archive, never delete.** `courses`, `sections` carry `archived_at`. Every uniqueness rule
that answers "is this code taken?" is a *partial* index:

```sql
create unique index sections_course_code_live_key
  on sections (course_id, upper(section_code))
  where archived_at is null;
```

Archiving "A" frees the code; restoring into a taken code fails with `409
SECTION_CODE_TAKEN`; the archived row still resolves for anyone who picked it. A plain
`UNIQUE` would have forbidden reuse forever — one typo, one dead code.

**Time is wall-clock.** `section_times.start_time` is `time`, not `timestamptz`. A 09:00
class stays at 09:00 across a DST change; the timetable is an agreement between people,
not an instant. `day_of_week` is `0..6` with **0 = Sunday**, matching JavaScript's
`getDay()` and the CSV column, so no layer has to translate.

Other deliberate choices:

| Choice | Reason |
|---|---|
| `lower(email)` unique index | two addresses differing only in case are one mailbox; a second account would split it |
| `sessions.family_id` | reuse detection: a rotated token revokes its whole family |
| `auth_tokens` separate from `sessions` | "revoke every session" and "burn this link" are different operations |
| `email_outbox.payload` holds values, never a rendered body or a token | a database dump must not yield working reset links |
| `imports` partial unique on `content_hash where status='committed'` | the same file commits once, but a failed attempt never blocks a retry |
| `check (start_time < end_time)` | a block that ends before it starts is a data-entry bug, caught by the table |

The one invariant SQL cannot express — *no two sections in one room at one time* — is
enforced in the service layer under a per-room advisory lock. A `CHECK` sees only its own
row, a `UNIQUE` cannot compare ranges, and an `EXCLUDE` would need `room` denormalised into
`section_times`. The comment next to the table says so, so nobody adds a half-version.

## 13. `db/verify_invariants.sql` — prove, do not assume

Ten checks inside one transaction that ends in `ROLLBACK`, so it is safe to run against a
live dev database:

```bash
docker exec -i class-tt-postgres psql -U class_tt -d catalogue \
  -v ON_ERROR_STOP=1 < db/verify_invariants.sql
```

Each check tries to do something illegal and records whether Postgres refused. Two failed
on the first run, and both were **my test being wrong**, which is the useful part:

- the back-to-back check queried a section an earlier check had archived;
- the `updated_at` check compared before/after inside one transaction — but `now()` is the
  *transaction* start time, so the column legitimately does not change within it.

## 14. `tests/health.test.js` — seven tests over real HTTP

`node:test`, no framework, `app.listen(0)` for an ephemeral port. They assert the things
that are easy to regress: `/healthz` answers without a database, the request id is echoed
or replaced, unknown `/api` paths return the envelope rather than HTML, malformed JSON is
`400 MALFORMED_JSON`, and a 100 KB+ body is `413 PAYLOAD_TOO_LARGE`.

One test was wrong, not the code: I tried to forge `x-request-id` with an embedded
newline, and `fetch` refused to send the header at all (`Headers.append: "…" is an invalid
header value`). The test now uses HTTP-legal but unusable values — a space, one character,
an empty string.

## 15. Dockerfile

- multi-stage: dependencies installed in a builder, only the result copied forward;
- `USER node` — the process is not root inside the container;
- `HEALTHCHECK` hits `/healthz` (not `/readyz`: the container runtime restarts a wedged
  process, it does not route traffic);
- exec-form `CMD ["node", "src/server.js"]` — with shell form, `node` runs as a *child* of
  `sh`, `SIGTERM` reaches the shell instead of node, and the 10 s grace period is spent on
  a process that never got the signal.

## 16. When you doubt it, run this

```bash
npm test                                       # 7 tests, no database needed
curl -s localhost:3000/healthz                 # {"status":"ok"}
curl -s localhost:3000/readyz                  # 200 with db up, 503 with it down
docker stop class-tt-postgres && curl -si localhost:3000/readyz | head -1
docker start class-tt-postgres && curl -si localhost:3000/readyz | head -1
```
