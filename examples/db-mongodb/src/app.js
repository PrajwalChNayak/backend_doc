import express from 'express'
import { ObjectId } from 'mongodb'
import { z } from 'zod'
import { users, posts, ping, isDatabaseUnavailable, unavailableBody, DOCKER_RUN } from './db.js'
import { hashPassword, verifyPassword } from './password.js'

/**
 * Zod does the security work here, not the driver.
 *
 * `z.string()` REJECTS an object. That is what stops
 * `{"email":{"$gt":""},"password":{"$ne":null}}` from ever reaching a filter —
 * see the long comment on POST /login.
 */
const Register = z.object({
  email: z.email().max(254),
  name: z.string().min(1).max(120),
  password: z.string().min(8).max(200),
})

const Credentials = z.object({
  email: z.email().max(254),
  password: z.string().min(8).max(200),
})

const CreatePost = z.object({
  title: z.string().min(1).max(200),
  body: z.string().max(5000).default(''),
})

const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
})

/** `_id` must be a 24-character hex string or `new ObjectId()` throws. */
const ObjectIdParam = z
  .string()
  .regex(/^[0-9a-fA-F]{24}$/, 'must be a 24-character hex ObjectId')
  .transform((value) => new ObjectId(value))

const publicUser = (doc) =>
  doc && { id: doc._id.toString(), email: doc.email, name: doc.name, createdAt: doc.createdAt }

export function createApp(state) {
  const app = express()
  app.use(express.json())

  app.get('/health', async (_req, res) => {
    if (!state.dbReady) {
      return res
        .status(503)
        .json({ status: 'degraded', database: 'unreachable', hint: `start MongoDB with: ${DOCKER_RUN}` })
    }
    try {
      const start = performance.now()
      await ping()
      res.json({ status: 'ok', database: 'up', latencyMs: Math.round(performance.now() - start) })
    } catch (err) {
      res.status(503).json({
        status: 'degraded',
        database: 'unreachable',
        error: err.message,
        hint: `start MongoDB with: ${DOCKER_RUN}`,
      })
    }
  })

  // ---------------------------------------------------------------- users CRUD

  app.get('/users', async (req, res) => {
    const { limit } = ListQuery.parse(req.query)
    // Projection: never ship the password hash, not even to yourself.
    const docs = await users
      .find({}, { projection: { passwordHash: 0 }, limit, sort: { _id: 1 } })
      .toArray()
    res.json({ users: docs.map(publicUser) })
  })

  app.post('/users', async (req, res) => {
    const { email, name, password } = Register.parse(req.body)
    const doc = {
      email,
      name,
      passwordHash: await hashPassword(password),
      createdAt: new Date(),
    }
    const { insertedId } = await users.insertOne(doc)
    res.status(201).json({ user: publicUser({ ...doc, _id: insertedId }) })
  })

  app.get('/users/:id', async (req, res) => {
    const _id = ObjectIdParam.parse(req.params.id)
    const doc = await users.findOne({ _id }, { projection: { passwordHash: 0 } })
    if (!doc) return res.status(404).json({ error: 'user not found' })
    res.json({ user: publicUser(doc) })
  })

  app.patch('/users/:id', async (req, res) => {
    const _id = ObjectIdParam.parse(req.params.id)
    const { name } = z.object({ name: z.string().min(1).max(120) }).parse(req.body)
    // $set with a validated, whitelisted field. Spreading req.body into $set is
    // mass assignment: a client could set passwordHash, or role, or isAdmin.
    const doc = await users.findOneAndUpdate(
      { _id },
      { $set: { name, updatedAt: new Date() } },
      { returnDocument: 'after', projection: { passwordHash: 0 } },
    )
    if (!doc) return res.status(404).json({ error: 'user not found' })
    res.json({ user: publicUser(doc) })
  })

  app.delete('/users/:id', async (req, res) => {
    const _id = ObjectIdParam.parse(req.params.id)
    const { deletedCount } = await users.deleteOne({ _id })
    if (deletedCount === 0) return res.status(404).json({ error: 'user not found' })
    // Mongo has no foreign keys: cascading is your job.
    await posts.deleteMany({ userId: _id })
    res.status(204).end()
  })

  // ---------------------------------------------------------------- posts

  app.post('/users/:id/posts', async (req, res) => {
    const userId = ObjectIdParam.parse(req.params.id)
    const { title, body } = CreatePost.parse(req.body)
    if (!(await users.findOne({ _id: userId }, { projection: { _id: 1 } }))) {
      return res.status(404).json({ error: 'user not found' })
    }
    const doc = { userId, title, body, createdAt: new Date() }
    const { insertedId } = await posts.insertOne(doc)
    res.status(201).json({ post: { id: insertedId.toString(), ...doc, userId: userId.toString() } })
  })

  app.get('/users/:id/posts', async (req, res) => {
    const userId = ObjectIdParam.parse(req.params.id)
    // Served entirely by the { userId: 1, createdAt: -1 } index built at boot.
    const docs = await posts.find({ userId }, { sort: { createdAt: -1 }, limit: 100 }).toArray()
    res.json({
      posts: docs.map((d) => ({
        id: d._id.toString(),
        userId: d.userId.toString(),
        title: d.title,
        body: d.body,
        createdAt: d.createdAt,
      })),
    })
  })

  // ---------------------------------------------------------------- login

  /**
   * THE OPERATOR-INJECTION DEFENCE.
   *
   * MongoDB filters are documents, not strings, so there is no "SQL injection"
   * here — but there is something just as bad. `express.json()` will happily
   * parse this body:
   *
   *     {"email": {"$gt": ""}, "password": {"$ne": null}}
   *
   * If those values went straight into a filter:
   *
   *     await users.findOne({ email: req.body.email, password: req.body.password })
   *
   * the driver would send `{ email: { $gt: '' }, password: { $ne: null } }` —
   * a perfectly valid query meaning "any user whose email sorts after the empty
   * string and whose password is not null". That is *every user*. `findOne`
   * returns the first one, and the attacker is logged in as them with no
   * password at all. `{"$regex": "^a"}` turns it into a character-by-character
   * oracle for brute-forcing a real value.
   *
   * The fix is not to escape anything. It is to guarantee the values are
   * strings before they become part of a document:
   *
   *   1. `Credentials.parse(req.body)` — z.string() rejects objects and arrays
   *      outright, so the request is a 400 before any query is built.
   *   2. `{ email: { $eq: email } }` — explicit $eq. Even if a non-string ever
   *      slipped through, $eq compares the value as a literal instead of letting
   *      it be interpreted as an operator document.
   *   3. The password is never in the filter at all. It is compared against a
   *      hash in Node, in constant time, after the user document is fetched.
   *      A password that is part of a query is a password that can be probed.
   */
  app.post('/login', async (req, res) => {
    const { email, password } = Credentials.parse(req.body)

    const user = await users.findOne({ email: { $eq: email } })

    // Do the hash comparison even when the user does not exist, so the response
    // time does not tell an attacker which emails are registered.
    const ok = await verifyPassword(password, user?.passwordHash ?? 'scrypt$AAAA$AAAA')

    if (!user || !ok) return res.status(401).json({ error: 'invalid credentials' })
    res.json({ user: publicUser(user) })
  })

  app.use('/{*splat}', (_req, res) => res.status(404).json({ error: 'not found' }))

  app.use((err, _req, res, _next) => {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: 'validation failed', issues: err.issues })
    }
    if (err.code === 11000) return res.status(409).json({ error: 'already exists' })
    // A dependency being down is a 503, not a 500 — and never a hang. Express 5
    // forwards the rejection from any `await users.…` here automatically, so this
    // one branch covers every route in the file. Matching only
    // MongoServerSelectionError is not enough: once the client has given up it
    // closes its topology and every later operation is a MongoTopologyClosedError.
    if (isDatabaseUnavailable(err)) {
      return res.status(503).json(unavailableBody(err))
    }
    console.error(err)
    res.status(500).json({ error: 'internal server error' })
  })

  return app
}
