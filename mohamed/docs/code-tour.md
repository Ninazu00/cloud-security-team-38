# Code tour

A reading order, so the next person (or me in two weeks) does not have to start at
the top of the folder.

## What happens to one request

A browser asks for `GET /api/courses?limit=5` with a bearer token.

1. `src/app.js` gives it a request id, then the security and CORS headers.
2. The router in `src/routes/courses.js` matches the path. That file only maps
   URLs to handlers.
3. `src/controllers/courses.controller.js` reads `req`, asks the service, and picks
   the status code.
4. `src/services/courses.service.js` checks the rules and calls the model.
5. `src/models/courses.model.js` writes the SQL and turns rows into objects.
6. The response goes out through the controller, and the access log is written by
   `app.js` when the response finishes. If anything threw an `ApiError`, the error
   handler in `app.js` turns it into `{"error":{...}}`.

Nothing calls upward. A service never sees `req`, and a model never decides a
status code.

## Reading order

**`src/config.js`** reads the environment once, freezes it, and exits if something
required is missing. Failing at boot is better than failing on the first request
that happens to need the missing value.

**`src/logger.js`** writes one JSON object per line, because CloudWatch Logs
Insights wants JSON. It never writes a file and has no dependencies.

**`src/db.js`** holds the pool and two helpers. `query()` is for single
statements. `withTransaction()` runs a function with a client, sets
`lock_timeout` and `statement_timeout` for that transaction only, commits if the
function returns, and rolls back if it throws. The timeouts are set with
`set_config(..., true)` so they cannot leak onto a connection that goes back into
the pool.

**`src/errors.js`** has `ApiError` and the helpers that build one. Anything that
is not an `ApiError` is a bug, so it becomes a flat 500 with the detail going to
the log and not to the client.

**`src/app.js`** is everything that is not a route: request ids, the access log,
the 100 KB JSON cap, static files, the 404 fallthrough, and the error handler.
**`src/server.js`** is the only file that owns the process: it unseals the key,
listens, starts the mailer, and shuts down on a signal.

## Identity, in the order it was built

**`src/auth/passwords.js`** — Argon2id through `crypto.argon2`, which Node 24
ships, so there is no native module to compile. The stored value is a PHC string
(`argon2id$v=19$m=19456,t=2,p=1$salt$tag`). `verifyPassword` returns
`{ok, needsRehash, reason}` instead of throwing, because a malformed row is a data
problem, not a crash.

**`src/auth/keystore.js`** — gets the sealed key from Secrets Manager, asks KMS to
decrypt it, and publishes the public half. It refuses to start in production
without KMS, deliberately, so a misconfigured task fails loudly instead of signing
with some file on disk.

**`src/auth/tokens.js`** — RS256 tokens on `node:crypto`, no JWT library. There
are two objects: `createTokenService` can sign and verify, `createTokenVerifier`
can only verify, and that is what the other services get.

**`src/auth/sessions.js`** — refresh tokens. Only the SHA-256 is stored, each use
rotates the token, and a family of tokens can be revoked together. A reuse
outside the 30-second grace window revokes the whole family, and that revocation
is committed **after** the rollback, otherwise the transaction would undo it and
the answer would say "revoked" while the token still worked.

**`src/auth/middleware.js`** — `requireAuth` checks the signature and nothing else.
`requireRole` re-reads the role from the database, because a token can be two
hours old and a demoted admin should not keep admin rights until it expires.

**`src/email/`** — templates, a SES sender, and a worker that drains the outbox
table every couple of seconds. The token is minted when the mail is sent, not when
it is queued, so a copy of the outbox contains no working links.

## The catalogue

**`src/services/courses.service.js`** — validation plus archive semantics: a code
change is refused while the course still has live sections, and delete means
archive.

**`src/services/sections.service.js`** — the room rule. Two blocks clash when they
are on the same day and `a.start < b.end && b.start < a.end`, which makes
back-to-back times legal. `src/models/sections.model.js` holds the query, and it
takes a lock on the room before searching, because the row that would conflict
does not exist yet and `SELECT ... FOR UPDATE` cannot lock nothing.

**`src/services/imports.service.js`** and **`src/imports/csv.js`** — the parser is
pure and knows no SQL; the service applies the plan inside one transaction. Every
row error is collected, and any error means nothing is written. The file's SHA-256
is a unique key among committed imports, so the same file cannot land twice.

## The frontend

`frontend/assets/api.js` is the only module that talks HTTP. The access token is
kept in memory, never in `localStorage`, and a 401 triggers one refresh and one
retry. `frontend/assets/session.js` handles restore, sign-in and the top bar.
Each page has its own module next to it. No build step, no framework, no inline
script, because the CSP forbids it.

## Database

`db/schema.sql` is eight tables. Two ideas run through it: archive instead of
delete, and wall-clock times for class blocks. `db/verify_invariants.sql` tries to
break each constraint, records PASS or FAIL, and rolls back.

## Tests

`tests/*.test.js` use `node:test` and drive real HTTP against a real Postgres, so
they catch the things a mocked unit test would miss. Each file uses its own code
prefix (`CRS`, `SEC`, `IMP`) because the files run in parallel against one
database and used to delete each other's rows. Without `DATABASE_URL` the database
tests skip instead of failing.

## Deploy

`deploy/deploy.sh` creates the cluster, task definition, service, load balancer,
roles and log group, then checks `/healthz` and `/readyz` through the load
balancer. It is safe to run twice. `deploy/README.md` explains the two emulator
quirks (the shared listener port and the local-image trick).

## When in doubt

```bash
npm test                                   # full suite
node --check src/app.js                    # syntax only, no run
psql "$DATABASE_URL" -c '\d sections'      # what the table really looks like
docker compose -f infra/floci/docker-compose.yml ps
aws logs tail /class-tt/catalogue --follow # what the deployed task is saying
```
