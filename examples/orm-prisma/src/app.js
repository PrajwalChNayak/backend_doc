import express from 'express'
import { z } from 'zod'
import { Prisma } from './generated/prisma/client.ts'
import { prisma, SORTABLE_USER_COLUMNS } from './db.js'

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

const ORM = 'prisma'

/** Serialises BigInt (SQLite COUNT via $queryRaw returns one) as a number. */
const jsonSafe = (value) => JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? Number(v) : v)))

export function createApp() {
  const app = express()
  app.use(express.json({ limit: '100kb' }))

  app.get('/health', async (_req, res) => {
    res.json({ status: 'ok', orm: ORM, users: await prisma.user.count() })
  })

  /* ----------------------------------------------------------------- users */

  app.get('/users', async (req, res) => {
    const { sort, direction, limit } = ListQuery.parse(req.query)
    // Prisma's `orderBy` is a structured object, not SQL text: an unknown key
    // is rejected by the client before a statement is built. Checking it here
    // only buys a clean 400 instead of a PrismaClientValidationError 500.
    if (!SORTABLE_USER_COLUMNS.has(sort)) {
      return res.status(400).json({ error: `unsortable column: ${sort}` })
    }
    const users = await prisma.user.findMany({ orderBy: { [sort]: direction }, take: limit })
    res.json({ orm: ORM, users })
  })

  app.post('/users', async (req, res) => {
    const body = CreateUser.parse(req.body)
    const user = await prisma.user.create({ data: body })
    res.status(201).json({ orm: ORM, user })
  })

  /**
   * Eager loading with `include`. Prisma runs this as two statements (one for
   * the user, one for the posts) and stitches them — not a JOIN, and not N+1
   * either: the post query is a single `WHERE user_id IN (...)`.
   *
   * `select` instead of `include` when you want fewer columns; the two are
   * mutually exclusive at the same level.
   */
  app.get('/users/:id', async (req, res) => {
    const id = IdParam.parse(req.params.id)
    const user = await prisma.user.findUnique({
      where: { id },
      include: { posts: { orderBy: { id: 'asc' } } },
    })
    if (!user) return res.status(404).json({ error: 'user not found' })
    res.json({ orm: ORM, user })
  })

  app.patch('/users/:id', async (req, res) => {
    const id = IdParam.parse(req.params.id)
    const { name } = PatchUser.parse(req.body)
    // `data: { name }`, never `data: req.body` — Prisma would accept any field
    // of the model, and `id` is a field of the model.
    const user = await prisma.user.update({ where: { id }, data: { name } })
    res.json({ orm: ORM, user })
  })

  app.delete('/users/:id', async (req, res) => {
    const id = IdParam.parse(req.params.id)
    await prisma.user.delete({ where: { id } })
    res.status(204).end()
  })

  /* ----------------------------------------------------------------- posts */

  app.get('/users/:id/posts', async (req, res) => {
    const id = IdParam.parse(req.params.id)
    const posts = await prisma.post.findMany({ where: { userId: id }, orderBy: { id: 'asc' } })
    res.json({ orm: ORM, posts })
  })

  app.post('/users/:id/posts', async (req, res) => {
    const id = IdParam.parse(req.params.id)
    const body = CreatePost.parse(req.body)
    // `connect` links to an existing row; if the id does not exist Prisma raises
    // P2025 rather than writing an orphan.
    const post = await prisma.post.create({ data: { ...body, author: { connect: { id } } } })
    res.status(201).json({ orm: ORM, post })
  })

  app.get('/posts', async (req, res) => {
    const { limit } = ListQuery.parse(req.query)
    const authorEmail = z.string().max(320).optional().parse(req.query.authorEmail)
    const posts = await prisma.post.findMany({
      where: authorEmail ? { author: { email: authorEmail } } : undefined,
      include: { author: { select: { id: true, email: true, name: true } } },
      orderBy: { id: 'desc' },
      take: limit,
    })
    res.json({ orm: ORM, posts })
  })

  /* ----------------------------------------------------------- transaction */

  app.post('/users-with-posts', async (req, res) => {
    const body = CreateUserWithPosts.parse(req.body)
    // The INTERACTIVE transaction: Prisma opens one, runs the callback against
    // `tx`, and commits on resolve / rolls back on throw. Use `tx` for every
    // query inside — a call on the outer `prisma` runs on another connection
    // and will not be rolled back.
    //
    // The other form, `prisma.$transaction([a, b, c])`, takes an array of
    // prepared queries and runs them in order. It cannot branch on a result,
    // which is exactly what this route needs to do with `user.id`.
    const result = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({ data: { email: body.email, name: body.name } })
      await tx.post.createMany({ data: body.posts.map((p) => ({ ...p, userId: user.id })) })
      const posts = await tx.post.findMany({ where: { userId: user.id }, orderBy: { id: 'asc' } })
      return { user, posts }
    })
    res.status(201).json({ orm: ORM, ...result })
  })

  /* ------------------------------------------------- the raw escape hatch */

  /**
   * `$queryRaw` is a TAGGED TEMPLATE. Every `${}` inside it becomes a bound
   * parameter — the value never becomes SQL text, no matter what it contains.
   * That is why this reads like string interpolation and is not one.
   *
   *   SAFE    prisma.$queryRaw`SELECT … WHERE email = ${email}`
   *   SAFE    prisma.$executeRaw`UPDATE … SET name = ${name} WHERE id = ${id}`
   *   SAFE    Prisma.sql`…` fragments, composed with Prisma.join()
   *
   *   UNSAFE  prisma.$queryRawUnsafe(statementYouBuiltByInterpolatingEmail)
   *   UNSAFE  prisma.$executeRawUnsafe(sameProblem)
   *   UNSAFE  Prisma.raw(orderByClauseFromTheClient)
   *
   * The `Unsafe` suffix and `Prisma.raw` are not warnings about style: they take
   * an ordinary string, so anything you interpolate lands in the statement. They
   * exist for SQL *you* generated — and even then, the value half belongs in the
   * parameter array, never in the string.
   *
   * Calling `prisma.$queryRaw(someString)` with parentheses instead of a
   * template is also unsafe, and Prisma throws rather than run it.
   */
  app.get('/stats/authors', async (req, res) => {
    const minPosts = z.coerce.number().int().min(0).max(1000).default(0).parse(req.query.minPosts)
    const authors = await prisma.$queryRaw`
      SELECT u.id, u.email, u.name, COUNT(p.id) AS post_count
      FROM users u
      LEFT JOIN posts p ON p.user_id = u.id
      GROUP BY u.id
      HAVING COUNT(p.id) >= ${minPosts}
      ORDER BY post_count DESC, u.id ASC
    `
    // SQLite returns COUNT() as a BigInt through the adapter, and JSON.stringify
    // throws on BigInt. Convert before responding.
    res.json({ orm: ORM, authors: jsonSafe(authors) })
  })

  // Express 5 / path-to-regexp v8.
  app.use('/{*splat}', (_req, res) => res.status(404).json({ error: 'not found' }))

  app.use((err, _req, res, _next) => {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: 'validation failed', issues: err.issues })
    }
    // Prisma normalises database errors into codes that are the same on every
    // provider. The two you handle in almost every API:
    //   P2002 unique constraint failed
    //   P2025 record required by the operation was not found
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      if (err.code === 'P2002') {
        return res.status(409).json({
          error: 'constraint violation',
          detail: `unique constraint on ${err.meta?.target ?? 'a field'}`,
        })
      }
      if (err.code === 'P2025') {
        return res.status(404).json({ error: 'not found' })
      }
      if (err.code === 'P2003') {
        return res.status(400).json({ error: 'foreign key constraint failed' })
      }
    }
    if (err instanceof Prisma.PrismaClientValidationError) {
      return res.status(400).json({ error: 'invalid query' })
    }
    console.error(err)
    res.status(500).json({ error: 'internal server error' })
  })

  return app
}
