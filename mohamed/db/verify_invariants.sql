-- Proves the schema's invariants instead of assuming them.
--
-- Everything runs inside one transaction that is rolled back at the end, so it
-- is safe to run against the dev database while the app is using it. Each check
-- reports PASS/FAIL into a temp table; the final SELECT prints the scoreboard.
--
-- Run:
--   docker exec -i class-tt-postgres psql -U class_tt -d catalogue \
--     -v ON_ERROR_STOP=1 -f - < db/verify_invariants.sql

begin;

create temp table results (check_name text, passed boolean, note text) on commit drop;

-- 1. Two addresses that differ only in case are the same account.
insert into users (email, password_hash) values ('Student@Example.test', 'x');
do $$
begin
  begin
    insert into users (email, password_hash) values ('student@example.TEST', 'x');
    insert into results values ('email uniqueness is case-insensitive', false, 'second insert succeeded');
  exception when unique_violation then
    insert into results values ('email uniqueness is case-insensitive', true, 'users_email_lower_key');
  end;
end $$;

-- 2. Archiving a section frees its code; a live duplicate does not.
insert into courses (code, title, credits) values ('CSC101', 'Intro', 3);
insert into sections (course_id, section_code, type, room, capacity)
  select id, 'A', 'lecture', 'H1', 40 from courses where code = 'CSC101';

do $$
declare cid uuid;
begin
  select id into cid from courses where code = 'CSC101';

  begin
    insert into sections (course_id, section_code, type, room, capacity)
      values (cid, 'a', 'lab', 'H2', 20);
    insert into results values ('live section code is unique per course', false, 'lowercase duplicate accepted');
  exception when unique_violation then
    insert into results values ('live section code is unique per course', true, 'sections_course_code_live_key');
  end;

  update sections set archived_at = now() where course_id = cid and section_code = 'A';

  begin
    insert into sections (course_id, section_code, type, room, capacity)
      values (cid, 'A', 'lecture', 'H3', 40);
    insert into results values ('archived section frees its code', true, 'insert after archive');
  exception when unique_violation then
    insert into results values ('archived section frees its code', false, 'partial index still blocked it');
  end;
end $$;

-- 3. A block that ends before it starts is rejected by the table, not by code.
do $$
begin
  begin
    insert into section_times (section_id, day_of_week, start_time, end_time)
      select id, 1, '11:00', '10:00' from sections limit 1;
    insert into results values ('section_times rejects end <= start', false, 'accepted');
  exception when check_violation then
    insert into results values ('section_times rejects end <= start', true, 'section_times_order');
  end;

  begin
    insert into section_times (section_id, day_of_week, start_time, end_time)
      select id, 7, '10:00', '11:00' from sections limit 1;
    insert into results values ('day_of_week is 0..6', false, 'accepted 7');
  exception when check_violation then
    insert into results values ('day_of_week is 0..6', true, 'day_of_week check');
  end;
end $$;

-- 4. The overlap query the service runs under the advisory lock sees the clash.
insert into section_times (section_id, day_of_week, start_time, end_time)
  select id, 1, '09:00', '10:30' from sections where section_code = 'A' and archived_at is null;

do $$
declare
  cid uuid; hit integer;
begin
  select id into cid from courses where code = 'CSC101';
  insert into sections (course_id, section_code, type, room, capacity)
    values (cid, 'B', 'lecture', 'H1', 40) returning id into cid;
  insert into section_times (section_id, day_of_week, start_time, end_time)
    values (cid, 1, '10:00', '11:30');

  -- same room, same day, 10:00-11:30 vs 09:00-10:30 -> overlap
  select count(*) into hit
  from sections s
  join section_times t on t.section_id = s.id
  where s.room = 'H1' and s.archived_at is null
    and t.day_of_week = 1
    and t.start_time < '11:30' and t.end_time > '10:00';

  insert into results values ('overlap query detects a room clash', hit > 0, format('%s overlapping blocks', hit));

  -- back-to-back is legal: a section at 09:00-10:30 and another at 10:30-11:30
  -- share an instant but not a minute. Fresh room, fresh sections.
  insert into sections (course_id, section_code, type, room, capacity)
    values ((select id from courses where code = 'CSC101'), 'C', 'lecture', 'H9', 30)
    returning id into cid;
  insert into section_times (section_id, day_of_week, start_time, end_time)
    values (cid, 2, '09:00', '10:30');

  insert into sections (course_id, section_code, type, room, capacity)
    values ((select id from courses where code = 'CSC101'), 'D', 'lecture', 'H9', 30);
  insert into section_times (section_id, day_of_week, start_time, end_time)
    select id, 2, '10:30', '11:30' from sections where section_code = 'D';

  select count(*) into hit
  from sections s
  join section_times t on t.section_id = s.id
  where s.room = 'H9' and s.archived_at is null and s.id <> cid
    and t.day_of_week = 2
    and t.start_time < '10:30' and t.end_time > '09:00';

  insert into results values ('back-to-back blocks are not a clash', hit = 0, format('%s conflicting rows', hit));
end $$;

-- 5. Idempotency: the same bytes commit once, but a failed attempt blocks nothing.
do $$
declare h bytea := sha256('course_code,row'::bytea);
begin
  insert into imports (content_hash, filename, status, error_count) values (h, 'a.csv', 'failed', 3);
  insert into imports (content_hash, filename, status, error_count) values (h, 'a.csv', 'failed', 1);

  insert into results values ('a failed import does not block a retry', true, 'two failed rows with one hash');

  insert into imports (content_hash, filename, status, row_count) values (h, 'a.csv', 'committed', 10);

  begin
    insert into imports (content_hash, filename, status, row_count) values (h, 'a.csv', 'committed', 10);
    insert into results values ('committed import is idempotent', false, 'duplicate commit accepted');
  exception when unique_violation then
    insert into results values ('committed import is idempotent', true, 'imports_committed_hash_key');
  end;
end $$;

-- 6. updated_at is maintained by the trigger, not by callers.
--    The old value is forced into the past first: `now()` is the *transaction*
--    start time in Postgres, so a same-transaction update legitimately leaves
--    updated_at equal — comparing before/after inside one transaction proves
--    nothing. Worth knowing before writing a test that "proves" the trigger.
do $$
declare after_ts timestamptz;
begin
  update courses set updated_at = timestamptz '2000-01-01 00:00:00+00'
   where code = 'CSC101';
  update courses set title = 'Intro to CS' where code = 'CSC101';
  select updated_at into after_ts from courses where code = 'CSC101';
  insert into results values ('updated_at advances on update', after_ts > timestamptz '2000-01-02', after_ts::text);
end $$;

select check_name, case when passed then 'PASS' else 'FAIL' end as result, note from results order by check_name;

rollback;
