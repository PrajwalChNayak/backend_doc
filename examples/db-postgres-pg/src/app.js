import express from 'express'
import { z } from 'zod'
import { pool, withTransaction, ping } from './db.js'

const UpsertUser = z.object({
  email: z.email(),
  name: z.string().min(1).max(120),
})

const CreateUserWithPosts = UpsertUser.extend({
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

  /**
   * Liveness + readiness in one. It has to answer fast even when Postgres is
   * gone, so it is bounded by the pool's connectionTimeoutMillis (3s) and never
   * queues behind application queries.
   */
  app.get('/health', async (_req, res) => {
    if (!state.dbReady) {
      return res.status(503).json({ status: 'degraded', database: 'unreachable' })
    }
    try {
      const start = performance.now()
      await ping()
      res.json({
        status: 'ok',
        database: 'up',
        latencyMs: Math.round(performance.now() - start),
        pool: { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount },
      })
    } catch (err) {
      res.status(503).json({ status: 'degraded', database: 'unreachable', error: err.message })
    }
  })

  app.get('/users', async (req, res) => {
    const { limit, q } = ListQuery.parse(req.query)

    // Two different statements rather than a concatenated WHERE clause. When the
    // shape of a query varies, pick between whole statements — do not build SQL
    // out of pieces of user input.
    const { rows } = q
      ? await pool.query(
          `SELECT id, email, name, created_at
             FROM users
            WHERE email ILIKE '%' || $1 || '%' OR name ILIKE '%' || $1 || '%'
            ORDER BY id
            LIMIT $2`,
          [q, limit],
        )
      : await pool.query(
          'SELECT id, email, name, created_at FROM users ORDER BY id LIMIT $1',
          [limit],
        )

    res.json({ users: rows })
  })

  app.get('/users/:id', async (req, res) => {
    const id = IdParam.parse(req.params.id)
    const { rows } = await pool.query(
      'SELECT id, email, name, created_at, updated_at FROM users WHERE id = $1',
      [id],
    )
    if (rows.length === 0) return res.status(404).json({ error: 'user not found' })
    res.json({ user: rows[0] })
  })

  /**
   * Upsert. `ON CONFLICT (email) DO UPDATE` turns "insert, and if it already
   * exists update it" into one round trip with no read-modify-write race.
   * `EXCLUDED` is the row that would have been inserted.
   * `RETURNING` gives you the final row without a second SELECT.
   */
  app.put('/users', async (req, res) => {
    const { email, name } = UpsertUser.parse(req.body)
    const { rows } = await pool.query(
      `INSERT INTO users (email, name)
            VALUES ($1, $2)
       ON CONFLICT (email)
       DO UPDATE SET name = EXCLUDED.name, updated_at = now()
         RETURNING id, email, name, created_at, updated_at,
                   (xmax = 0) AS inserted`,
      [email, name],
    )
    const user = rows[0]
    res.status(user.inserted ? 201 : 200).json({ user })
  })

  app.get('/users/:id/posts', async (req, res) => {
    const id = IdParam.parse(req.params.id)
    const { rows } = await pool.query(
      'SELECT id, user_id, title, body, created_at FROM posts WHERE user_id = $1 ORDER BY id',
      [id],
    )
    res.json({ posts: rows })
  })

  /** User + posts, atomically, on one connection. */
  app.post('/users-with-posts', async (req, res) => {
    const { email, name, posts } = CreateUserWithPosts.parse(req.body)

    const result = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO users (email, name) VALUES ($1, $2)
           RETURNING id, email, name, created_at`,
        [email, name],
      )
      const user = rows[0]

      // One INSERT for all the posts, using UNNEST so the array is still a
      // single bound parameter instead of a generated VALUES list.
      const { rows: created } = await client.query(
        `INSERT INTO posts (user_id, title, body)
         SELECT $1, t.title, t.body
           FROM UNNEST($2::text[], $3::text[]) AS t(title, body)
         RETURNING id, user_id, title, body, created_at`,
        [user.id, posts.map((p) => p.title), posts.map((p) => p.body)],
      )

      return { user, posts: created }
    })

    res.status(201).json(result)
  })

  /** Proof that the transaction rolls back: the second insert always violates UNIQUE. */
  app.post('/rollback-demo', async (req, res) => {
    const { email, name } = UpsertUser.parse(req.body)
    try {
      await withTransaction(async (client) => {
        await client.query('INSERT INTO users (email, name) VALUES ($1, $2)', [email, name])
        await client.query('INSERT INTO users (email, name) VALUES ($1, $2)', [email, name])
      })
    } catch (err) {
      if (err.code === '23505') {
        const { rows } = await pool.query('SELECT COUNT(*) AS n FROM users WHERE email = $1', [
          email,
        ])
        return res.status(200).json({
          rolledBack: true,
          rowsWithThatEmail: Number(rows[0].n),
          note: 'both inserts were undone, so the count is 0',
        })
      }
      throw err
    }
    res.status(500).json({ error: 'expected a unique violation and did not get one' })
  })

  app.use('/{*splat}', (_req, res) => res.status(404).json({ error: 'not found' }))

  // Express 5 forwards rejected promises here on its own.
  app.use((err, _req, res, _next) => {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: 'validation failed', issues: err.issues })
    }
    // https://www.postgresql.org/docs/current/errcodes-appendix.html
    if (err.code === '23505') return res.status(409).json({ error: 'already exists' })
    if (err.code === '23503') return res.status(409).json({ error: 'referenced row missing' })
    if (err.code === '57014') return res.status(504).json({ error: 'statement timeout' })
    if (err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT') {
      return res.status(503).json({ error: 'database unreachable' })
    }
    console.error(err)
    res.status(500).json({ error: 'internal server error' })
  })

  return app
}
