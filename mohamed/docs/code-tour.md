# Where the code lives

A short tour, in the order a request travels.

## The edge

`src/server.js` starts everything: it unseals the signing key (KMS, or a local
file in development), builds the app, listens, starts the mailer and shuts down
cleanly on a signal. If the key cannot be unsealed it throws, because a task that
cannot sign tokens should not be healthy.

`src/app.js` assembles the middleware in order: request id, logger, security
headers, CORS, body parsers, the probe guard, the routers, the static files, then
the 404 and the error handler. The probe guard is built after auth in
`server.js` and passed in ready-made, because it asks whether the caller is on a
private address.

`src/config.js` reads the environment once, validates it and freezes the result.
A missing `DATABASE_URL` stops the process at startup instead of failing on the
first request.

## The layer cake

```
routes/       URL and method, nothing else
controllers/  read the request, call a service, write the response
services/     the rules; no HTTP objects here
models/       SQL and the row shape
db.js         the pool and withTransaction
```

`withTransaction` is the only place that opens and closes a transaction, and it
rolls back on any throw. Two things inside it are easy to miss: the timeouts are
set per transaction with `set_config`, and a session family revocation is
committed outside the transaction that detected the reuse, so a rollback cannot
undo it.

## Identity

- `auth/passwords.js`: Argon2id through Node's own `crypto.argon2`. It refuses a
  cost above the ceiling before deriving, so a tampered hash cannot make the
  server burn a second of CPU per login. It reports `needsRehash` when the stored
  parameters are below the current ones.
- `auth/keystore.js`: loads the signing key from one of three places (a KMS
  secret, a secret id read through KMS, or a local file in development) and
  publishes the public JWKS. It knows nothing about the AWS SDK; the caller
  injects two small functions.
- `auth/tokens.js`: two halves. `createTokenService` signs, `createTokenVerifier`
  checks. The verifier takes only the published keys, so a service that verifies
  cannot mint. Validation order is algorithm, then `kid`, then signature, then
  `iss`, `aud`, `exp` with a 60 second skew.
- `auth/sessions.js`: refresh tokens are opaque, stored as SHA-256, and grouped
  into families. A rotated token has a 30 second grace so a browser retrying a
  request does not lose its session, and a token used after that grace is treated
  as stolen: the whole family is revoked and the client gets 410.
- `auth/middleware.js`: `requireAuth` verifies the signature and attaches
  `{ id, role }`; `requireRole` re-reads the role from the database on every
  guarded request, because a token can be hours old.
- `auth/action-tokens.js` and `auth/turnstile.js`: single-use email tokens
  (minted when the mail is sent, not when the request arrives) and the Cloudflare
  check, which fails closed.

## Catalogue

- `services/courses.service.js`: archive instead of delete, restore on request,
  keyset pagination, and the "code is taken" rule that only looks at live rows.
- `services/sections.service.js`: the overlap rule. Inside the insert
  transaction it takes `pg_advisory_xact_lock(hashtext('room:' || room))` and
  then asks whether any live section in that room overlaps the half-open range
  `[start, end)`. The lock makes the check and the insert one step.
- `services/imports.service.js` and `imports/csv.js`: the parser is pure and
  returns rows plus errors; the service writes every row in one transaction,
  records the attempt even when it rolls back, and refuses a file whose SHA-256
  is already in the committed rows.

## Mail

`email/templates.js` holds the three messages. `email/worker.js` claims rows from
`email_outbox` with `for update skip locked` and retries with a backoff; a
failure is recorded on the row, not thrown at the request. `email/sender.js` is
SES in production and a capture sender in development, so tests never send mail.

## HTTP details

- `http/rate-limit.js`: a sliding window per client, 60 requests a minute by
  default, kept in memory. It is explicitly disabled in the test helper.
- `http/cors.js`: an allow-list from `CORS_ORIGINS`, credentials on, never `*`.
- `http/pagination.js`: opaque cursors, so a client cannot ask for page 10,000
  and make the database count.
- `http/upload.js`: `multer` in memory with a 2 MB cap, then a content check, so
  a CSV never touches the disk.

## Frontend

No framework. `assets/api.js` keeps the access token in memory (never in
localStorage), retries one 401 through a single-flight refresh, and turns 401
into a redirect to the sign-in page. `assets/session.js` reads what the page
needs from the token and hides admin controls, which is convenience only: the
server checks the role again. Each page has one module next to it in
`frontend/assets/`.

## Tests

`tests/` runs `node:test` against a real Postgres and the real Express app
through `tests/no-rate-limit.js`, which turns the limiter off and seeds a
namespace per run. Nothing is mocked except SES, Cloudflare and KMS, which are
passed in as small functions.
