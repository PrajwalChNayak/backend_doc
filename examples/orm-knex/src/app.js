import express from 'express'
import { z } from 'zod'
import { knex, SORTABLE_USER_COLUMNS } from './db.js'

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
  sort: z.string().default('id'),
  direction: z.enum(['asc', 'desc']).default('asc'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
})

const IdParam = z.coerce.number().int().positive()

const ORM = 'knex'

const USER_COLUMNS = ['id', 'email', 'name', 'created_at']

export function createApp() {
  const app = express()
  app.use(express.json({ limit: '100kb' }))

  app.get('/health', async (_req, res) => {
    const row = await knex('users').count({ n: '*' }).first()
    res.json({ status: 'ok', orm: ORM, users: Number(row.n) })
  })

  /* ----------------------------------------------------------------- users */

  app.get('/users', async (req, res) => {
    const { sort, direction, limit } = ListQuery.parse(req.query)
    // Knex quotes whatever identifier you hand `orderBy`, but it does not check
    // that the identifier exists or that a client did not choose it. Validate
    // first; the 400 is part of the contract, not an afterthought.
    if (!SORTABLE_USER_COLUMNS.has(sort)) {
      return res.status(400).json({ error: `unsortable column: ${sort}` })
    }
    const users = await knex('users').select(USER_COLUMNS).orderBy(sort, direction).limit(limit)
    res.json({ orm: ORM, users })
  })

  app.post('/users', async (req, res) => {
    const body = CreateUser.parse(req.body)
    const [user] = await knex('users').insert(body).returning(USER_COLUMNS)
    res.status(201).json({ orm: ORM, user })
  })

  /**
   * Eager loading, by hand.
   *
   * Knex has no relations, so "include the posts" is two queries and a stitch.
   * That is more code than an ORM's `include`, and it is also the reason the
   * query count is obvious: there is no configuration that can turn this into
   * N+1 behind your back.
   */
  app.get('/users/:id', async (req, res) => {
    const id = IdParam.parse(req.params.id)
    const user = await knex('users').select(USER_COLUMNS).where({ id }).first()
    if (!user) return res.status(404).json({ error: 'user not found' })
    const posts = await knex('posts').where({ user_id: id }).orderBy('id')
    res.json({ orm: ORM, user: { ...user, posts } })
  })

  app.patch('/users/:id', async (req, res) => {
    const id = IdParam.parse(req.params.id)
    const { name } = PatchUser.parse(req.body)
    // Named column, never `.update(req.body)` — that would let a client set any
    // column in the table, `id` included.
    const [user] = await knex('users').where({ id }).update({ name }).returning(USER_COLUMNS)
    if (!user) return res.status(404).json({ error: 'user not found' })
    res.json({ orm: ORM, user })
  })

  app.delete('/users/:id', async (req, res) => {
    const id = IdParam.parse(req.params.id)
    const deleted = await knex('users').where({ id }).del()
    if (!deleted) return res.status(404).json({ error: 'user not found' })
    res.status(204).end()
  })

  /* ----------------------------------------------------------------- posts */

  app.get('/users/:id/posts', async (req, res) => {
    const id = IdParam.parse(req.params.id)
    const posts = await knex('posts').where({ user_id: id }).orderBy('id')
    res.json({ orm: ORM, posts })
  })

  app.post('/users/:id/posts', async (req, res) => {
    const id = IdParam.parse(req.params.id)
    const body = CreatePost.parse(req.body)
    const [post] = await knex('posts').insert({ ...body, user_id: id }).returning('*')
    res.status(201).json({ orm: ORM, post })
  })

  // The relation as a join: one query, one flat row per post. Aliased columns
  // keep `users.id` and `posts.id` from colliding in the result object.
  app.get('/posts', async (req, res) => {
    const { limit } = ListQuery.parse(req.query)
    const rows = await knex('posts')
      .join('users', 'users.id', 'posts.user_id')
      .select(
        'posts.id as id',
        'posts.title as title',
        'posts.body as body',
        'users.id as author_id',
        'users.email as author_email',
        'users.name as author_name',
      )
      .orderBy('posts.id', 'desc')
      .limit(limit)
    res.json({
      orm: ORM,
      posts: rows.map(({ author_id, author_email, author_name, ...post }) => ({
        ...post,
        author: { id: author_id, email: author_email, name: author_name },
      })),
    })
  })

  /* ----------------------------------------------------------- transaction */

  app.post('/users-with-posts', async (req, res) => {
    const body = CreateUserWithPosts.parse(req.body)
    // knex.transaction(callback) is the managed form: it commits when the
    // callback resolves and rolls back when it rejects. The unmanaged form
    // (`const trx = await knex.transaction()`) makes you call commit/rollback
    // yourself, and a missed rollback holds the SQLite write lock until the
    // pool connection is destroyed.
    const result = await knex.transaction(async (trx) => {
      const [user] = await trx('users')
        .insert({ email: body.email, name: body.name })
        .returning(USER_COLUMNS)
      for (const post of body.posts) {
        await trx('posts').insert({ user_id: user.id, title: post.title, body: post.body })
      }
      const posts = await trx('posts').where({ user_id: user.id }).orderBy('id')
      return { user, posts }
    })
    res.status(201).json({ orm: ORM, ...result })
  })

  /* ------------------------------------------------- the raw escape hatch */

  /**
   * `knex.raw()` takes bindings, and there are two placeholders:
   *
   *   ?    a VALUE binding   -> sent to the driver as a parameter
   *   ??   an IDENTIFIER     -> quoted by Knex as a column/table name
   *
   * Both are safe against the value injection people usually mean. `??` is NOT
   * a licence to pass user input as a column: quoting stops the string breaking
   * out of the identifier, but a client could still name a column you never
   * meant to expose. Validate against an allow-list first — which is what
   * SORTABLE_USER_COLUMNS does above and what the `groupBy` check does here.
   *
   * The unsafe forms, for contrast — both take an ordinary string, so whatever
   * you interpolated is now part of the statement:
   *   knex.raw(statementYouBuiltByInterpolatingEmail)
   *   knex.whereRaw(conditionYouBuiltByInterpolatingEmail)
   * Neither is what `raw` is for. The README shows the exploit in full.
   */
  app.get('/stats/authors', async (req, res) => {
    const minPosts = z.coerce.number().int().min(0).max(1000).default(0).parse(req.query.minPosts)

    const { rows } = normalise(
      await knex.raw(
        `SELECT ??, ??, ??, COUNT(p.id) AS post_count
           FROM users u
           LEFT JOIN posts p ON p.user_id = u.id
          GROUP BY u.id
         HAVING COUNT(p.id) >= ?
          ORDER BY post_count DESC, u.id ASC`,
        ['u.id', 'u.email', 'u.name', minPosts],
      ),
    )

    res.json({ orm: ORM, authors: rows })
  })

  // Different Knex clients return different shapes from raw(): better-sqlite3
  // gives you the array directly, pg wraps it in { rows }. Normalising here
  // keeps the route from caring.
  function normalise(result) {
    if (Array.isArray(result)) return { rows: result }
    if (Array.isArray(result?.rows)) return { rows: result.rows }
    return { rows: [] }
  }

  // Express 5 / path-to-regexp v8: '/*' alone is invalid.
  app.use('/{*splat}', (_req, res) => res.status(404).json({ error: 'not found' }))

  app.use((err, _req, res, _next) => {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: 'validation failed', issues: err.issues })
    }
    // Knex prefixes the driver error with the failing statement *and its bound
    // values*. Echoing `err.message` straight to a client hands them your schema
    // and someone else's data, so only the driver's own text goes out.
    if (typeof err?.code === 'string' && err.code.startsWith('SQLITE_CONSTRAINT')) {
      console.error(err)
      return res.status(409).json({ error: 'constraint violation', detail: err.message.split(' - ').at(-1) })
    }
    console.error(err)
    res.status(500).json({ error: 'internal server error' })
  })

  return app
}
