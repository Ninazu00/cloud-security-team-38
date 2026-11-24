-- Class Timetable Builder — catalogue service schema
--
-- Everything the contract in docs/api-contract.md promises, and nothing it does
-- not. Two ideas carry most of the design weight:
--
--   1. Rows are archived, never deleted. A section a student picked last week
--      still has to resolve on their timetable, so "gone from the catalogue" and
--      "gone from the database" are different states. Every unique index that
--      answers "is this code taken?" therefore filters to live rows.
--
--   2. The one invariant SQL cannot express here — "no two sections occupy the
--      same room at the same time" — is enforced in the service layer under a
--      per-room advisory lock (docs/07 §5.1). A CHECK constraint cannot see other
--      rows, a UNIQUE constraint cannot compare ranges, and an EXCLUDE constraint
--      would need `room` denormalised into section_times. The comment sits next to
--      the table so nobody adds a half-version of it later.
--
-- Colours (column naming): snake_case here, camelCase on the wire. The mapping
-- lives in models/, not in SQL aliases, so the schema stays plain Postgres.

create extension if not exists pgcrypto;  -- gen_random_uuid()

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------
-- Done in one trigger rather than in every UPDATE statement: a forgotten
-- `updated_at = now()` is invisible until someone sorts by it.
create or replace function set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- users — the system's identity of record
-- ---------------------------------------------------------------------------
-- The other two services never read this table: they verify the JWT this
-- service signs. That is why there is no `email` claim in the token — identity
-- is looked up here, through /api/auth/me, when a client actually needs it.
create table users (
  id                uuid primary key default gen_random_uuid(),
  email             text        not null,
  password_hash     text        not null,      -- argon2id, never returned by any endpoint
  role              text        not null default 'student'
                                check (role in ('student', 'admin')),
  email_verified_at timestamptz,               -- null = the login gate in §1 refuses
  failed_attempts   integer     not null default 0 check (failed_attempts >= 0),
  failed_attempts_at timestamptz,              -- when the current run of failures began
  locked_until      timestamptz,               -- §1 lockout after 5 failures
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- Case-insensitive uniqueness without citext: two addresses that differ only in
-- case are the same mailbox, and letting both register would split an account.
create unique index users_email_lower_key on users (lower(email));

drop trigger if exists users_set_updated_at on users;
create trigger users_set_updated_at before update on users
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- sessions — refresh tokens, in families
-- ---------------------------------------------------------------------------
-- A refresh token is opaque, so only its SHA-256 is stored: a database dump
-- cannot be replayed against the API. `family_id` is what makes reuse detection
-- possible — presenting a rotated token revokes the whole family, so a stolen
-- token cannot outlive the legitimate one by much.
create table sessions (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid        not null references users (id) on delete cascade,
  family_id         uuid        not null,          -- one login = one family
  token_hash        bytea       not null unique,   -- sha256(token), 32 bytes
  created_at        timestamptz not null default now(),
  last_used_at      timestamptz,
  expires_at        timestamptz not null,          -- this token: 7 days
  family_expires_at timestamptz not null,          -- this login: 30 days, no extension
  revoked_at        timestamptz,
  replaced_by_id    uuid references sessions (id) on delete set null,
  replaced_at       timestamptz,                   -- when this token was rotated
  grace_used        boolean     not null default false,  -- the 30 s window, once
  user_agent        text                           -- truncated, for a session list later
);

create index sessions_user_id_idx on sessions (user_id);
create index sessions_expires_at_idx on sessions (expires_at);
create index sessions_family_id_idx on sessions (family_id);

-- ---------------------------------------------------------------------------
-- auth_tokens — single-use links that arrive by email
-- ---------------------------------------------------------------------------
-- Separate from sessions on purpose: "revoke every session" (password reset)
-- and "burn this one link" are different operations, and a reset token must not
-- become a login. `purpose` keeps the three flows from being interchangeable.
create table auth_tokens (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid        not null references users (id) on delete cascade,
  purpose    text        not null
                         check (purpose in ('email_verify', 'password_reset', 'mfa_challenge')),
  token_hash bytea       not null unique,       -- sha256(token)
  expires_at timestamptz not null,              -- 24 h verify, 30 min reset
  consumed_at timestamptz,
  attempts   integer     not null default 0 check (attempts >= 0),
  created_at timestamptz not null default now()
);

create index auth_tokens_user_purpose_idx on auth_tokens (user_id, purpose);

-- ---------------------------------------------------------------------------
-- email_outbox — transactional mail without a queue contract
-- ---------------------------------------------------------------------------
-- A mail is queued in the same transaction as the thing it describes, so a reset
-- that is committed always has a mail and a rolled-back one never does. The
-- payload holds template *values*, never a rendered body and never a token: a
-- dump of this table must not yield working links.
create table email_outbox (
  id              uuid primary key default gen_random_uuid(),
  to_email        text        not null,
  template_key    text        not null,
  payload         jsonb       not null default '{}'::jsonb,
  attempts        integer     not null default 0,
  next_attempt_at timestamptz not null default now(),
  sent_at         timestamptz,
  failed_at       timestamptz,
  last_error      text,
  created_at      timestamptz not null default now()
);

-- The drainer's query, index-shaped: oldest due, unsent, not given up on.
create index email_outbox_due_idx on email_outbox (next_attempt_at)
  where sent_at is null and failed_at is null;

-- ---------------------------------------------------------------------------
-- courses
-- ---------------------------------------------------------------------------
create table courses (
  id          uuid primary key default gen_random_uuid(),
  code        text        not null,             -- e.g. "CSC101"
  title       text        not null,
  credits     smallint    not null check (credits between 0 and 30),
  archived_at timestamptz,                      -- §3: delete is an archive
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Archived courses keep their code: reusing "CSC101" for a different course
-- would silently rewrite history for anyone who took the old one.
create unique index courses_code_key on courses (upper(code));
create index courses_archived_at_idx on courses (archived_at);

-- Keyset paging reads "everything older than this row". The row constructor
-- `(created_at, id) < (?, ?)` can only use an index that matches both columns in
-- this order and direction; without it every page is a full sort.
create index courses_created_at_id_idx on courses (created_at desc, id desc);

drop trigger if exists courses_set_updated_at on courses;
create trigger courses_set_updated_at before update on courses
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- sections
-- ---------------------------------------------------------------------------
create table sections (
  id           uuid primary key default gen_random_uuid(),
  course_id    uuid        not null references courses (id) on delete restrict,
  section_code text        not null,            -- unique *per course*, e.g. "A", "B"
  type         text        not null
                           -- The contract lists exactly three offerings; anything
                           -- else is a value the frontend would have to special-case.
                           check (type in ('lecture', 'lab', 'tutorial')),
  room         text        not null,            -- the column that makes ROOM_CONFLICT possible
  capacity     smallint    not null check (capacity between 1 and 500),
  archived_at  timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- Partial unique: archiving "A" frees the code, restoring into a taken code
-- fails with 409 SECTION_CODE_TAKEN — which is exactly the contract's rule.
create unique index sections_course_code_live_key
  on sections (course_id, upper(section_code))
  where archived_at is null;

create index sections_course_id_idx on sections (course_id);
create index sections_room_live_idx on sections (room) where archived_at is null;

-- Paging the section list is a keyset walk on (created_at desc, id desc); without
-- this index every page is a sort of the whole table.
create index sections_created_at_id_idx on sections (created_at desc, id desc);

drop trigger if exists sections_set_updated_at on sections;
create trigger sections_set_updated_at before update on sections
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- section_times — one row per weekly block
-- ---------------------------------------------------------------------------
-- Wall-clock local time (Africa/Cairo) on purpose: a class at 09:00 stays at
-- 09:00 across a DST change, because the timetable is a human agreement, not an
-- instant in time. Storing timestamptz here would move the class twice a year.
create table section_times (
  id          uuid primary key default gen_random_uuid(),
  section_id  uuid     not null references sections (id) on delete cascade,
  day_of_week smallint not null check (day_of_week between 0 and 6),  -- 0 = Sunday, matches JS getDay()
  start_time  time     not null,
  end_time    time     not null,
  constraint section_times_order check (start_time < end_time)       -- half-open [start, end)
);

-- Two identical blocks in one section is a data-entry bug, not a timetable.
create unique index section_times_unique_block
  on section_times (section_id, day_of_week, start_time, end_time);
create index section_times_lookup_idx on section_times (day_of_week, start_time);

-- The overlap query in §5.1 reads sections by room, joined to times by day:
--   s.room = :room and t.day_of_week = :day
--   and t.start_time < :end and t.end_time > :start
-- and is serialised per room with SELECT pg_advisory_xact_lock(hashtext('room:' || :room)).

-- ---------------------------------------------------------------------------
-- imports — one row per attempted file
-- ---------------------------------------------------------------------------
-- Written twice in the same request: `failed` after a rollback (evidence that
-- something was rejected) or `committed` with the transaction that inserted the
-- rows. The partial unique index is the idempotency key: the same bytes can be
-- committed once, but a failed attempt never blocks a retry.
create table imports (
  id           uuid primary key default gen_random_uuid(),
  content_hash bytea       not null,            -- sha256 of the uploaded file, 32 bytes
  filename     text        not null,
  status       text        not null check (status in ('committed', 'failed')),
  row_count    integer     not null default 0 check (row_count >= 0),
  error_count  integer     not null default 0 check (error_count >= 0),
  report       jsonb,                           -- per-row errors, capped at 100 in responses
  created_by   uuid        references users (id) on delete set null,
  created_at   timestamptz not null default now(),
  committed_at timestamptz                        -- null for a failed import: nothing was committed
);

create unique index imports_committed_hash_key
  on imports (content_hash) where status = 'committed';

create index imports_created_at_idx on imports (created_at desc);
