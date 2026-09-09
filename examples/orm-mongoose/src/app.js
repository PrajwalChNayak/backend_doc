import express from 'express'
import mongoose from 'mongoose'
import { z } from 'zod'
import { User, Post, SORTABLE_USER_FIELDS } from './models.js'
import { supportsTransactions } from './db.js'

/**
 * Every schema below coerces the request into PRIMITIVES.
 *
 * That is the whole defence. MongoDB has no SQL to inject into — the equivalent
 * attack is OPERATOR INJECTION: a JSON body puts an object where your code
 * expected a string, and the object is a query operator.
 *
 *   POST /login  {"email":"ada@example.com","password":{"$ne":null}}
 *
 * `User.findOne({ email, password })` with that body asks for "any password that
 * is not null" and logs the attacker in. `z.string()` rejects the object before
 * it can reach a filter, which is why validation is a security control here and
 * not a convenience.
 */
const CreateUser = z.object({
  email: z.email().max(320),
  name: z.string().min(1).max(120),
})

const PatchUser = z.object({ name: z.string().min(1).max(120) })

// `z.string()` is the whole defence for POST /users/search: an object body such
// as {"email":{"$ne":null}} fails this parse and never reaches a filter.
const SearchUser = z.object({ email: z.string().min(1).max(320) })

const CreatePost = z.object({
  title: z.string().min(1).max(200),
  body: z.string().max(5000).default(''),
})

const CreateUserWithPosts = CreateUser.extend({
  posts: z.array(CreatePost).min(1).max(20),
})

const ListQuery = z.object({
  sort: z.string().default('createdAt'),
  direction: z.enum(['asc', 'desc']).default('asc'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
})

// An ObjectId is 24 hex characters. Validating the shape turns a malformed id
// into a 400 instead of a CastError 500.
const IdParam = z.string().refine((v) => mongoose.isValidObjectId(v), 'not a valid ObjectId')

const ORM = 'mongoose'

export function createApp(state) {
  const app = express()
  app.use(express.json({ limit: '100kb' }))

  // Every route below needs the database. Answer 503 rather than hanging or
  // returning a confusing 500 when it is not there.
  const requireDb = (req, res, next) => {
    if (!state.dbReady) {
      return res.status(503).json({ error: 'database unavailable', hint: 'start MongoDB — see the README' })
    }
    next()
  }

  app.get('/health', async (_req, res) => {
    if (!state.dbReady) {
      return res.status(503).json({ status: 'degraded', orm: ORM, database: 'down' })
    }
    res.json({ status: 'ok', orm: ORM, users: await User.estimatedDocumentCount() })
  })

  app.use(requireDb)

  /* ----------------------------------------------------------------- users */

  app.get('/users', async (req, res) => {
    const { sort, direction, limit } = ListQuery.parse(req.query)
    // A `sort` string is a FIELD NAME, and Mongoose passes it to the driver as
    // one. An unvalidated value cannot inject an operator, but it can sort by a
    // field you never meant to expose and it can force a collection scan on an
    // unindexed field. Allow-list it.
    if (!SORTABLE_USER_FIELDS.has(sort)) {
      return res.status(400).json({ error: `unsortable field: ${sort}` })
    }
    const users = await User.find().sort({ [sort]: direction === 'desc' ? -1 : 1 }).limit(limit)
    res.json({ orm: ORM, users })
  })

  app.post('/users', async (req, res) => {
    const body = CreateUser.parse(req.body)
    const user = await User.create(body)
    res.status(201).json({ orm: ORM, user })
  })

  /**
   * Eager loading. `populate()` is a SECOND query, not a join: Mongoose fetches
   * the user, then fetches the posts whose `author` is in that set, then
   * attaches them. Populating inside a loop is therefore the N+1 — populate the
   * whole result set in one call instead, as GET /posts does below.
   */
  app.get('/users/:id', async (req, res) => {
    const id = IdParam.parse(req.params.id)
    const user = await User.findById(id).populate({ path: 'posts', options: { sort: { createdAt: 1 } } })
    if (!user) return res.status(404).json({ error: 'user not found' })
    res.json({ orm: ORM, user })
  })

  app.patch('/users/:id', async (req, res) => {
    const id = IdParam.parse(req.params.id)
    const { name } = PatchUser.parse(req.body)
    // `$set` with a named field. `findByIdAndUpdate(id, req.body)` would let a
    // client send `{"$rename": {...}}` or any other update operator.
    const user = await User.findByIdAndUpdate(id, { $set: { name } }, { new: true, runValidators: true })
    if (!user) return res.status(404).json({ error: 'user not found' })
    res.json({ orm: ORM, user })
  })

  app.delete('/users/:id', async (req, res) => {
    const id = IdParam.parse(req.params.id)
    const user = await User.findByIdAndDelete(id)
    if (!user) return res.status(404).json({ error: 'user not found' })
    // Manual cascade. Mongo will not do this for you, and an orphaned post whose
    // `author` points at a deleted document is the most common data-integrity
    // bug in a Mongoose codebase.
    const { deletedCount } = await Post.deleteMany({ author: user._id })
    res.status(200).json({ orm: ORM, deleted: { user: 1, posts: deletedCount } })
  })

  /**
   * The operator-injection demonstration, on a JSON body — which is where it
   * actually happens, because a JSON body can carry an object while a query
   * string (with Express 5's default 'simple' parser) cannot.
   *
   *   curl -d '{"email":"ada@example.com"}'      -> 200, one user
   *   curl -d '{"email":{"$ne":null}}'           -> 400, rejected by Zod
   *
   * Three independent layers stop the second one, and you want all three:
   *   1. `SearchUser` parses `email` as a STRING. An object fails here.
   *   2. `{ $eq: email }` states the operator explicitly, so even a value that
   *      somehow got through cannot supply its own.
   *   3. `mongoose.set('sanitizeFilter', true)` in db.js wraps any leftover
   *      `$`-keyed object in `$eq` before it reaches the driver.
   *
   * Layer 1 is the one that matters. The other two are what save you the day
   * someone adds a route and forgets it.
   */
  app.post('/users/search', async (req, res) => {
    const { email } = SearchUser.parse(req.body)
    const user = await User.findOne({ email: { $eq: email } })
    if (!user) return res.status(404).json({ error: 'user not found' })
    res.json({ orm: ORM, user })
  })

  /* ----------------------------------------------------------------- posts */

  app.get('/users/:id/posts', async (req, res) => {
    const id = IdParam.parse(req.params.id)
    const posts = await Post.find({ author: id }).sort({ createdAt: 1 })
    res.json({ orm: ORM, posts })
  })

  app.post('/users/:id/posts', async (req, res) => {
    const id = IdParam.parse(req.params.id)
    const body = CreatePost.parse(req.body)
    if (!(await User.exists({ _id: id }))) return res.status(404).json({ error: 'user not found' })
    const post = await Post.create({ ...body, author: id })
    res.status(201).json({ orm: ORM, post })
  })

  /**
   * The other direction, populated in one call for the whole page of results.
   *
   * The `authorEmail` filter is where operator injection would live, so it shows
   * the explicit form: `{ $eq: authorEmail }`. Zod already guaranteed a string,
   * and `sanitizeFilter` (set in db.js) would wrap an object anyway — this is
   * the third layer, and the one a reader can see without leaving the line.
   */
  app.get('/posts', async (req, res) => {
    const { limit } = ListQuery.parse(req.query)
    const authorEmail = z.string().max(320).optional().parse(req.query.authorEmail)

    let filter = {}
    if (authorEmail) {
      const author = await User.findOne({ email: { $eq: authorEmail } }).select('_id')
      if (!author) return res.json({ orm: ORM, posts: [] })
      filter = { author: author._id }
    }

    const posts = await Post.find(filter)
      .populate({ path: 'author', select: 'email name' })
      .sort({ createdAt: -1 })
      .limit(limit)

    res.json({ orm: ORM, posts })
  })

  /* ----------------------------------------------------------- transaction */

  /**
   * A multi-document transaction.
   *
   * MongoDB only supports these on a REPLICA SET or a sharded cluster — a
   * standalone `mongod` rejects them with "Transaction numbers are only allowed
   * on a replica set member or mongos". The route reports that as a 501 with the
   * command to fix it rather than a 500, because it is a deployment fact, not a
   * bug in the request.
   */
  app.post('/users-with-posts', async (req, res) => {
    const body = CreateUserWithPosts.parse(req.body)

    if (!(await supportsTransactions())) {
      return res.status(501).json({
        error: 'transactions require a replica set',
        hint: 'docker run --rm -p 27017:27017 mongo:8 --replSet rs0, then rs.initiate()',
      })
    }

    const session = await mongoose.startSession()
    try {
      // withTransaction commits on return, aborts on throw, and retries the
      // whole callback on a transient error — which is why the callback must be
      // idempotent and must not do anything outside the session.
      const result = await session.withTransaction(async () => {
        const [user] = await User.create([{ email: body.email, name: body.name }], { session })
        // `ordered: true` is required by Mongoose 9 when `create()` gets a
        // session and more than one document: an unordered bulk write can be
        // reordered by the server, which a transaction has no way to reason
        // about. Omit it and you get a MongooseError, not a silent bug.
        const posts = await Post.create(
          body.posts.map((p) => ({ ...p, author: user._id })),
          { session, ordered: true },
        )
        return { user, posts }
      })
      res.status(201).json({ orm: ORM, ...result })
    } finally {
      // Not optional: an unended session holds a server-side cursor and, inside
      // a transaction, its locks until the transaction lifetime limit expires.
      await session.endSession()
    }
  })

  /* ------------------------------------------------ the "raw" escape hatch */

  /**
   * The MongoDB equivalent of a raw query is an AGGREGATION PIPELINE. There is
   * no SQL string, so there is no SQL injection — but a stage is a document, and
   * a document assembled from `req.body` is exactly as dangerous:
   *
   *   UNSAFE  Model.aggregate([{ $match: req.body }])
   *   UNSAFE  Model.find({ $where: `this.email === '${email}'` })   // runs JS!
   *
   * `$where` executes JavaScript on the server; it is the one construct that
   * really is string injection, and it should simply never see user input.
   * The pipeline below is built from validated primitives only.
   */
  app.get('/stats/authors', async (req, res) => {
    const minPosts = z.coerce.number().int().min(0).max(1000).default(0).parse(req.query.minPosts)
    const authors = await User.aggregate([
      {
        $lookup: {
          from: Post.collection.name,
          localField: '_id',
          foreignField: 'author',
          as: 'posts',
        },
      },
      { $project: { _id: 0, id: '$_id', email: 1, name: 1, post_count: { $size: '$posts' } } },
      // `minPosts` is a number because Zod made it one, and it goes in as a
      // value inside a document — never spliced into a string.
      { $match: { post_count: { $gte: minPosts } } },
      { $sort: { post_count: -1, email: 1 } },
    ])
    res.json({ orm: ORM, authors })
  })

  // Express 5 / path-to-regexp v8.
  app.use('/{*splat}', (_req, res) => res.status(404).json({ error: 'not found' }))

  app.use((err, _req, res, _next) => {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: 'validation failed', issues: err.issues })
    }
    // E11000 is the duplicate-key error from the unique index — the only
    // constraint MongoDB itself enforces here.
    if (err?.code === 11000) {
      return res.status(409).json({ error: 'constraint violation', detail: `duplicate ${Object.keys(err.keyPattern ?? {}).join(', ')}` })
    }
    if (err instanceof mongoose.Error.ValidationError) {
      return res.status(400).json({ error: 'validation failed', detail: err.message })
    }
    if (err instanceof mongoose.Error.StrictModeError) {
      return res.status(400).json({ error: 'unknown field in request body', detail: err.message })
    }
    if (err instanceof mongoose.Error.CastError) {
      return res.status(400).json({ error: 'invalid identifier' })
    }
    if (err?.name === 'MongoServerSelectionError' || err?.name === 'MongoNotConnectedError') {
      return res.status(503).json({ error: 'database unavailable' })
    }
    console.error(err)
    res.status(500).json({ error: 'internal server error' })
  })

  return app
}
