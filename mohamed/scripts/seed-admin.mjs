// Create an account that can log in immediately.
//
// The contract says registration returns 202 and no token, and that a login is
// gated on a verified address. That combination means a fresh database has no way
// in: nobody can verify an address before there is a mail pipeline, and nobody can
// promote an admin before there is an admin. This script is the way in.
//
//   node --env-file-if-exists=.env scripts/seed-admin.mjs \
//        --email admin@class-tt.local --password 'a long enough password' [--role admin]
//
// Idempotent: re-running with an existing address leaves the row alone and says so.

import { config } from '../src/config.js';
import { closePool, query, withTransaction } from '../src/db.js';
import { createUsersModel } from '../src/models/users.model.js';
import { assertPasswordPolicy } from '../src/auth/passwords.js';

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  return process.argv[index + 1] ?? fallback;
}

const email = arg('email');
const password = arg('password');
const role = arg('role', 'admin');

if (!email || !password) {
  console.error('usage: seed-admin.mjs --email <address> --password <password> [--role admin]');
  process.exit(1);
}

if (role !== 'admin' && role !== 'student') {
  console.error(`role must be admin or student, got ${role}`);
  process.exit(1);
}

// Fail before touching the database: a seeded account whose password the login
// route would reject is worse than no account at all.
assertPasswordPolicy(password);

const users = createUsersModel({ query, withTransaction });

const created = await users.createVerified({ email, password, role });

if (created) {
  console.log(JSON.stringify({ msg: 'user created', id: created.id, email: created.email, role: created.role }));
} else {
  console.log(JSON.stringify({ msg: 'user already exists, left untouched', email }));
}

await closePool();
void config;
