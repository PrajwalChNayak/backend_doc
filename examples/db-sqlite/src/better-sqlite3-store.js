/**
 * The same store, through better-sqlite3.
 *
 * It is a native addon (a prebuilt binary is downloaded on install for common
 * platforms), synchronous like node:sqlite, and gives you a few things the
 * built-in module does not: `db.transaction()` with automatic savepoint nesting,
 * `.pluck()`, `.expand()`, user-defined functions, and `RETURNING` ergonomics.
 */
import Database from 'better-sqlite3'
import { DDL, SORTABLE_USER_COLUMNS } from './schema.js'

export function createBetterSqliteStore(filename) {
  const db = new Database(filename)

  db.pragma('foreign_keys = ON')
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('busy_timeout = 5000')

  db.exec(DDL)

  const stmts = {
    // Named parameters — better-sqlite3 also accepts bare keys for `:name`.
    insertUser: db.prepare(
      'INSERT INTO users (email, name) VALUES (@email, @name) RETURNING id, email, name, created_at',
    ),
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

  /**
   * db.transaction() returns a function. Calling it runs the body inside
   * BEGIN/COMMIT and rolls back automatically if the body throws. Nested calls
   * become SAVEPOINTs rather than errors, which is the main reason to reach for
   * better-sqlite3 over hand-rolled BEGIN/COMMIT.
   */
  const createUserWithPosts = db.transaction(({ email, name, posts }) => {
    const user = stmts.insertUser.get({ email, name })
    for (const post of posts) {
      stmts.insertPost.run(user.id, post.title, post.body ?? '')
    }
    return { user, posts: stmts.postsForUser.all(user.id) }
  })

  return {
    driver: 'better-sqlite3',

    health() {
      return { ok: stmts.ping.get().ok === 1, users: stmts.countUsers.get().n }
    },

    listUsers({ sort = 'id', direction = 'asc', limit = 50 } = {}) {
      if (!SORTABLE_USER_COLUMNS.has(sort)) {
        throw Object.assign(new Error(`unsortable column: ${sort}`), { status: 400 })
      }
      const dir = direction === 'desc' ? 'DESC' : 'ASC'
      // lint-sql:allow sort is validated against SORTABLE_USER_COLUMNS and dir is a literal
      const sql = `SELECT id, email, name, created_at FROM users ORDER BY ${sort} ${dir} LIMIT ?`
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
      return stmts.insertUser.get({ email, name })
    },

    deleteUser(id) {
      return stmts.deleteUser.run(id).changes > 0
    },

    postsForUser(userId) {
      return stmts.postsForUser.all(userId)
    },

    createUserWithPosts,

    close() {
      db.close()
    },
  }
}
