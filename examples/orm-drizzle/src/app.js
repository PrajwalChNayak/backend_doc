import express from 'express'
import { z } from 'zod'
import { desc, eq, sql } from 'drizzle-orm'
import { db } from './db.js'
import { users, posts, SORTABLE_USER_COLUMNS } from './schema.js'

const CreateUser = z.object({
  email: z.email(),
  name: z.string().min(1).max(120),
})

const PatchUser = z.object({ name: z.string().min(1).max(120) })

const CreatePost = z.object({
  title: z.string().min(1).max(200),
  body: z.string().max(5000).default(''),
})

const CreateUserWithPosts = CreateUser.extend({
  posts: z.array(CreatePost).min(1).max(20),
})

const ListQuery = z.object({
  sort: z.enum(['id', 'email', 'name', 'created_at']).default('id'),
  direction: z.enum(['asc', 'desc']).default('asc'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
})

const IdParam = z.coerce.number().int().positive()

const ORM = 'drizzle-orm'

export function createApp() {
  const app = express()
  app.use(express.json({ limit: '100kb' }))

  app.get('/health', (_req, res) => {
    const [{ n }] = db.all(sql`SELECT COUNT(*) AS n FROM users`)
    res.json({ status: 'ok', orm: ORM, users: n })
  })

  /* ----------------------------------------------------------------- users */

  app.get('/users', (req, res) => {
    const { sort, direction, limit } = ListQuery.parse(req.query)
    // `orderBy` wants a column object, not a string. The lookup table IS the
    // allow-list: an unknown key has no entry, so nothing a client sends can
    // reach the SQL text. Zod already rejected anything outside the enum.
    const column = SORTABLE_USER_COLUMNS[sort]
    const rows = db
      .select()
      .from(users)
      .orderBy(direction === 'desc' ? desc(column) : column)
      .limit(limit)
      .all()
    res.json({ orm: ORM, users: rows })
  })

  app.post('/users', (req, res) => {
    const body = CreateUser.parse(req.body)
    const [user] = db.insert(users).values(body).returning().all()
    res.status(201).json({ orm: ORM, user })
  })

  // Eager loading, relational-query style: one call, `posts` nested in the row.
  // Drizzle issues this as a single statement with a correlated subquery, so it
  // does not have the N+1 problem a per-row lookup would.
  app.get('/users/:id', (req, res) => {
    const id = IdParam.parse(req.params.id)
    // `.sync()` runs it now on the synchronous better-sqlite3 driver. The same
    // call is awaitable (it is thenable), which is what you use on a driver that
    // is genuinely async — libsql, D1, Postgres.
    const user = db.query.users
      .findFirst({
        where: eq(users.id, id),
        with: { posts: { orderBy: posts.id } },
      })
      .sync()
    if (!user) return res.status(404).json({ error: 'user not found' })
    res.json({ orm: ORM, user })
  })

  app.patch('/users/:id', (req, res) => {
    const id = IdParam.parse(req.params.id)
    const { name } = PatchUser.parse(req.body)
    // `.set()` takes named columns, never a spread of req.body — spreading the
    // request would let a client write `id` or any other column you own.
    const [user] = db.update(users).set({ name }).where(eq(users.id, id)).returning().all()
    if (!user) return res.status(404).json({ error: 'user not found' })
    res.json({ orm: ORM, user })
  })

  app.delete('/users/:id', (req, res) => {
    const id = IdParam.parse(req.params.id)
    const removed = db.delete(users).where(eq(users.id, id)).returning({ id: users.id }).all()
    if (!removed.length) return res.status(404).json({ error: 'user not found' })
    res.status(204).end()
  })

  /* ----------------------------------------------------------------- posts */

  app.get('/users/:id/posts', (req, res) => {
    const id = IdParam.parse(req.params.id)
    const rows = db.select().from(posts).where(eq(posts.userId, id)).orderBy(posts.id).all()
    res.json({ orm: ORM, posts: rows })
  })

  app.post('/users/:id/posts', (req, res) => {
    const id = IdParam.parse(req.params.id)
    const body = CreatePost.parse(req.body)
    const [post] = db.insert(posts).values({ ...body, userId: id }).returning().all()
    res.status(201).json({ orm: ORM, post })
  })

  // The other direction of the same relation, as an explicit join. Use this
  // shape when you want a flat row per post rather than a nested tree.
  app.get('/posts', (req, res) => {
    const { limit } = ListQuery.parse(req.query)
    const rows = db
      .select({
        id: posts.id,
        title: posts.title,
        body: posts.body,
        author: { id: users.id, email: users.email, name: users.name },
      })
      .from(posts)
      .innerJoin(users, eq(posts.userId, users.id))
      .orderBy(desc(posts.id))
      .limit(limit)
      .all()
    res.json({ orm: ORM, posts: rows })
  })

  /* ----------------------------------------------------------- transaction */

  app.post('/users-with-posts', (req, res) => {
    const body = CreateUserWithPosts.parse(req.body)
    // better-sqlite3 is synchronous, so Drizzle's SQLite transaction callback is
    // synchronous too. Returning a promise from it would commit before the
    // promise settled — do not make this callback `async`.
    const result = db.transaction((tx) => {
      const [user] = tx.insert(users).values({ email: body.email, name: body.name }).returning().all()
      for (const post of body.posts) {
        tx.insert(posts).values({ userId: user.id, title: post.title, body: post.body }).run()
      }
      return { user, posts: tx.select().from(posts).where(eq(posts.userId, user.id)).all() }
    })
    res.status(201).json({ orm: ORM, ...result })
  })

  /* ------------------------------------------------- the raw escape hatch */

  /**
   * `sql` is Drizzle's escape hatch, and it is a tagged template: every `${}`
   * becomes a bound parameter, not text. That is why the query below is safe
   * even though it reads like string interpolation.
   *
   *   SAFE    sql`... WHERE email = ${email}`      -> `... WHERE email = ?`, [email]
   *   UNSAFE  sql.raw(`... WHERE email = '${email}'`)
   *
   * `sql.raw()` splices its argument into the statement verbatim. It exists for
   * fragments you wrote yourself (a keyword, a hint); it must never see a value
   * that came from a request. `sql.identifier()` is the right tool when you need
   * a dynamic *column or table name* — and even then, check it against a fixed
   * list first, because an identifier is still not a bound parameter.
   */
  app.get('/stats/authors', (req, res) => {
    const minPosts = z.coerce.number().int().min(0).max(1000).default(0).parse(req.query.minPosts)
    const rows = db.all(sql`
      SELECT u.id, u.email, u.name, COUNT(p.id) AS post_count
      FROM ${users} u
      LEFT JOIN ${posts} p ON p.user_id = u.id
      GROUP BY u.id
      HAVING COUNT(p.id) >= ${minPosts}
      ORDER BY post_count DESC, u.id ASC
    `)
    res.json({ orm: ORM, authors: rows })
  })

  // Express 5 / path-to-regexp v8: a bare '/*' throws at startup.
  app.use('/{*splat}', (_req, res) => res.status(404).json({ error: 'not found' }))

  // Express 5 forwards rejected promises here on its own — no asyncHandler.
  app.use((err, _req, res, _next) => {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: 'validation failed', issues: err.issues })
    }
    // Drizzle does not wrap driver errors, so this is the better-sqlite3 error
    // verbatim — which is exactly why the constraint check is the driver's.
    if (typeof err?.code === 'string' && err.code.startsWith('SQLITE_CONSTRAINT')) {
      return res.status(409).json({ error: 'constraint violation', detail: err.message })
    }
    console.error(err)
    res.status(500).json({ error: 'internal server error' })
  })

  return app
}
