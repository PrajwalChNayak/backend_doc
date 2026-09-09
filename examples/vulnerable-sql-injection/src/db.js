// !!! DELIBERATELY VULNERABLE — DO NOT COPY !!!
// This file is teaching material for the SQL-injection page. It is intentionally
// exploitable. Never deploy it, never copy its query style. The fixed version
// lives in examples/fixed-sql-injection.

/**
 * The database and seed data, shared (identically) with the fixed example so a
 * before/after diff shows only the query code changing, never the schema.
 *
 * The `secret_token` column stands in for anything you would never want an
 * attacker to read: a password reset token, an API key, a national ID. The
 * whole point of the UNION exploit is to pull this column out through an
 * endpoint that was only ever meant to return usernames.
 */
import Database from 'better-sqlite3'

export function createDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE users (
      id           INTEGER PRIMARY KEY,
      username     TEXT NOT NULL,
      email        TEXT NOT NULL,
      password     TEXT NOT NULL,
      role         TEXT NOT NULL DEFAULT 'user',
      secret_token TEXT NOT NULL
    );
  `)

  const seed = db.prepare(
    'INSERT INTO users (username, email, password, role, secret_token) VALUES (?, ?, ?, ?, ?)',
  )
  seed.run('alice', 'alice@example.com', 'alice-password', 'user', 'tok_alice_9f3a')
  seed.run('bob', 'bob@example.com', 'bob-password', 'user', 'tok_bob_1c77')
  seed.run('carol', 'carol@example.com', 'carol-password', 'user', 'tok_carol_5e21')
  seed.run('admin', 'admin@example.com', 'super-secret-admin-pw', 'admin', 'tok_admin_ROOT')

  return db
}
