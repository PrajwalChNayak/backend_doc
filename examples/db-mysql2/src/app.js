import express from 'express'
import { z } from 'zod'
import { pool, withTransaction, ping } from './db.js'

const CreateUser = z.object({
  email: z.email(),
  name: z.string().min(1).max(120),
})

const CreateUserWithPosts = CreateUser.extend({
  posts: z
    .array(z.object({ title: z.string().min(1).max(200), body: z.string().max(5000).default('') }))
    .min(1)
    .max(20),
})

const IdParam = z.coerce.number().int().positive()
const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  q: z.string().max(120).optional(),
})

export function createApp(state) {
  const app = express()
  app.use(express.json())

  app.get('/health', async (_req, res) => {
    if (!state.dbReady) {
      return res.status(503).json({ status: 'degraded', database: 'unreachable' })
    }
    try {
      const start = performance.now()
      await ping()
      res.json({ status: 'ok', database: 'up', latencyMs: Math.round(performance.now() - start) })
    } catch (err) {
      res.status(503).json({ status: 'degraded', database: 'unreachable', error: err.message })
    }
  })

  app.get('/users', async (req, res) => {
    const { limit, q } = ListQuery.parse(req.query)

    // Whole alternative statements, not a concatenated WHERE clause.
    const [rows] = q
      ? await pool.execute(
          `SELECT id, email, name, created_at
             FROM users
            WHERE email LIKE CONCAT('%', ?, '%') OR name LIKE CONCAT('%', ?, '%')
            ORDER BY id
            LIMIT ?`,
          [q, q, limit],
        )
      : await pool.execute(
          'SELECT id, email, name, created_at FROM users ORDER BY id LIMIT ?',
          [limit],
        )

    res.json({ users: rows })
  })

  app.get('/users/:id', async (req, res) => {
    const id = IdParam.parse(req.params.id)
    const [rows] = await pool.execute(
      'SELECT id, email, name, created_at, updated_at FROM users WHERE id = ?',
      [id],
    )
    if (rows.length === 0) return res.status(404).json({ error: 'user not found' })
    res.json({ user: rows[0] })
  })

  /**
   * MySQL has no RETURNING clause, so a create is two steps: INSERT, then read
   * back the auto-increment key from the OkPacket's `insertId`.
   *
   * `insertId` is per-connection and set by the *last* insert on that connection,
   * so read it from the result object you were handed — never from a later
   * `SELECT LAST_INSERT_ID()` on a pooled connection you no longer own.
   */
  app.post('/users', async (req, res) => {
    const { email, name } = CreateUser.parse(req.body)
    const [result] = await pool.execute('INSERT INTO users (email, name) VALUES (?, ?)', [
      email,
      name,
    ])
    const [rows] = await pool.execute(
      'SELECT id, email, name, created_at FROM users WHERE id = ?',
      [result.insertId],
    )
    res.status(201).json({ insertId: result.insertId, affectedRows: result.affectedRows, user: rows[0] })
  })

  /** MySQL's upsert. `VALUES()` is deprecated in 8.0.20+; the aliased form is current. */
  app.put('/users', async (req, res) => {
    const { email, name } = CreateUser.parse(req.body)
    const [result] = await pool.execute(
      `INSERT INTO users (email, name) VALUES (?, ?) AS new
         ON DUPLICATE KEY UPDATE name = new.name`,
      [email, name],
    )
    const [rows] = await pool.execute(
      'SELECT id, email, name, created_at, updated_at FROM users WHERE email = ?',
      [email],
    )
    // affectedRows: 1 = inserted, 2 = updated, 0 = updated with identical values.
    res.status(result.affectedRows === 1 ? 201 : 200).json({
      affectedRows: result.affectedRows,
      inserted: result.affectedRows === 1,
      user: rows[0],
    })
  })

  app.get('/users/:id/posts', async (req, res) => {
    const id = IdParam.parse(req.params.id)
    const [rows] = await pool.execute(
      'SELECT id, user_id, title, body, created_at FROM posts WHERE user_id = ? ORDER BY id',
      [id],
    )
    res.json({ posts: rows })
  })

  app.post('/users-with-posts', async (req, res) => {
    const { email, name, posts } = CreateUserWithPosts.parse(req.body)

    const result = await withTransaction(async (conn) => {
      const [userResult] = await conn.execute('INSERT INTO users (email, name) VALUES (?, ?)', [
        email,
        name,
      ])
      const userId = userResult.insertId

      // Bulk insert. `pool.query` (not `execute`) is what supports the nested-array
      // `VALUES ?` form, because the expansion happens client-side during escaping.
      // The values are still escaped by mysql2 — this is not interpolation.
      const [postResult] = await conn.query(
        'INSERT INTO posts (user_id, title, body) VALUES ?',
        [posts.map((p) => [userId, p.title, p.body])],
      )

      const [userRows] = await conn.execute(
        'SELECT id, email, name, created_at FROM users WHERE id = ?',
        [userId],
      )
      const [postRows] = await conn.execute(
        'SELECT id, user_id, title, body, created_at FROM posts WHERE user_id = ? ORDER BY id',
        [userId],
      )

      return { user: userRows[0], posts: postRows, postsInserted: postResult.affectedRows }
    })

    res.status(201).json(result)
  })

  /** Proof the rollback works: the second insert always trips the UNIQUE key. */
  app.post('/rollback-demo', async (req, res) => {
    const { email, name } = CreateUser.parse(req.body)
    try {
      await withTransaction(async (conn) => {
        await conn.execute('INSERT INTO users (email, name) VALUES (?, ?)', [email, name])
        await conn.execute('INSERT INTO users (email, name) VALUES (?, ?)', [email, name])
      })
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') {
        const [rows] = await pool.execute('SELECT COUNT(*) AS n FROM users WHERE email = ?', [
          email,
        ])
        return res.json({
          rolledBack: true,
          rowsWithThatEmail: Number(rows[0].n),
          note: 'InnoDB undid both inserts, so the count is 0',
        })
      }
      throw err
    }
    res.status(500).json({ error: 'expected a duplicate-key error and did not get one' })
  })

  app.use('/{*splat}', (_req, res) => res.status(404).json({ error: 'not found' }))

  app.use((err, _req, res, _next) => {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: 'validation failed', issues: err.issues })
    }
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'already exists' })
    if (err.code === 'ER_NO_REFERENCED_ROW_2') {
      return res.status(409).json({ error: 'referenced row missing' })
    }
    if (err.code === 'ECONNREFUSED' || err.code === 'PROTOCOL_CONNECTION_LOST') {
      return res.status(503).json({ error: 'database unreachable' })
    }
    console.error(err)
    res.status(500).json({ error: 'internal server error' })
  })

  return app
}
