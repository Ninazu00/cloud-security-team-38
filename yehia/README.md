# Timetable Service — Yehia Mohamed (248678)

One of the three services in the **Class Timetable Builder** (Group 38). This service owns clash detection, clash-free timetable generation, student saved timetables, stale-schedule tracking on catalogue changes, and `.ics` calendar export. It never mints production identities and never mutates the course catalogue—it verifies RS256 Bearer JWTs issued by the Catalogue & Accounts service and reacts asynchronously to section updates.

- **API contract:** `docs/api-contract.md` — 8 HTTP endpoints + 1 EventBridge/SQS consumer.
- **Status:** Complete end-to-end in standalone/mock mode (19/19 unit & security tests passing, deployed to Floci Lambda + API Gateway HTTP API v2.0 + DynamoDB + SQS + EventBridge + S3 static frontend).

## Layout

```text
yehia/
  src/
    app.js                Express app: security headers, CORS, JSON parsing, mounts routes. No listen.
    server.js             Local & container entrypoint: listens on :3002.
    lambda.js             Serverless entrypoint: wraps app.js with serverless-http for API Gateway v2.0.
    consumer.js           SQS Lambda entrypoint: flags affected saved timetables as stale on section changes.
    routes/
      timetables.js       URL table + auth/RBAC middleware bindings only. No business logic, no DB calls.
    controllers/
      timetables.js       HTTP in / HTTP out: validates inputs, calls domain/clients/db, picks status codes.
    domain/
      clash.js            Pure wall-clock interval overlap detector. No Express, no AWS SDK.
      generator.js        Backtracking clash-free timetable generator with conflict diagnostics (422).
      ics.js              RFC 5545 text/calendar (.ics) serializer for saved timetables.
    clients/
      sectionsClient.js   Fetches section definitions (local fixtures/sections.json in mock mode; HTTP later).
    db/
      awsConfig.js        Shared AWS SDK v3 client factory (DynamoDB, SQS, EventBridge) pointed at Floci/AWS.
      timetablesRepo.js   DynamoDB data access for timetables and the section_timetables reverse index.
    middleware/
      auth.js             RS256 JWT verification, role checks (student/admin), and owner scoping.
      security.js         CSP, X-Content-Type-Options, X-Frame-Options, Referrer-Policy, and CORS allowlist.
      logger.js           Structured request logging without leaking tokens or payloads.
  frontend/
    index.html            Static shell, CSP-safe (no inline scripts or inline event handlers).
    css/style.css         Plain CSS weekly Sun–Thu grid and sidebar layout.
    js/config.js          Auto-switches API base URL between Local Express (:3002) and Floci API Gateway (:4566).
    js/app.js             Vanilla JS client using createElement/textContent only (zero innerHTML).
  infra/
    iam/                  Least-privilege Lambda execution policy and trust policy JSON.
    deploy-floci.sh       Packages lambda.zip and deploys API + Consumer Lambdas, API Gateway, and SQS mapping.
    deploy-frontend-floci.sh  Syncs frontend/ to Floci S3 with explicit text/css and text/javascript MIME types.
  scripts/
    setup-aws.js          Provisions DynamoDB tables, SQS queue, EventBridge rule, and CloudWatch LogGroup.
    mint-token.js         Dev-only RS256 keypair generator + 2-hour JWT minter (student/admin).
    zip-lambda.js         Builds lambda.zip while strictly excluding .env and *.pem private keys.
    floci-check.js        Connectivity smoke check against local Floci.
  tests/
    unit/domain.test.js   Pure unit tests for clash detection, generation, 422 conflicts, and .ics output.
    security/security.test.js  RBAC, JWT tamper/expiry, ownership isolation, and input validation tests.
  fixtures/
    sections.json         Mock course sections (courses 1, 2, 3 valid; 1 + 4 forces 422 NO_VALID_TIMETABLE).
  docs/                   API contract.
  evidence/               Postman collection for reproducible endpoint verification.
  Dockerfile              Non-root Node 24 Alpine production image.
```

## Layering

One direction only—each layer calls only the layer below it:

```text
routes -> controllers -> domain / clients / db -> (DynamoDB / Catalogue API)
```

| Layer | May do | Must not do | Why the rule exists |
| --- | --- | --- | --- |
| `routes/` | Map method + path to middleware and a controller | Logic, DB queries, response shaping | Keeps the route surface and RBAC rules auditable in one file |
| `controllers/` | Parse `req`, call domain/clients/repo, pick HTTP status | Overlap math, raw DynamoDB expressions | Keeps HTTP concerns separate from scheduling algorithms |
| `domain/` | Pure clash math, backtracking search, `.ics` formatting | Know about `req`/`res`, DynamoDB, or HTTP | Allows fast, deterministic unit testing with zero cloud dependencies |
| `clients/` | Fetch section schedules from fixture or Catalogue service | Persist timetables or enforce HTTP auth | Makes the swap from mock fixtures to live Catalogue API a one-file change |
| `db/` | DynamoDB `Get`/`Put`/`Query`/`Update`/`Delete` | Business rules, HTTP status decisions | Isolates table names, partition keys, and AWS SDK shapes |

## Data model & event flow

`scripts/setup-aws.js` provisions two DynamoDB tables plus an asynchronous invalidation pipeline:

- **`timetables`** — Stores each student's saved timetables (`studentId`, `timetableId`, `name`, `sectionIds`, `stale`, timestamps). Every read and delete is scoped to the authenticated caller's `sub` claim so students can never view or delete another student's schedule.
- **`section_timetables`** — Reverse lookup table mapping `sectionId -> (studentId, timetableId)`. Instead of running an expensive full-table scan when a course time changes, the SQS consumer queries only the timetables that actually reference the modified `sectionId` and marks them `stale: true`.
- **EventBridge → SQS → `timetable-section-consumer`** — Rule `catalogue-section-changed` routes section change events to queue `timetable-section-events`, which triggers `src/consumer.js` to flip `stale = true`. When the student next opens the UI or calls `GET /api/timetables/:id`, the stale badge and any `missingSectionIds` appear immediately.

## Endpoints

| Method & Path | Role | Behavior |
| --- | --- | --- |
| `GET /api/health` | `admin` | Service health check (`200` for admin, `403` for student) |
| `POST /api/timetables/check` | `student`, `admin` | Checks `{ sectionIds }` and returns `{ hasClashes, clashes }` |
| `POST /api/timetables/generate` | `student`, `admin` | Generates clash-free options for `{ courseIds }`, or `422` with `conflictingCourseIds` & `conflictingPairs` |
| `POST /api/timetables` | `student`, `admin` | Saves `{ name, sectionIds }` for the authenticated user (`201`) |
| `GET /api/timetables` | `student`, `admin` | Lists the caller's saved timetables with `stale` boolean |
| `GET /api/timetables/:id` | `student`, `admin` | Returns hydrated timetable (`sections`, `missingSectionIds`, `stale`) |
| `GET /api/timetables/:id/calendar.ics` | `student`, `admin` | Downloads RFC 5545 `text/calendar` schedule |
| `DELETE /api/timetables/:id` | `student`, `admin` | Deletes a saved timetable and cleans up `section_timetables` index entries (`204`) |

## Run it

### Local Express + Tests

```bash
cp .env.example .env          # once
npm install
npm test                      # 19/19 unit & security tests
npm start                     # http://localhost:3002
```

### Container

```bash
docker build -t class-tt/timetable:dev .
docker run -p 3002:3002 --env-file .env class-tt/timetable:dev
```

### Full Serverless Stack on Floci (`:4566`)

```bash
# 1. Provision DynamoDB, SQS, EventBridge, and CloudWatch LogGroup
node scripts/setup-aws.js

# 2. Build lambda.zip and deploy API + Consumer Lambdas + API Gateway v2.0
bash infra/deploy-floci.sh

# 3. Export the printed API_URL and deploy static frontend to Floci S3
export API_URL="http://<id>.execute-api.localhost.floci.io:4566"
bash infra/deploy-frontend-floci.sh

# 4. Mint dev RS256 tokens (2-hour TTL) for testing
node scripts/mint-token.js student-1 student
node scripts/mint-token.js admin-1 admin
```

Open `http://localhost:4566/timetable-frontend/index.html` (or run `npx http-server frontend -p 8080 -c-1` for local Express mode on `http://localhost:8080`).

## Security & conventions enforced

- **Asymmetric JWT verification (RS256):** Validates signatures against a public key only (`src/middleware/auth.js`); private keys are never bundled into `lambda.zip` or committed to Git.
- **Role & ownership enforcement:** Admin-only health check (`403` for students); all saved-timetable operations are strictly scoped to the JWT `sub` claim (prevents IDOR).
- **Least-privilege IAM:** `infra/iam/timetable-policy.json` grants only the DynamoDB, SQS, and CloudWatch Logs actions required by `timetable-api` and `timetable-section-consumer`.
- **Hardened HTTP headers & CORS:** Responses include `Content-Security-Policy`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy`, and an explicit origin allowlist (`CORS_ORIGINS`).
- **XSS- & CSP-safe frontend:** All dynamic DOM nodes are built with `document.createElement` and `textContent` (`innerHTML` is never used), with zero inline `<script>` or `onclick=` handlers.
- **Non-root container:** `Dockerfile` runs on `node:24-alpine` with production dependencies only (`npm ci --omit=dev`) under the unprivileged `node` user.

## Next

- Wire `src/middleware/auth.js` to Mohamed's live JWKS / RS256 public key endpoint once Accounts goes live.
- Point `src/clients/sectionsClient.js` from `fixtures/sections.json` to the live Course Catalogue service URL and verify the exact EventBridge `catalogue-section-changed` payload schema.
- Frontend UI polish pass: dark mode toggle, increased 1-hour grid row height so room labels never clip, and an inline SVG favicon.
