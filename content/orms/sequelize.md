---
title: Sequelize
description: Sequelize 6.37.8 — models, associations, migrations with sequelize-cli, and the precise difference between replacements and bind.
status: current
updated: 2026-09-08
---

Sequelize is the oldest ORM in wide use in Node, and its maturity shows both ways: an enormous feature surface, a huge amount of documentation and Stack Overflow history, and an API shaped before `async`/`await` and TypeScript were the default. Version 6 is the current stable line.

This page documents **`sequelize` 6.37.8** with **`sequelize-cli` 6.6.5**.

:::warning
**Sequelize 7 is still alpha.** The `alpha` dist-tag currently points at `7.0.0-alpha.9`. It is a substantial rewrite — scoped packages per dialect, a reworked TypeScript story, decorator-based models — and it is not what you should ship. Document, learn and deploy version 6.
:::

## Why it exists

Sequelize predates almost everything else on this page, and it accumulated the whole classic ORM feature set: models with validation and lifecycle hooks, associations with eager loading, scopes, paranoid (soft) deletes, polymorphic associations, and a migration CLI. If a relational modelling idea existed in 2015, Sequelize has an implementation of it.

Its other real advantage is dialect breadth in a single stable package: PostgreSQL, MySQL, MariaDB, SQLite, Microsoft SQL Server, Snowflake, Db2 and Oracle.

## When to use it

- **You already have a Sequelize codebase.** Migrating off it is rarely worth the disruption; v6 is maintained.
- **JavaScript, not TypeScript.** Sequelize's TypeScript story is its weakest area. If you are not using TypeScript, that objection disappears.
- **You want hooks, scopes and soft deletes out of the box.** `paranoid: true` and named scopes are genuinely convenient and have no equivalent in Drizzle.
- **Validation on the model.** Per-attribute validators run before writes. It is not a substitute for request validation, but it is a useful second line.

## When not to use it

- **A new TypeScript project.** `InferAttributes` helps, but the types are bolted on and the inference is fragile compared to Prisma or Drizzle. Pick one of those.
- **You want migrations generated from your models.** Sequelize does not do this. Every migration is hand-written. See [Migration strategy](./migration-strategy.md).
- **Complex read queries.** Nested `include` with `limit` produces surprising SQL — subqueries and duplicated rows — and debugging it consumes real time.
- **Cold-start-sensitive deployments.** The package is large and model initialization is not free.

## Basic example

### Install

:::tabs
@tab npm
```bash
npm install sequelize@6.37.8 pg pg-hstore
npm install --save-dev sequelize-cli@6.6.5
```
@tab pnpm
```bash
pnpm add sequelize@6.37.8 pg pg-hstore
pnpm add -D sequelize-cli@6.6.5
```
@tab yarn
```bash
yarn add sequelize@6.37.8 pg pg-hstore
yarn add -D sequelize-cli@6.6.5
```
:::

The dialect driver is yours to install: `pg` + `pg-hstore` for PostgreSQL, `mysql2` for MySQL/MariaDB, `sqlite3` for SQLite, `tedious` for SQL Server.

Sequelize 6 declares `engines.node: >=10.0.0`, which is a legacy floor and not advice. Target Node 24 LTS.

### Connect

```js title="src/db.js"
import { Sequelize } from 'sequelize'

export const sequelize = new Sequelize(process.env.DATABASE_URL, {
  dialect: 'postgres',
  logging: false,
  pool: { max: 10, min: 0, acquire: 30_000, idle: 10_000 },
  define: { underscored: true, timestamps: true },
})
```

`define.underscored: true` maps `createdAt` in JavaScript to `created_at` in the database. Decide this on day one — changing it later is a schema migration.

### Models

```js title="src/models/user.js"
import { DataTypes, Model } from 'sequelize'
import { sequelize } from '../db.js'

export class User extends Model {}

User.init(
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    email: {
      type: DataTypes.STRING(255),
      allowNull: false,
      unique: true,
      validate: { isEmail: true },
    },
    name: { type: DataTypes.TEXT, allowNull: true },
  },
  { sequelize, modelName: 'User', tableName: 'users' },
)
```

```js title="src/models/post.js"
import { DataTypes, Model } from 'sequelize'
import { sequelize } from '../db.js'
import { User } from './user.js'

export class Post extends Model {}

Post.init(
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    title: { type: DataTypes.TEXT, allowNull: false },
    published: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  },
  {
    sequelize,
    modelName: 'Post',
    tableName: 'posts',
    indexes: [{ fields: ['author_id', 'published'] }],
  },
)

User.hasMany(Post, { as: 'posts', foreignKey: 'authorId', onDelete: 'CASCADE' })
Post.belongsTo(User, { as: 'author', foreignKey: 'authorId' })
```

Associations must be declared **after** every model is initialized. Circular imports between model files are the usual cause of "association is not defined" — put the association calls in a separate module that imports all models.

### CRUD

```js title="src/routes/users.js"
import express from 'express'
import { User } from '../models/user.js'

const router = express.Router()

router.post('/users', async (req, res) => {
  const user = await User.create({ email: req.body.email, name: req.body.name })
  res.status(201).json({ id: user.id, email: user.email, name: user.name })
})

router.get('/users/:id', async (req, res) => {
  const user = await User.findByPk(Number(req.params.id), {
    attributes: ['id', 'email', 'name'],
  })
  if (!user) return res.status(404).json({ error: 'not found' })
  res.json(user)
})

router.patch('/users/:id', async (req, res) => {
  const [count] = await User.update(
    { name: req.body.name },
    { where: { id: Number(req.params.id) } },
  )
  if (count === 0) return res.status(404).json({ error: 'not found' })
  res.json(await User.findByPk(Number(req.params.id), { attributes: ['id', 'name'] }))
})

router.delete('/users/:id', async (req, res) => {
  await User.destroy({ where: { id: Number(req.params.id) } })
  res.status(204).end()
})

export default router
```

Express 5 sends a rejected promise from an `async` handler to your error middleware, so none of these need a wrapper.

Full runnable version: [`examples/orm-sequelize`](../../examples/orm-sequelize/README.md).

## How it works

### Associations and eager loading

```js
import { Op } from 'sequelize'
import { Post } from '../models/post.js'
import { User } from '../models/user.js'

const users = await User.findAll({
  attributes: ['id', 'email'],
  include: [{
    model: Post,
    as: 'posts',
    attributes: ['id', 'title'],
    where: { published: true },
    required: false,          // LEFT JOIN; `true` (the default with `where`) makes it INNER
  }],
  limit: 20,
})
```

Two behaviours to internalize.

**`where` inside an `include` implies `required: true`**, turning the `LEFT JOIN` into an `INNER JOIN` and dropping parents with no matching children. If you want "users, with their published posts, including users who have none", you must say `required: false`.

**`limit` with a `hasMany` include changes the SQL shape.** Sequelize wraps the parent query in a subquery so the limit applies to parents rather than to joined rows. That is the correct behaviour and it is also where the confusing generated SQL comes from. Set `subQuery: false` only when you understand what it does to your limit.

`separate: true` on a `hasMany` include issues a second query instead of joining. For wide parent rows with many children, that is often much faster than the duplication a join produces.

### Transactions

The managed form commits on resolve and rolls back on throw:

```js title="src/services/transfer.js"
import { Transaction } from 'sequelize'
import { sequelize } from '../db.js'
import { Account } from '../models/account.js'

export async function transfer(fromId, toId, cents) {
  return sequelize.transaction(
    { isolationLevel: Transaction.ISOLATION_LEVELS.SERIALIZABLE },
    async (t) => {
      const from = await Account.findByPk(fromId, { transaction: t, lock: t.LOCK.UPDATE })
      if (from.balance < cents) throw new Error('insufficient funds')

      await Account.decrement('balance', { by: cents, where: { id: fromId }, transaction: t })
      await Account.increment('balance', { by: cents, where: { id: toId }, transaction: t })
    },
  )
}
```

:::warning
**Every query inside the transaction must be passed `{ transaction: t }`.** Sequelize does not thread the transaction implicitly. A query that forgets it runs on a different connection, outside the transaction, will not roll back, and can deadlock against the locks the transaction holds. This is the single most common Sequelize bug in production code.
:::

If you cannot face threading `t` through every call, Sequelize supports CLS namespaces to do it automatically — but the explicit option is easier to reason about and easier to review.

### Migrations

Sequelize does not generate migrations from models. You write them, and you also keep the models in sync by hand. That duplication is the price of Sequelize's migration story.

```bash
npx sequelize-cli init
npx sequelize-cli migration:generate --name create-users
npx sequelize-cli db:migrate
npx sequelize-cli db:migrate:status
npx sequelize-cli db:migrate:undo
```

`init` creates `config/`, `migrations/`, `models/` and `seeders/`. A `.sequelizerc` lets you point those at your own layout:

```js title=".sequelizerc"
import path from 'node:path'

export default {
  config: path.resolve('src/db/config.cjs'),
  'migrations-path': path.resolve('src/db/migrations'),
  'seeders-path': path.resolve('src/db/seeders'),
}
```

```js title="src/db/migrations/20260908120000-create-users.cjs"
'use strict'

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('users', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      email: { type: Sequelize.STRING(255), allowNull: false, unique: true },
      name: { type: Sequelize.TEXT },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('now') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('now') },
    })
    await queryInterface.addIndex('users', ['email'], { unique: true })
  },

  async down(queryInterface) {
    await queryInterface.dropTable('users')
  },
}
```

:::danger
`sequelize.sync()` and `sync({ alter: true })` change your schema to match your models at runtime. `sync({ force: true })` **drops every table first**. These are prototyping tools. Never call them in an environment with real data, and never in application startup code that runs in production.
:::

`sequelize-cli` is CommonJS-centric and its config file is easiest to keep as `.cjs` even in an ESM project. If that friction bothers you, [Umzug](https://github.com/sequelize/umzug) is the underlying migration runner and can be driven from your own ESM script.

### TypeScript story

Sequelize 6 ships types, and `InferAttributes` / `InferCreationAttributes` / `CreationOptional` make model classes reasonably typed:

```ts title="src/models/user.ts"
import {
  DataTypes, Model,
  type CreationOptional, type InferAttributes, type InferCreationAttributes,
} from 'sequelize'
import { sequelize } from '../db.js'

export class User extends Model<InferAttributes<User>, InferCreationAttributes<User>> {
  declare id: CreationOptional<number>
  declare email: string
  declare name: string | null
  declare createdAt: CreationOptional<Date>
}

User.init(
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    email: { type: DataTypes.STRING(255), allowNull: false, unique: true },
    name: { type: DataTypes.TEXT },
    createdAt: DataTypes.DATE,
  },
  { sequelize, tableName: 'users' },
)
```

Every field needs `declare` so it does not emit a class field that shadows Sequelize's getter — this is a real runtime bug, not a lint preference.

The limits are worth stating plainly. `attributes: ['id', 'email']` does not narrow the return type. Includes do not add typed properties to the result — `user.posts` needs a manual declaration. And the model definition object and the TypeScript declarations are two separate sources of truth that nothing checks against each other. If exact types matter to you, this is the wrong ORM.

### Connection pooling

```js title="src/db.js"
export const sequelize = new Sequelize(process.env.DATABASE_URL, {
  dialect: 'postgres',
  pool: {
    max: Number(process.env.DB_POOL_MAX ?? 10),
    min: 0,
    acquire: 30_000,   // ms to wait for a connection before throwing
    idle: 10_000,      // ms an idle connection is kept
    evict: 1_000,      // ms between idle-connection sweeps
  },
})
```

`acquire` is the one that decides your failure mode under load. At 30 seconds, a pool exhaustion turns into thirty seconds of piled-up requests before anything errors; lower it to a few seconds so requests fail fast and your load balancer can shed them.

`max` × replica count is your real connection count against the database. See [Connection pooling](../databases/connection-pooling.md).

## Common patterns

### Scopes for reusable filters

```js
Post.addScope('published', { where: { published: true } })
Post.addScope('recent', { order: [['createdAt', 'DESC']], limit: 20 })

const rows = await Post.scope('published', 'recent').findAll()
```

### Soft deletes

```js
Post.init({ /* … */ }, { sequelize, tableName: 'posts', paranoid: true })

await post.destroy()                    // sets deleted_at
await Post.findAll()                    // excludes soft-deleted
await Post.findAll({ paranoid: false }) // includes them
```

Soft deletes interact badly with unique constraints — a soft-deleted row still occupies the unique email. Use a partial unique index (`WHERE deleted_at IS NULL`) in a migration.

## Security considerations

### replacements vs bind — the distinction that matters

Sequelize's raw API is `sequelize.query(sql, options)`, and it offers two ways to get values into the statement. They are not interchangeable.

| | `replacements` | `bind` |
| --- | --- | --- |
| Syntax | `:name` or `?` | `$1` / `$name` |
| Who handles the value | **Sequelize** escapes it and splices it into the SQL text | The **driver** sends it as a real bind parameter, outside the SQL text |
| What the database receives | One fully-formed SQL string | A statement with placeholders, plus a separate value list |
| Escaping bugs possible? | In principle yes — it is escaping | No — the value never touches the parser |

The documentation states it directly: replacements "are escaped and inserted into the query by sequelize before the query is sent to the database", whereas bind parameters "are sent to the database outside the SQL query text".

Both are safe against injection when used correctly. **Prefer `bind`** — it is the stronger guarantee, because a value that never enters the SQL text cannot be parsed as SQL no matter what escaping does.

```js good title="src/repos/search.js"
import { QueryTypes } from 'sequelize'
import { sequelize } from '../db.js'

// bind — real driver-level bind parameters
const rows = await sequelize.query(
  'SELECT id, email FROM users WHERE email = $1 AND active = $2',
  { bind: [req.body.email, true], type: QueryTypes.SELECT },
)

// replacements — escaped by Sequelize, then interpolated
const rows2 = await sequelize.query(
  'SELECT id, email FROM users WHERE status = :status',
  { replacements: { status: req.query.status }, type: QueryTypes.SELECT },
)
```

`replacements` earns its place in one case: expanding an array into an `IN` list, which bind parameters cannot do portably.

```js good
const rows = await sequelize.query(
  'SELECT id, title FROM posts WHERE status IN (:statuses)',
  { replacements: { statuses: ['draft', 'published'] }, type: QueryTypes.SELECT },
)
```

Named bind parameters use `$name`; a literal dollar sign in the SQL is escaped as `$$`.

### String interpolation is the hole

Neither mechanism helps if you build the string yourself:

```js vulnerable title="DO NOT COPY"
// curl "localhost:3000/users?email=x'%20OR%20'1'%3D'1"
const rows = await sequelize.query(
  `SELECT id, email, password_hash FROM users WHERE email = '${req.query.email}'`,
  { type: QueryTypes.SELECT },
)
```

That request returns every user and every password hash. The fix is to move the value out of the string:

```js good title="src/repos/search.js"
const rows = await sequelize.query(
  'SELECT id, email FROM users WHERE email = $1',
  { bind: [req.query.email], type: QueryTypes.SELECT },
)
```

:::danger
Passing `replacements` or `bind` does **not** retroactively make an interpolated string safe. The options only govern the placeholders. If `req.query.email` is already inside the template literal, the injection has already happened by the time Sequelize sees the query.
:::

### What parameterization does not cover

Table names, column names and `ORDER BY` are syntax. `replacements` will escape a value as a *string literal*, which is the wrong thing entirely for an identifier — `ORDER BY :sort` with `sort = 'name'` becomes `ORDER BY 'name'`, sorting every row by the constant string `name`.

Allow-list them:

```js good title="src/repos/posts.js"
import { QueryTypes } from 'sequelize'
import { sequelize } from '../db.js'

const SORT_COLUMNS = new Map([['created_at', 'created_at'], ['title', 'title']])
const DIRECTIONS = new Map([['asc', 'ASC'], ['desc', 'DESC']])

export async function listPosts({ sort = 'created_at', dir = 'desc', limit = 50 }) {
  const column = SORT_COLUMNS.get(sort)
  const direction = DIRECTIONS.get(dir)
  if (!column || !direction) throw new Error('invalid sort')

  // lint-sql:allow column and direction come from the SORT_COLUMNS/DIRECTIONS maps above
  const sql = `SELECT id, title FROM posts ORDER BY ${column} ${direction} LIMIT $1`
  return sequelize.query(sql, { bind: [limit], type: QueryTypes.SELECT })
}
```

The `LIMIT` stays a bind parameter. Only the identifier is interpolated, and only after being mapped to a literal you wrote.

In the model API, `order` takes column references that Sequelize escapes as identifiers, so the safe form needs no raw SQL:

```js good
await Post.findAll({ order: [['createdAt', 'DESC']], limit })
```

Use `sequelize.col()` and `sequelize.literal()` sparingly. `literal()` is Sequelize's `raw` — its contents are spliced into the SQL untouched, so anything user-controlled inside it is an injection.

### Operator injection through where

Sequelize 6 disabled string operator aliases (`$gt`, `$like`), so a JSON body cannot smuggle an operator through a key name the way it can in a MongoDB query. It does not follow that `where: req.query` is safe — an attacker still chooses which columns are filtered and on what. Build `where` from named, validated fields.

### Mass assignment

```js vulnerable title="DO NOT COPY"
await User.create(req.body)  // sets role, isAdmin, emailVerified…
```

Sequelize's `create` and `update` accept a `fields` allow-list, which is a useful backstop:

```js good
await User.create(req.body, { fields: ['email', 'name'] })
```

Validate the body first regardless. See [Mass assignment](../security/mass-assignment.md).

## Production considerations

**Never call `sync()` in production.** Migrations only. `sync({ force: true })` drops every table.

**Run migrations as a release step, not from the app.** `sequelize-cli db:migrate` in your deploy job. See [Migration strategy](./migration-strategy.md).

**Lower `pool.acquire`.** The 30-second default converts pool exhaustion into a 30-second queue. A few seconds fails fast and lets the load balancer route around the instance.

**Turn `logging` off in production and route slow queries to your logger.** The default logs every statement to `console.log`, which is expensive and leaks parameter values.

```js
export const sequelize = new Sequelize(url, {
  dialect: 'postgres',
  benchmark: true,
  logging: (sql, ms) => { if (ms > 200) logger.warn({ sql, ms }, 'slow query') },
})
```

**Keep models and migrations in sync deliberately.** Nothing checks them against each other. A model change without a migration passes tests against a `sync()`ed test database and fails in production. Run tests against migrated schemas — see [Testing with a database](./testing-with-a-database.md).

**Audit for missing `{ transaction: t }`.** A grep for `transaction:` inside your transaction callbacks is a legitimate code-review step.

**Add a partial unique index for any `paranoid` model with a unique column.** Soft-deleted rows still hold the constraint.

**Close the connection on shutdown.** `await sequelize.close()` on `SIGTERM`.

## Common mistakes

- **Forgetting `{ transaction: t }` on a query inside a transaction.** It silently runs outside the transaction.
- **`sync({ alter: true })` in a deployed environment.** Schema changes at runtime, no history, no review.
- **Expecting `include` with `where` to keep childless parents.** It becomes an `INNER JOIN`; set `required: false`.
- **Fighting the subquery that `limit` + `hasMany` produces** instead of understanding it, or reaching for `subQuery: false` and getting the wrong number of parents.
- **Interpolating into `sequelize.query()`** and assuming `replacements` covers it. It does not.
- **Using `replacements` for an identifier.** It escapes as a string literal, so `ORDER BY 'name'` sorts by a constant.
- **Putting user input inside `sequelize.literal()`.** That is raw SQL.
- **Model fields without `declare` in TypeScript.** The emitted class field shadows Sequelize's getter and reads `undefined`.
- **`User.create(req.body)`.** Mass assignment; pass `fields`.
- **Assuming a passing test means the migration exists.** Models and migrations are separate; only migrations touch production.
- **Reaching for Sequelize 7.** It is alpha.

## Related topics

- [Comparison table](./comparison.md) — Sequelize against the other five.
- [Prisma](./prisma.md) — the usual recommendation for a new TypeScript project.
- [Knex](./knex.md) — Sequelize's query-builder-only alternative, with a similar migration CLI.
- [Migration strategy](./migration-strategy.md) — hand-written migrations and keeping models in step.
- [Testing with a database](./testing-with-a-database.md) — migrate the test database instead of `sync()`.
- [SQL injection](../security/sql-injection.md) — the threat behind the `bind` recommendation.
- [Connection pooling](../databases/connection-pooling.md) — sizing `pool.max` and `pool.acquire`.
- [Mass assignment](../security/mass-assignment.md) — why `create(req.body)` is a hole.
- [`examples/orm-sequelize`](../../examples/orm-sequelize/README.md) — the runnable version of this page.
