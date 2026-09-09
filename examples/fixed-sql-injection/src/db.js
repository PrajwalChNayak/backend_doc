/**
 * Identical schema and seed data to examples/vulnerable-sql-injection, on
 * purpose: the ONLY thing that differs between the two examples is how queries
 * are built. Everything an attacker could reach is still here — the fix is not
 * "hide the data", it is "the query cannot be subverted".
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
