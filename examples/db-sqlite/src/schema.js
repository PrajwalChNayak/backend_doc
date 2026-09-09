/**
 * One schema, used by both drivers. Each driver gets its own file on disk so the
 * two halves of the API cannot interfere with each other.
 *
 * Notes that matter:
 *  - SQLite does NOT enforce foreign keys unless you turn them on, per connection:
 *    `PRAGMA foreign_keys = ON`. It is off by default for backwards compatibility.
 *  - WAL (`PRAGMA journal_mode = WAL`) lets readers run while a writer holds the
 *    write lock. It is a persistent property of the database file, so you only
 *    have to set it once, but setting it every boot is harmless.
 *  - `busy_timeout` makes a blocked writer wait instead of throwing SQLITE_BUSY
 *    immediately. Without it, concurrent writes surface as random 500s.
 */

export const DDL = `
CREATE TABLE IF NOT EXISTS users (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  email      TEXT    NOT NULL UNIQUE,
  name       TEXT    NOT NULL,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS posts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title      TEXT    NOT NULL,
  body       TEXT    NOT NULL DEFAULT '',
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS posts_user_id_idx ON posts(user_id);
`

/**
 * Columns a client is allowed to sort by. Identifiers cannot be bound as
 * parameters in SQL, so the only safe way to accept a client-supplied sort
 * column is to check it against a fixed allow-list first. See listUsers() in
 * each store for the one interpolation this example permits.
 */
export const SORTABLE_USER_COLUMNS = new Set(['id', 'email', 'name', 'created_at'])
