import express from 'express'
import { z } from 'zod'

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

const ListQuery = z.object({
  sort: z.enum(['id', 'email', 'name', 'created_at']).default('id'),
  direction: z.enum(['asc', 'desc']).default('asc'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
})

const IdParam = z.coerce.number().int().positive()

/** Mount the same seven routes for whichever store is passed in. */
function mountStoreRoutes(router, store) {
  router.get('/users', (req, res) => {
    const query = ListQuery.parse(req.query)
    res.json({ driver: store.driver, users: store.listUsers(query) })
  })

  router.post('/users', (req, res) => {
    const body = CreateUser.parse(req.body)
    res.status(201).json({ driver: store.driver, user: store.createUser(body) })
  })

  router.get('/users/:id', (req, res) => {
    const id = IdParam.parse(req.params.id)
    const user = store.getUser(id)
    if (!user) return res.status(404).json({ error: 'user not found' })
    res.json({ driver: store.driver, user })
  })

  router.delete('/users/:id', (req, res) => {
    const id = IdParam.parse(req.params.id)
    // ON DELETE CASCADE only fires because PRAGMA foreign_keys = ON was set.
    if (!store.deleteUser(id)) return res.status(404).json({ error: 'user not found' })
    res.status(204).end()
  })

  router.get('/users/:id/posts', (req, res) => {
    const id = IdParam.parse(req.params.id)
    if (!store.getUser(id)) return res.status(404).json({ error: 'user not found' })
    res.json({ driver: store.driver, posts: store.postsForUser(id) })
  })

  // The transaction demo: user + posts land together or not at all.
  router.post('/users-with-posts', (req, res) => {
    const body = CreateUserWithPosts.parse(req.body)
    res.status(201).json({ driver: store.driver, ...store.createUserWithPosts(body) })
  })

  return router
}

export function createApp({ nodeSqlite, betterSqlite }) {
  const app = express()
  app.use(express.json())

  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      drivers: {
        'node:sqlite': nodeSqlite.health(),
        'better-sqlite3': betterSqlite.health(),
      },
    })
  })

  app.use('/node-sqlite', mountStoreRoutes(express.Router(), nodeSqlite))
  app.use('/better-sqlite3', mountStoreRoutes(express.Router(), betterSqlite))

  // Express 5: '/*splat' — a bare '/*' is invalid under path-to-regexp v8.
  app.use('/{*splat}', (_req, res) => res.status(404).json({ error: 'not found' }))

  // Express 5 forwards rejected promises here automatically; no asyncHandler wrapper.
  app.use((err, _req, res, _next) => {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: 'validation failed', issues: err.issues })
    }
    if (err?.status) {
      return res.status(err.status).json({ error: err.message })
    }
    // The two drivers report constraint failures differently, and you have to
    // handle both if you want a 409 instead of a 500:
    //   better-sqlite3 -> err.code === 'SQLITE_CONSTRAINT_UNIQUE'
    //   node:sqlite    -> err.code === 'ERR_SQLITE_ERROR' plus the SQLite extended
    //                     error number in err.errcode (2067 = UNIQUE). The low byte
    //                     of an extended code is the primary code; 19 is CONSTRAINT.
    const isConstraint =
      (typeof err?.code === 'string' && err.code.startsWith('SQLITE_CONSTRAINT')) ||
      (err?.code === 'ERR_SQLITE_ERROR' && (err.errcode & 0xff) === 19)
    if (isConstraint) {
      return res.status(409).json({ error: 'constraint violation', detail: err.message })
    }
    console.error(err)
    res.status(500).json({ error: 'internal server error' })
  })

  return app
}
