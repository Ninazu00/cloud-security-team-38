# Catalogue & Accounts — Mohamed Ayman (239236)

One of the three services in the Class Timetable Builder. This service owns the
course catalogue and the system's identity: it is the only service that decides who
a caller is, and the only one that issues tokens.

- **API contract:** [`docs/api-contract.md`](docs/api-contract.md) — v1.4 FINAL, 27 endpoints in eight groups. Yehia and Mohab code against it.
- **Status:** skeleton running (health, error envelope, logging, container image). No domain endpoints yet.

## Layout

```
mohamed/
  src/
    app.js        Express app: middleware, mounts routes, error handling. No listen, no signals.
    server.js     Container entrypoint: listen, graceful shutdown, pool teardown.
    config.js     Env parsing, validated once at boot.
    logger.js     One JSON object per line (CloudWatch Logs Insights can query it).
    db.js         pg pool, readiness ping, transaction helper.
    errors.js     ApiError + the single error envelope.
    routes/       URL table only. No logic, no SQL.
    controllers/  HTTP in / HTTP out: read req, choose a status, shape the body.
    services/     Business rules: overlap engine, CSV validator, token issuing.
    models/       SQL and row shapes. The only layer that knows table names.
  tests/          node:test suite, real HTTP against an ephemeral port.
  docs/           API contract.
  db/             schema.sql, invariant checks.
```

## Layering

One direction only, and each layer may call only the one below it:

```
routes -> controllers -> services -> models -> (pg)
```

| Layer | May do | Must not do | Why the rule exists |
|---|---|---|---|
| `routes/` | map a URL and method to a controller | anything else | keeps the endpoint list readable in one file |
| `controllers/` | read `req`, pick a status, build `res` | SQL, business rules | a rule that lives here cannot be reused or unit-tested |
| `services/` | enforce rules, orchestrate models | know about `req`/`res` | the importer, `PATCH` and the demo all call the same rule |
| `models/` | SQL, row → object mapping | decisions, HTTP | one place where column names exist |

`services/health.service.js` is the worked example: it asks the database whether it
can serve, and returns `{ok, ms}`; the controller turns that into `200`/`503`; the
route is a one-line binding.

## Data model

`db/schema.sql` creates eight tables — `users`, `sessions`, `auth_tokens`,
`email_outbox`, `courses`, `sections`, `section_times`, `imports` — and two ideas
run through all of them:

- **Archive, never delete.** Every uniqueness rule that answers "is this code taken?"
  filters to live rows, so archiving a section frees its code while its history
  survives.
- **Time is wall-clock, not an instant.** `section_times` stores `time` on purpose:
  a 09:00 class stays at 09:00 across a DST change.

The one invariant SQL cannot express — two sections in one room at one time — is
enforced in the service layer under a per-room advisory lock, and
`db/verify_invariants.sql` proves each constraint actually bites:

```bash
docker exec -i class-tt-postgres psql -U class_tt -d catalogue \
  -v ON_ERROR_STOP=1 < db/verify_invariants.sql   # 10 PASS, rolled back
```


## Run it

The database and the cloud emulator come from the project's local stack
(`infra/floci/docker-compose.yml` in the parent workspace — floci on :4566, Floci Dash
on :4500, Postgres on :5433).

```bash
cp .env.example .env          # once
npm install
npm run dev                   # http://localhost:3000/healthz
npm test
```

Container:

```bash
docker build -t class-tt/catalogue:dev .
docker run -p 3000:3000 -e DATABASE_URL=... class-tt/catalogue:dev
```

## Health endpoints

| Endpoint | Question | Wired to | Failure means |
|---|---|---|---|
| `GET /healthz` | is the process alive? | container health check → **restart** | the process is wedged |
| `GET /readyz` | can this task serve traffic? | ALB target-group check → **out of rotation, no restart** | the database is unreachable |

They are deliberately different. A database outage makes `/readyz` answer `503` while
`/healthz` keeps answering `200`, so the platform drains the task instead of
restarting it in a loop:

```
DATABASE_URL unreachable ->  /healthz 200  /readyz 503   (drain)
process crashed          ->  (no answer)                 (restart)
```

## Conventions already enforced

- Every non-2xx response is `{"error":{"code","message","requestId"[,"details"]}}`; clients branch on `code`.
- Every response carries `x-request-id`; an inbound one is accepted only if it matches `^[A-Za-z0-9._-]{8,64}$`, so a header cannot forge a log line.
- Request logs carry method, path, status, duration and the id — never the body, never a header.
- JSON bodies are capped at 100 KB (`413 PAYLOAD_TOO_LARGE`), and invalid JSON is `400 MALFORMED_JSON`, before any handler runs.
- `trust proxy` is on, so rate limiting and audit lines see the client address, not the load balancer's.

## Next

Block C of the plan: schema (`db/schema.sql`), then identity — argon2id, RS256 + `kid`,
the JWKS endpoint, the KMS-sealed signing key, and the first endpoints
(`/api/auth/register` …).
