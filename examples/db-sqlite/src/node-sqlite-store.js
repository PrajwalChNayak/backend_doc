/**
 * SQLite through the built-in `node:sqlite` module (Node 22.5+, usable on Node 24).
 *
 * Why you might prefer it: zero dependencies, zero native build, ships with the
 * runtime. Why you might not: it is synchronous only, and the surface is smaller
 * than better-sqlite3 (no `transaction()` helper, no `pluck()`, and so on).
 */
import { DatabaseSync } from 'node:sqlite'
import { DDL, SORTABLE_USER_COLUMNS } from './schema.js'

export function createNodeSqliteStore(filename) {
  const db = new DatabaseSync(filename)

  // Per-connection pragmas. Order matters: turn foreign keys on *outside* a
  // transaction, because SQLite silently ignores the pragma inside one.
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')
  db.exec('PRAGMA busy_timeout = 5000')

  db.exec(DDL)

  // Prepare once, reuse forever. Preparing on every request re-parses the SQL
  // and is the single most common reason a SQLite API is slower than it should be.
  const stmts = {
    // Named parameters. node:sqlite accepts bare keys (`{ email }` binds `:email`).
    insertUser: db.prepare('INSERT INTO users (email, name) VALUES (:email, :name)'),
    // Positional parameters.
    getUser: db.prepare('SELECT id, email, name, created_at FROM users WHERE id = ?'),
    getUserByEmail: db.prepare('SELECT id, email, name, created_at FROM users WHERE email = ?'),
    deleteUser: db.prepare('DELETE FROM users WHERE id = ?'),
    insertPost: db.prepare('INSERT INTO posts (user_id, title, body) VALUES (?, ?, ?)'),
    postsForUser: db.prepare(
      'SELECT id, user_id, title, body, created_at FROM posts WHERE user_id = ? ORDER BY id',
    ),
    countUsers: db.prepare('SELECT COUNT(*) AS n FROM users'),
    ping: db.prepare('SELECT 1 AS ok'),
  }

  return {
    driver: 'node:sqlite',

    health() {
      const row = stmts.ping.get()
      return { ok: row.ok === 1, users: stmts.countUsers.get().n }
    },

    /**
     * The one place this example interpolates anything into SQL. `sort` is an
     * identifier, and identifiers cannot be bound as parameters — so it is
     * checked against a fixed Set first and the request is rejected otherwise.
     * `direction` is mapped through a lookup, never taken from the client verbatim.
     */
    listUsers({ sort = 'id', direction = 'asc', limit = 50 } = {}) {
      if (!SORTABLE_USER_COLUMNS.has(sort)) {
        throw Object.assign(new Error(`unsortable column: ${sort}`), { status: 400 })
      }
      const dir = direction === 'desc' ? 'DESC' : 'ASC'
      // lint-sql:allow sort is validated against SORTABLE_USER_COLUMNS and dir is a literal
      const sql = `SELECT id, email, name, created_at FROM users ORDER BY ${sort} ${dir} LIMIT ?`
      // `limit` is still a value, so it is still bound.
      return db.prepare(sql).all(limit)
    },

    getUser(id) {
      return stmts.getUser.get(id) ?? null
    },

    /** Used by the boot seed to stay idempotent. `email` is bound, not interpolated. */
    getUserByEmail(email) {
      return stmts.getUserByEmail.get(email) ?? null
    },

    createUser({ email, name }) {
      const { lastInsertRowid } = stmts.insertUser.run({ email, name })
      return this.getUser(Number(lastInsertRowid))
    },

    deleteUser(id) {
      return stmts.deleteUser.run(id).changes > 0
    },

    postsForUser(userId) {
      return stmts.postsForUser.all(userId)
    },

    /**
     * A transaction. node:sqlite has no transaction() wrapper, so you drive
     * BEGIN / COMMIT / ROLLBACK yourself. The try/catch is not optional: leaving
     * a transaction open wedges every later write on this connection.
     */
    createUserWithPosts({ email, name, posts }) {
      db.exec('BEGIN')
      try {
        const { lastInsertRowid } = stmts.insertUser.run({ email, name })
        const userId = Number(lastInsertRowid)
        for (const post of posts) {
          stmts.insertPost.run(userId, post.title, post.body ?? '')
        }
        db.exec('COMMIT')
        return { user: this.getUser(userId), posts: this.postsForUser(userId) }
      } catch (err) {
        db.exec('ROLLBACK')
        throw err
      }
    },

    close() {
      db.close()
    },
  }
}
