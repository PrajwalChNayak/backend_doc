import express from 'express'
import { z } from 'zod'
import { QueryTypes, UniqueConstraintError, ValidationError } from 'sequelize'
import { sequelize, User, Post } from './db.js'
import { SORTABLE_USER_COLUMNS } from './models.js'

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

const ORM = 'sequelize'

export function createApp() {
  const app = express()
  app.use(express.json({ limit: '100kb' }))

  app.get('/health', async (_req, res) => {
    res.json({ status: 'ok', orm: ORM, users: await User.count() })
  })

  /* ----------------------------------------------------------------- users */

  app.get('/users', async (req, res) => {
    const { sort, direction, limit } = ListQuery.parse(req.query)
    // Sequelize quotes an `order` column, but it does not check that a client
    // was allowed to name it. The Set does.
    if (!SORTABLE_USER_COLUMNS.has(sort)) {
      return res.status(400).json({ error: `unsortable column: ${sort}` })
    }
    const users = await User.findAll({
      order: [[sort, direction === 'desc' ? 'DESC' : 'ASC']],
      limit,
    })
    res.json({ orm: ORM, users })
  })

  app.post('/users', async (req, res) => {
    const body = CreateUser.parse(req.body)
    // `fields` pins exactly which columns may be written. Without it,
    // `User.create(req.body)` would happily accept an `id` from the client.
    const user = await User.create(body, { fields: ['email', 'name'] })
    res.status(201).json({ orm: ORM, user })
  })

  /**
   * Eager loading. `include` turns this into one query with a LEFT JOIN, and
   * the rows come back nested under the association alias.
   *
   * The N+1 you are avoiding: `findAll()` with no `include`, then `await
   * user.getPosts()` inside a loop. That is one query per user, and it looks
   * fine until the table has ten thousand rows.
   */
  app.get('/users/:id', async (req, res) => {
    const id = IdParam.parse(req.params.id)
    const user = await User.findByPk(id, {
      include: [{ model: Post, as: 'posts' }],
      order: [[{ model: Post, as: 'posts' }, 'id', 'ASC']],
    })
    if (!user) return res.status(404).json({ error: 'user not found' })
    res.json({ orm: ORM, user })
  })

  app.patch('/users/:id', async (req, res) => {
    const id = IdParam.parse(req.params.id)
    const { name } = PatchUser.parse(req.body)
    const [affected] = await User.update({ name }, { where: { id }, fields: ['name'] })
    if (!affected) return res.status(404).json({ error: 'user not found' })
    res.json({ orm: ORM, user: await User.findByPk(id) })
  })

  app.delete('/users/:id', async (req, res) => {
    const id = IdParam.parse(req.params.id)
    const destroyed = await User.destroy({ where: { id } })
    if (!destroyed) return res.status(404).json({ error: 'user not found' })
    res.status(204).end()
  })

  /* ----------------------------------------------------------------- posts */

  app.get('/users/:id/posts', async (req, res) => {
    const id = IdParam.parse(req.params.id)
    const posts = await Post.findAll({ where: { userId: id }, order: [['id', 'ASC']] })
    res.json({ orm: ORM, posts })
  })

  app.post('/users/:id/posts', async (req, res) => {
    const id = IdParam.parse(req.params.id)
    const body = CreatePost.parse(req.body)
    const user = await User.findByPk(id)
    if (!user) return res.status(404).json({ error: 'user not found' })
    const post = await user.createPost(body, { fields: ['title', 'body', 'userId'] })
    res.status(201).json({ orm: ORM, post })
  })

  // The relation from the other side, with the author eager-loaded and a
  // filter applied to the joined table.
  app.get('/posts', async (req, res) => {
    const { limit } = ListQuery.parse(req.query)
    const authorEmail = z.string().max(320).optional().parse(req.query.authorEmail)

    const posts = await Post.findAll({
      include: [
        {
          model: User,
          as: 'author',
          attributes: ['id', 'email', 'name'],
          // A `where` on an include turns the LEFT JOIN into an INNER JOIN and
          // is parameterised like any other where clause.
          ...(authorEmail ? { where: { email: authorEmail } } : {}),
        },
      ],
      order: [['id', 'DESC']],
      limit,
    })
    res.json({ orm: ORM, posts })
  })

  /* ----------------------------------------------------------- transaction */

  app.post('/users-with-posts', async (req, res) => {
    const body = CreateUserWithPosts.parse(req.body)
    // The managed form: Sequelize commits when the callback resolves and rolls
    // back when it rejects. Every query inside MUST be passed `{ transaction }`
    // — Sequelize has no ambient transaction, so a query that forgets it runs
    // on a different connection and is not rolled back with the rest.
    const user = await sequelize.transaction(async (transaction) => {
      const created = await User.create(
        { email: body.email, name: body.name, posts: body.posts },
        { include: [{ model: Post, as: 'posts' }], transaction },
      )
      return created
    })
    res.status(201).json({ orm: ORM, user })
  })

  /* ------------------------------------------------- the raw escape hatch */

  /**
   * `sequelize.query()` has TWO parameter mechanisms and they are not the same
   * thing:
   *
   *   replacements  Sequelize substitutes the values into the SQL string ITSELF,
   *                 escaping each one for the target dialect, and sends one
   *                 finished statement. `:name` or `?`.
   *   bind          Sequelize sends the SQL and the values SEPARATELY, and the
   *                 database driver binds them. `$1`, `$2` (`$name` also works).
   *
   * Both are safe against injection when you actually use them. The differences
   * that matter in practice:
   *   - `bind` never builds a string containing your data, so it is the stronger
   *     guarantee and it lets the database cache the plan.
   *   - `replacements` can expand a LIST (`IN (:ids)`) and can be used where a
   *     placeholder is not allowed; `bind` cannot.
   *   - You cannot mix `bind` and `replacements` in one call.
   *
   * What is NOT safe, with either option present, is putting the value in the
   * string yourself:
   *
   *   sequelize.query(statementYouBuiltByInterpolatingEmail)   // hole
   *
   * The README shows that exploit in full. The query below uses `bind`. The same query with `replacements: { minPosts }`
   * and `:minPosts` in the SQL would be equally injection-proof.
   */
  app.get('/stats/authors', async (req, res) => {
    const minPosts = z.coerce.number().int().min(0).max(1000).default(0).parse(req.query.minPosts)
    const authors = await sequelize.query(
      `SELECT u.id, u.email, u.name, COUNT(p.id) AS post_count
         FROM users u
         LEFT JOIN posts p ON p.user_id = u.id
        GROUP BY u.id
       HAVING COUNT(p.id) >= $1
        ORDER BY post_count DESC, u.id ASC`,
      { bind: [minPosts], type: QueryTypes.SELECT },
    )
    res.json({ orm: ORM, authors })
  })

  // Express 5 / path-to-regexp v8.
  app.use('/{*splat}', (_req, res) => res.status(404).json({ error: 'not found' }))

  app.use((err, _req, res, _next) => {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: 'validation failed', issues: err.issues })
    }
    // Sequelize normalises driver errors, so the same class covers every
    // dialect — this is one of the real benefits of the abstraction.
    if (err instanceof UniqueConstraintError) {
      return res.status(409).json({
        error: 'constraint violation',
        detail: err.errors?.map((e) => e.message).join('; ') || err.message,
      })
    }
    if (err instanceof ValidationError) {
      return res.status(400).json({
        error: 'validation failed',
        detail: err.errors?.map((e) => e.message).join('; ') || err.message,
      })
    }
    console.error(err)
    res.status(500).json({ error: 'internal server error' })
  })

  return app
}
