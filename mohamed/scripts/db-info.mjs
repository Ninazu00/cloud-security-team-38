// Print what is actually in the database DATABASE_URL points at.
//
//   node scripts/db-info.mjs
//
// Answers the two questions people ask before a demo: "is the schema there?" and
// "what rows can I show?". It never prints a password, and it counts only - no
// row contents, so it is safe to screenshot.

import pg from 'pg';

const TABLES = [
  ['users', 'accounts'],
  ['sessions', 'refresh sessions'],
  ['auth_tokens', 'verify / reset links'],
  ['email_outbox', 'queued mail'],
  ['courses', 'courses'],
  ['sections', 'sections'],
  ['section_times', 'time blocks'],
  ['imports', 'CSV import history'],
];

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}

const parsed = new URL(connectionString);
const where = `${parsed.hostname}${parsed.pathname}`;
const tls = (parsed.searchParams.get('sslmode') ?? '').startsWith('verify') ? 'verified' : 'unverified';

const client = new pg.Client({ connectionString, application_name: 'class-tt-info' });

try {
  await client.connect();

  const { rows: version } = await client.query("select split_part(version(), ' on ', 1) as v");
  const { rows: tables } = await client.query(
    `select table_name from information_schema.tables
      where table_schema = 'public' order by table_name`,
  );
  const present = tables.map((row) => row.table_name);

  console.log(`server    ${version[0].v}`);
  console.log(`database  ${where}`);
  console.log(`tls       ${tls}`);
  console.log(`tables    ${present.length} (${present.join(', ')})`);
  console.log('');

  for (const [table, label] of TABLES) {
    if (!present.includes(table)) {
      console.log(`  ${label.padEnd(20)} -`);
      continue;
    }
    const { rows } = await client.query(`select count(*)::int as n from ${table}`);
    console.log(`  ${label.padEnd(20)} ${rows[0].n}`);
  }

  if (present.includes('courses')) {
    const { rows } = await client.query(
      `select code, title, archived_at is not null as archived,
              (select count(*)::int from sections s
                where s.course_id = c.id and s.archived_at is null) as live_sections
         from courses c order by created_at limit 20`,
    );
    if (rows.length > 0) {
      console.log('');
      console.log('  courses:');
      for (const row of rows) {
        console.log(`    ${row.code.padEnd(10)} ${row.title.padEnd(32)} ${row.live_sections} section(s)${row.archived ? '  [archived]' : ''}`);
      }
    }
  }
} catch (error) {
  console.error(`failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
