/**
 * The fixed API. Same routes and seed data as examples/vulnerable-sql-injection,
 * but every value the client controls is bound as a `?` parameter, so it is
 * compared as data and can never become part of the SQL text.
 */
import express from 'express'
import { createDb } from './db.js'

/**
 * The one thing parameters CANNOT do: stand in for an identifier such as a
 * column name in `ORDER BY`. Placeholders bind values, not SQL syntax. So a
 * sort column has to be validated against an allow-list of known-good
 * identifiers before it is put into the query — and only then, with the
 * linter's blessing, interpolated.
 *
 * Maps the public field name to the actual column, which also means the client
 * never learns your column names.
 */
const SORTABLE = new Map([
  ['username', 'username'],
  ['email', 'email'],
  ['id', 'id'],
])
const SORT_DIRECTIONS = new Set(['asc', 'desc'])

export function createApp(db = createDb()) {
  const app = express()
  app.use(express.json())

  app.get('/health', (req, res) => {
    res.json({ status: 'ok' })
  })

  /**
   * FIX for the auth bypass. The `?` placeholders send `username` and `password`
   * to SQLite as bound values. `' OR '1'='1` is now compared, literally, against
   * the `username` column — no row has that as a username, so it matches
   * nothing. The SQL text is a fixed string the client can never edit.
   */
  app.post('/login', (req, res) => {
    const { username = '', password = '' } = req.body ?? {}

    try {
      const user = db
        .prepare(
          'SELECT id, username, email, role FROM users WHERE username = ? AND password = ?',
        )
        .get(String(username), String(password))

      if (!user) {
        res.status(401).json({ ok: false, error: 'invalid credentials' })
        return
      }
      res.json({ ok: true, user })
    } catch (err) {
      // Never leak the DB error to the client. Log it, return something generic.
      console.error('[login] error:', err)
      res.status(500).json({ ok: false, error: 'internal error' })
    }
  })

  /**
   * FIX for the UNION / boolean-blind exfiltration, PLUS the case parameters do
   * not cover: an optional `?sort=` column.
   *
   *   - `q` is bound. The LIKE wildcards are added to the VALUE, and any `%`/`_`
   *     the user typed are escaped so they cannot act as wildcards.
   *   - `sort` and `dir` are identifiers, so they cannot be bound. They are
   *     checked against allow-lists and the *validated* value — never the raw
   *     input — is interpolated.
   */
  app.get('/users/search', (req, res) => {
    const q = String(req.query.q ?? '')

    // Validate the sort column against the allow-list. An unknown value is a
    // 400, not a silent fallback, so a probing client gets a clear "no".
    const requestedSort = String(req.query.sort ?? 'username')
    const requestedDir = String(req.query.dir ?? 'asc').toLowerCase()

    if (!SORTABLE.has(requestedSort)) {
      res.status(400).json({ ok: false, error: `cannot sort by '${requestedSort}'`, allowed: [...SORTABLE.keys()] })
      return
    }
    if (!SORT_DIRECTIONS.has(requestedDir)) {
      res.status(400).json({ ok: false, error: `invalid sort direction '${requestedDir}'` })
      return
    }

    const sortColumn = SORTABLE.get(requestedSort)
    const sortDir = requestedDir === 'desc' ? 'DESC' : 'ASC'

    // `q` binds as a value; the LIKE wildcards live in the parameter, and the
    // user's own %/_ are escaped so they match literally.
    const likeValue = `%${escapeLike(q)}%`

    // Only `sortColumn`/`sortDir` are interpolated, and both came out of the
    // allow-lists above — they can only ever be one of a handful of constant
    // strings this file defines.
    // lint-sql:allow sortColumn and sortDir are validated against the SORTABLE / SORT_DIRECTIONS allow-lists above
    const sql = `SELECT username, email FROM users WHERE username LIKE ? ESCAPE '\\' ORDER BY ${sortColumn} ${sortDir}`

    try {
      const rows = db.prepare(sql).all(likeValue)
      res.json({ ok: true, count: rows.length, rows, sortedBy: `${requestedSort} ${sortDir}` })
    } catch (err) {
      console.error('[search] error:', err)
      res.status(500).json({ ok: false, error: 'internal error' })
    }
  })

  app.use('/{*splat}', (req, res) => {
    res.status(404).json({ ok: false, error: `Cannot ${req.method} ${req.originalUrl}` })
  })

  return app
}

/** `%` and `_` are LIKE wildcards; escape them so user input matches literally. */
function escapeLike(value) {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`)
}

export default createApp
