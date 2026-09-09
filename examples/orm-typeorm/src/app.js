import express from 'express'
import { z } from 'zod'
import { dataSource } from './data-source.js'
import { User, Post, SORTABLE_USER_COLUMNS, USER_SORT_ALIAS } from './entities.js'

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

const ORM = 'typeorm'

export function createApp() {
  const app = express()
  app.use(express.json({ limit: '100kb' }))

  const users = () => dataSource.getRepository(User)
  const posts = () => dataSource.getRepository(Post)

  app.get('/health', async (_req, res) => {
    res.json({ status: 'ok', orm: ORM, users: await users().count() })
  })

  /* ----------------------------------------------------------------- users */

  app.get('/users', async (req, res) => {
    const { sort, direction, limit } = ListQuery.parse(req.query)
    // The query builder puts `orderBy`'s first argument into the SQL as an
    // identifier. TypeORM does not check it, so this Set does.
    if (!SORTABLE_USER_COLUMNS.has(sort)) {
      return res.status(400).json({ error: `unsortable column: ${sort}` })
    }
    const rows = await users()
      .createQueryBuilder('user')
      .orderBy(USER_SORT_ALIAS[sort], direction === 'desc' ? 'DESC' : 'ASC')
      .limit(limit)
      .getMany()
    res.json({ orm: ORM, users: rows })
  })

  app.post('/users', async (req, res) => {
    const body = CreateUser.parse(req.body)
    // `create()` builds the entity, `save()` persists it. Passing the parsed
    // object — not `req.body` — is what stops a client setting `id`.
    const user = await users().save(users().create(body))
    res.status(201).json({ orm: ORM, user })
  })

  /**
   * Eager loading two ways. `relations` is the declarative form; the query
   * builder's `leftJoinAndSelect` is the explicit one. Both produce a single
   * statement with a JOIN — neither is N+1.
   *
   * What IS N+1: `find()` without `relations`, then touching `user.posts` in a
   * loop. TypeORM has no lazy loading for plain properties, so that returns
   * `undefined` rather than silently querying — which is the better failure.
   */
  app.get('/users/:id', async (req, res) => {
    const id = IdParam.parse(req.params.id)
    const user = await users().findOne({
      where: { id },
      relations: { posts: true },
      order: { posts: { id: 'ASC' } },
    })
    if (!user) return res.status(404).json({ error: 'user not found' })
    res.json({ orm: ORM, user })
  })

  app.patch('/users/:id', async (req, res) => {
    const id = IdParam.parse(req.params.id)
    const { name } = PatchUser.parse(req.body)
    const result = await users().update({ id }, { name })
    if (!result.affected) return res.status(404).json({ error: 'user not found' })
    res.json({ orm: ORM, user: await users().findOneBy({ id }) })
  })

  app.delete('/users/:id', async (req, res) => {
    const id = IdParam.parse(req.params.id)
    const result = await users().delete({ id })
    if (!result.affected) return res.status(404).json({ error: 'user not found' })
    res.status(204).end()
  })

  /* ----------------------------------------------------------------- posts */

  app.get('/users/:id/posts', async (req, res) => {
    const id = IdParam.parse(req.params.id)
    const rows = await posts().find({ where: { author: { id } }, order: { id: 'ASC' } })
    res.json({ orm: ORM, posts: rows })
  })

  app.post('/users/:id/posts', async (req, res) => {
    const id = IdParam.parse(req.params.id)
    const body = CreatePost.parse(req.body)
    const author = await users().findOneBy({ id })
    if (!author) return res.status(404).json({ error: 'user not found' })
    const post = await posts().save(posts().create({ ...body, author }))
    res.status(201).json({ orm: ORM, post: { ...post, author: { id: author.id } } })
  })

  /**
   * The query builder with a NAMED BIND PARAMETER — the safety point of this
   * example.
   *
   *   SAFE    .where('user.email = :email', { email })
   *           TypeORM turns `:email` into the driver's placeholder and sends the
   *           value separately. The value never becomes SQL text.
   *
   *   UNSAFE  .where(`user.email = '${email}'`)
   *   UNSAFE  .where('user.email = ' + email)
   *           Both splice request data straight into the statement. The
   *           `.where()` string is raw SQL; it is not escaped for you.
   *
   * The same rule applies to `andWhere`, `having`, `orderBy` and
   * `Raw()`/`query()` — anything that takes a SQL fragment.
   */
  app.get('/posts', async (req, res) => {
    const { limit } = ListQuery.parse(req.query)
    const authorEmail = z.string().max(320).optional().parse(req.query.authorEmail)

    const qb = posts()
      .createQueryBuilder('post')
      .innerJoinAndSelect('post.author', 'author')
      .orderBy('post.id', 'DESC')
      .limit(limit)

    if (authorEmail) {
      qb.andWhere('author.email = :authorEmail', { authorEmail })
    }

    res.json({ orm: ORM, posts: await qb.getMany() })
  })

  /* ----------------------------------------------------------- transaction */

  app.post('/users-with-posts', async (req, res) => {
    const body = CreateUserWithPosts.parse(req.body)
    // `dataSource.transaction(cb)` commits when the callback resolves and rolls
    // back when it throws. Every write inside must go through the `manager` it
    // hands you — a repository taken from the DataSource uses a *different*
    // connection and its writes would land outside the transaction.
    const result = await dataSource.transaction(async (manager) => {
      // The target (`User`, `Post`) is not optional here. With decorators an
      // entity is a class instance and `manager.save(obj)` can infer it; with
      // EntitySchema the rows are plain objects, so a bare `save(obj)` throws
      // CannotDetermineEntityError. Always pass the schema.
      const user = await manager.save(User, { email: body.email, name: body.name })
      const saved = await manager.save(
        Post,
        body.posts.map((p) => ({ ...p, author: user })),
      )
      return { user, posts: saved.map(({ author, ...rest }) => ({ ...rest, userId: user.id })) }
    })
    res.status(201).json({ orm: ORM, ...result })
  })

  /* ------------------------------------------------- the raw escape hatch */

  app.get('/stats/authors', async (req, res) => {
    const minPosts = z.coerce.number().int().min(0).max(1000).default(0).parse(req.query.minPosts)
    // `dataSource.query()` takes positional parameters as a second argument, the
    // same as the underlying driver. Concatenating `minPosts` into the string
    // instead would be an injection even though it "is a number" — it is a
    // number only because Zod made it one two lines up.
    const rows = await dataSource.query(
      `SELECT u.id, u.email, u.name, COUNT(p.id) AS post_count
         FROM users u
         LEFT JOIN posts p ON p.user_id = u.id
        GROUP BY u.id
       HAVING COUNT(p.id) >= ?
        ORDER BY post_count DESC, u.id ASC`,
      [minPosts],
    )
    res.json({ orm: ORM, authors: rows })
  })

  // Express 5 / path-to-regexp v8.
  app.use('/{*splat}', (_req, res) => res.status(404).json({ error: 'not found' }))

  app.use((err, _req, res, _next) => {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: 'validation failed', issues: err.issues })
    }
    // TypeORM re-throws the driver error, so the better-sqlite3 code survives.
    // `err.driverError` is where it lives when TypeORM wraps it (QueryFailedError).
    const code = err?.code ?? err?.driverError?.code
    if (typeof code === 'string' && code.startsWith('SQLITE_CONSTRAINT')) {
      return res.status(409).json({ error: 'constraint violation', detail: err.driverError?.message ?? err.message })
    }
    console.error(err)
    res.status(500).json({ error: 'internal server error' })
  })

  return app
}
