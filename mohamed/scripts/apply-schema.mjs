// Apply db/schema.sql to whatever DATABASE_URL points at.
//
//   node scripts/apply-schema.mjs                 # apply, refuse if tables exist
//   node scripts/apply-schema.mjs --check         # report only, change nothing
//   node scripts/apply-schema.mjs --force         # apply even if tables exist
//
// Why a script and not `psql -f`: psql is not installed everywhere (it is not on
// this machine outside the container), and the schema has to land either wholly
// or not at all. One transaction gives that for free - a half-applied schema is
// worse than none, because the error you get afterwards is "column does not
// exist" in the middle of a request.
//
// The whole file is sent as a single simple query. That is safe here because the
// file is ours and contains no parameters; it is not a pattern to copy for SQL
// that touches user input.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const SCHEMA_PATH = fileURLToPath(new URL('../db/schema.sql', import.meta.url));

const TABLES = [
  'users',
  'sessions',
  'auth_tokens',
  'email_outbox',
  'courses',
  'sections',
  'section_times',
  'imports',
];

const args = new Set(process.argv.slice(2));
const checkOnly = args.has('--check');
const force = args.has('--force');

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is not set. Point it at the database you want to prepare.');
  process.exit(1);
}

/** Never print the whole connection string: it carries the password. */
function describe(url) {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    database: parsed.pathname.replace(/^\//, '') || '(default)',
    tls: parsed.searchParams.get('sslmode') ?? (parsed.hostname === 'localhost' ? 'off' : 'default'),
    pooled: parsed.hostname.includes('-pooler'),
  };
}

async function existingTables(client) {
  const { rows } = await client.query(
    `select table_name from information_schema.tables
      where table_schema = 'public' and table_name = any($1::text[])
      order by table_name`,
    [TABLES],
  );
  return rows.map((row) => row.table_name);
}

const client = new pg.Client({ connectionString, application_name: 'class-tt-migrate' });

try {
  await client.connect();
  const target = describe(connectionString);
  const { rows: version } = await client.query('select version()');
  console.log(`connected  ${target.host}/${target.database}  tls=${target.tls}${target.pooled ? '  (pooled)' : ''}`);
  console.log(`server     ${version[0].version.split(' on ')[0]}`);

  const present = await existingTables(client);
  if (present.length > 0 && !force && !checkOnly) {
    console.error(`refusing to apply: ${present.length} of ${TABLES.length} tables already exist (${present.join(', ')}).`);
    console.error('use --check to inspect, or --force if you really mean to re-run.');
    process.exitCode = 1;
  } else if (checkOnly) {
    const missing = TABLES.filter((t) => !present.includes(t));
    console.log(`schema     ${present.length}/${TABLES.length} tables present${missing.length ? ` - missing: ${missing.join(', ')}` : ' - complete'}`);
    process.exitCode = missing.length === 0 ? 0 : 2;
  } else {
    const sql = await readFile(SCHEMA_PATH, 'utf8');
    const started = Date.now();
    await client.query('begin');
    await client.query(sql);
    await client.query('commit');

    const after = await existingTables(client);
    const { rows: objects } = await client.query(
      `select
         (select count(*) from pg_indexes where schemaname = 'public') as indexes,
         (select count(*) from pg_trigger where not tgisinternal) as triggers,
         (select count(*) from pg_constraint where connamespace = 'public'::regnamespace) as constraints`,
    );
    console.log(`applied    ${after.length}/${TABLES.length} tables in ${Date.now() - started} ms`);
    console.log(`objects    ${objects[0].indexes} indexes · ${objects[0].triggers} triggers · ${objects[0].constraints} constraints`);
  }
} catch (error) {
  // A failed transaction leaves nothing behind; say what broke plainly.
  console.error(`failed     ${error.message}`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
