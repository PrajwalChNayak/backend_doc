---
title: Seeding
description: Idempotent seeds with upserts, separating reference data from demo data, deterministic fake data, per-test strategies, and why test accounts must never reach production.
status: current
updated: 2026-09-08
---

Seeding puts rows into a database that the schema alone does not provide: the country list your foreign keys depend on, the demo data a new contributor needs, the fixtures a test asserts against. Getting it wrong produces duplicated rows on the second run and, at worst, a `admin@example.com` / `password123` account in production.

## Two kinds of seed, kept apart

They have different rules and must live in different files, invoked by different commands.

| | Reference data | Demo / development data |
| --- | --- | --- |
| Example | Countries, currencies, roles, plan tiers, feature flags, permission definitions | Sample users, fake orders, a populated dashboard |
| Required in production | **Yes** | **Never** |
| Run when | Every deploy | Local and ephemeral preview environments only |
| Must be idempotent | Yes | Yes, but it matters less |
| Owned by | The application; the app breaks without it | Developer experience |

```text
db/
  migrations/          schema changes
  seeds/
    reference/         runs everywhere, including production
      001-roles.js
      002-countries.js
    demo/              never runs in production
      001-users.js
      002-orders.js
```

```json title="package.json"
{
  "scripts": {
    "seed:reference": "node db/seeds/run.js reference",
    "seed:demo": "node db/seeds/run.js demo",
    "db:reset": "node db/reset.js && npm run migrate:up && npm run seed:reference && npm run seed:demo"
  }
}
```

The separation is what makes the production guard below enforceable: there is one command that must never run there, and it can refuse to.

:::note Reference data is not a migration
It is tempting to insert roles from a migration. Don't. Migrations are immutable once applied, so a new role or a corrected country name would need another migration, and the data drifts from what the file says. A re-runnable seed converges to the file's contents every time.
:::

## Idempotent seeds

A seed must be safe to run any number of times. Rerunning it should leave the database in the same state, not duplicate rows or error on a unique constraint.

The mechanism is an upsert with a stable natural key.

```js title="db/seeds/reference/001-roles.js"
import { pool } from '../../../src/db/pool.js'

const ROLES = [
  { key: 'owner',  label: 'Owner',  rank: 100 },
  { key: 'admin',  label: 'Admin',  rank: 50 },
  { key: 'member', label: 'Member', rank: 10 },
  { key: 'viewer', label: 'Viewer', rank: 1 },
]

export async function seed() {
  for (const role of ROLES) {
    await pool.query(
      `INSERT INTO roles (key, label, rank)
       VALUES ($1, $2, $3)
       ON CONFLICT (key) DO UPDATE
         SET label = EXCLUDED.label, rank = EXCLUDED.rank`,
      [role.key, role.label, role.rank],
    )
  }
}
```

Why this shape:

- **`key` is a natural key with a unique constraint.** Without one, `ON CONFLICT (key)` errors — the conflict target must be a unique index. A serial `id` is not a stable identity for seed data; the same row gets a different id in every environment.
- **`DO UPDATE`, not `DO NOTHING`.** Correcting a typo in `label` should propagate on the next run. `DO NOTHING` means the file and the database drift apart silently.
- **The array in the file is the source of truth.** Reading the file tells you what the table contains.

The MySQL form:

```js
await pool.execute(
  `INSERT INTO roles (\`key\`, label, \`rank\`)
   VALUES (?, ?, ?)
   ON DUPLICATE KEY UPDATE label = VALUES(label), \`rank\` = VALUES(\`rank\`)`,
  [role.key, role.label, role.rank],
)
```

And SQLite:

```js
db.prepare(
  `INSERT INTO roles (key, label, rank) VALUES (?, ?, ?)
   ON CONFLICT (key) DO UPDATE SET label = excluded.label, rank = excluded.rank`,
).run(role.key, role.label, role.rank)
```

Run the whole seed inside one transaction so a partial failure leaves nothing behind:

```js title="db/seeds/run.js"
import { withTransaction } from '../../src/db/with-transaction.js'

const [kind] = process.argv.slice(2)

if (kind === 'demo' && process.env.NODE_ENV === 'production') {
  throw new Error('refusing to run demo seeds in production')
}

const modules = await loadSeedModules(kind) // ordered by filename
await withTransaction(async (tx) => {
  for (const mod of modules) await mod.seed(tx)
})
```

### Deleting reference rows

Idempotence covers insert and update. Removing a role from the array does not remove it from the database.

Handle it explicitly, and never with a blind `DELETE` — rows are almost certainly referenced by foreign keys.

```js
const keys = ROLES.map((r) => r.key)
const { rows } = await pool.query('SELECT key FROM roles WHERE NOT (key = ANY($1::text[]))', [keys])
if (rows.length > 0) {
  console.warn('roles present in the database but not in the seed file:', rows.map((r) => r.key))
}
```

Reporting the drift and letting a human write a migration is safer than deleting rows something depends on.

## Deterministic fake data

Demo data should be **reproducible**. If every run produces different names and ids, a screenshot cannot be compared, a bug cannot be reproduced from a fixture, and a snapshot test fails at random.

The fix is a seeded pseudo-random generator, not `Math.random()`.

```js title="db/seeds/demo/random.js"
/** Small, fast, deterministic PRNG (mulberry32). Same seed, same sequence. */
export function makeRandom(seed) {
  let a = seed >>> 0
  return function random() {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export const pick = (random, list) => list[Math.floor(random() * list.length)]
```

```js title="db/seeds/demo/001-users.js"
import { makeRandom, pick } from './random.js'

const FIRST = ['Ada', 'Grace', 'Alan', 'Barbara', 'Edsger', 'Katherine']
const LAST = ['Lovelace', 'Hopper', 'Turing', 'Liskov', 'Dijkstra', 'Johnson']

export async function seed(tx) {
  const random = makeRandom(20260908) // fixed seed = identical data every run

  for (let i = 0; i < 50; i += 1) {
    const name = `${pick(random, FIRST)} ${pick(random, LAST)}`
    // Deterministic, obviously-fake, non-routable address.
    const email = `demo-user-${i}@example.invalid`

    await tx.query(
      `INSERT INTO users (email, name, role_key)
       VALUES ($1, $2, $3)
       ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name`,
      [email, name, pick(random, ['member', 'viewer'])],
    )
  }
}
```

Three deliberate choices:

- **A fixed integer seed** in the file. Change it when you want different data, and note that the change is a reviewable diff.
- **Timestamps derived from a fixed base**, not `new Date()`. Otherwise "created 3 days ago" drifts and time-sensitive tests flake.
- **`@example.invalid` addresses.** `.invalid` is reserved by RFC 2606 and can never resolve, so a misconfigured mail job cannot deliver to a real person. `@example.com` is a real domain that receives mail; do not use it as a sink.

If you prefer a library for names and addresses, that is fine — but only use one that accepts an explicit seed, and pin the version. An unseeded generator gives you a different database on every run, and a version bump can change the sequence.

## Seeding for tests

Two strategies. Pick one per test suite and be consistent.

### Transaction rollback

Wrap each test in a transaction and roll it back afterwards. Nothing is ever committed, so the database returns to its previous state exactly.

```js title="test/orders.test.js"
import { test, before, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { pool } from '../src/db/pool.js'
import { seedReference } from '../db/seeds/reference/index.js'

let client

before(async () => {
  await seedReference(pool) // committed once for the whole suite
})

beforeEach(async () => {
  client = await pool.connect()
  await client.query('BEGIN')
})

afterEach(async () => {
  await client.query('ROLLBACK')
  client.release()
})

test('creates an order', async () => {
  const { rows } = await client.query(
    'INSERT INTO orders (user_id, status) VALUES ($1, $2) RETURNING id',
    [1, 'pending'],
  )
  assert.ok(rows[0].id)
})
```

- **Fast** — a rollback is close to free, and there is no `TRUNCATE` per test.
- **Perfectly isolated**, so tests can run in any order.
- **The catch**: every query in the test *and in the code under test* must use that same `client`. Code that reaches for the module-level `pool` runs outside the transaction, sees none of the test's data, and leaves rows behind. Your code has to be written to accept an injected transaction — which is the same design [Transactions](transactions.md) recommends anyway.
- You also cannot test real commit behavior, or anything that opens its own transaction.

### Truncate and reload

Empty the tables and re-seed before each test or each file.

```js title="test/helpers/reset-db.js"
import { pool } from '../../src/db/pool.js'

export async function resetDb() {
  // RESTART IDENTITY makes generated ids deterministic across runs.
  // CASCADE handles foreign keys without needing a manual ordering.
  await pool.query('TRUNCATE TABLE order_items, orders, users RESTART IDENTITY CASCADE')
  await seedReference(pool)
}
```

- **Realistic** — the code under test uses the normal pool and its own transactions.
- **Slower.** `TRUNCATE` on a handful of small tables is a few milliseconds; across hundreds of tests it adds up.
- **`TRUNCATE` is faster than `DELETE`** for a full clear, and `RESTART IDENTITY` resets sequences so ids are stable between runs.
- Tests must not run in parallel against the same database. Give each worker its own database, or run serially.

:::best-practice The fastest option is SQLite
For test suites that do not depend on Postgres-specific behavior, a fresh SQLite file (or `:memory:`) per test file gives you total isolation in under a millisecond, with no truncation and no shared state. That is why the examples in this handbook default to SQLite. See [SQLite](sqlite.md) and [Testing with a database](../orms/testing-with-a-database.md).
:::

Whichever you choose: **build test data with factory functions, not a giant shared fixture.**

```js title="test/factories.js"
let counter = 0

export async function makeUser(tx, overrides = {}) {
  counter += 1
  const { rows } = await tx.query(
    'INSERT INTO users (email, name, role_key) VALUES ($1, $2, $3) RETURNING *',
    [
      overrides.email ?? `user-${counter}@example.invalid`,
      overrides.name ?? 'Test User',
      overrides.roleKey ?? 'member',
    ],
  )
  return rows[0]
}
```

A test that creates exactly the row it needs states its own preconditions. A shared fixture with 40 users creates invisible coupling: one test changes user 7 and three unrelated tests break.

## Never seed production with test accounts

:::danger This is a real breach vector
A demo seed that runs in production creates accounts with known emails and known passwords. Attackers scan for exactly this.

```js vulnerable title="DO NOT COPY"
await pool.query(
  'INSERT INTO users (email, password_hash, role_key) VALUES ($1, $2, $3)',
  ['admin@example.com', await bcrypt.hash('password123', 10), 'owner'],
)
```

`admin@example.com`, `test@test.com`, `demo/demo` and `admin/admin` are in every credential-stuffing list. Combined with a seeded `owner` role, one successful login is a full compromise — and because the account was created by a seed rather than a signup, nobody is monitoring it and it appears in no user-management report.
:::

Four controls, all of them cheap:

**1. Make the seed runner refuse.**

```js title="db/seeds/run.js"
if (kind === 'demo' && process.env.NODE_ENV === 'production') {
  throw new Error('refusing to run demo seeds in production')
}
```

**2. Do not put the demo seed in the deploy pipeline.** Only `seed:reference` runs on deploy. This is the control that actually matters — the guard above is the backstop for when someone runs the command by hand.

**3. Never hardcode a password, in any environment.** Generate one at run time and print it, so it is different every time and cannot be committed.

```js good title="db/seeds/demo/001-users.js"
import crypto from 'node:crypto'
import argon2 from 'argon2'

export async function seedAdmin(tx) {
  // Random every run. Printed once, never committed, never reused.
  const password = crypto.randomBytes(18).toString('base64url')

  await tx.query(
    `INSERT INTO users (email, password_hash, role_key)
     VALUES ($1, $2, $3)
     ON CONFLICT (email) DO NOTHING`,
    ['dev-admin@example.invalid', await argon2.hash(password), 'owner'],
  )

  console.log(`local admin: dev-admin@example.invalid / ${password}`)
}
```

**4. Detect it.** A scheduled check that queries production for accounts matching known demo patterns, and alerts. It costs one query and catches the case where all three controls above were bypassed by a manual run.

```js
const { rows } = await pool.query(
  `SELECT id, email FROM users
    WHERE email LIKE $1 OR email LIKE $2 OR email = ANY($3::text[])`,
  ['%@example.com', '%@example.invalid', ['admin@admin.com', 'test@test.com', 'demo@demo.com']],
)
if (rows.length > 0) alert('demo accounts present in production', rows)
```

The same reasoning applies to seeded API keys, webhook secrets and OAuth client secrets. Anything with a value written in a repository file is public.

## Security considerations

**Demo seeds must be structurally unable to run in production.** A separate command, a `NODE_ENV` guard, and absence from the deploy pipeline. Three controls, because one of them will be bypassed by someone with a terminal and a deadline.

**No credential in a seed file, ever.** Not a password, not an API key, not a webhook secret, not a JWT signing key. Committed once means public forever, including in every fork and every clone.

**Generate secrets at run time and print them.** Different on every run, impossible to commit, and the developer still gets what they need.

**Use `@example.invalid` for fake addresses.** RFC 2606 reserves it and it never resolves, so a stray mail send cannot reach a real inbox. `@example.com` is a real domain.

**Never seed with production data.** Copying a production dump into staging copies real names, emails, addresses and payment metadata into an environment with weaker access control, wider log retention and more people. If you need realistic volume, generate it. If you truly need production shape, anonymize irreversibly before it leaves production, and treat the result as still-sensitive.

**Seed data is a privilege decision.** A seeded `owner` or `superadmin` row is a permanent back door. Reference data should define roles, not grant them.

**Parameterise seed queries.** Seeds read from JSON and CSV files that someone edits, and a seed usually runs with the migration credential — the one that can drop tables. String-built SQL in a seed is injection with maximum privilege.

**Keep the reference seed reviewable.** A pull request that quietly adds a permission row to a role is an authorization change; it should read like one.

## Production considerations

- **Reference seeds run on every deploy**, after migrations, in the same pipeline step ordering. They must be idempotent, because they will run hundreds of times.
- **Seeds must be transactional.** A failure halfway through leaves the reference table in a state no code expects.
- **Order matters.** Number the files and run them in order — roles before users, countries before addresses. Do not rely on filesystem ordering being alphabetical.
- **Seed volume is a production concern.** A reference seed that upserts 50,000 rows one statement at a time takes minutes and blocks the deploy. Batch it with a multi-row `INSERT … VALUES` and a single `ON CONFLICT`.
- **Log what changed, not what ran.** "3 roles inserted, 1 updated" is useful in a deploy log; "seed complete" is not.
- **Reference data belongs in version control**, in the file, not in a database someone edited. That is the only way to know what production contains.
- **Preview environments get demo seeds; staging usually should not.** Staging is close enough to production that fake users leak into support tickets and analytics.
- **Time the reset in CI.** A `db:reset` that grows to 90 seconds silently doubles every contributor's test loop.

## Common mistakes

- **A seed that is not idempotent.** The second run fails on a unique constraint, or duplicates every row.
- **`ON CONFLICT DO NOTHING` for reference data.** Corrections never propagate, and the file stops describing the table.
- **Upserting on a serial `id`.** Ids differ per environment; use a natural key with a unique constraint.
- **`Math.random()` in demo data.** Different data every run; nothing is reproducible.
- **`new Date()` in demo data.** Relative-time assertions drift and then flake.
- **Reference data inserted from a migration.** Immutable file, mutable requirement — they diverge.
- **Hardcoded passwords.** In git forever, and in every credential-stuffing list.
- **`@example.com` addresses.** A real domain that receives real mail.
- **One demo seed command for every environment**, guarded only by a comment.
- **A production dump used as staging seed data.** A GDPR incident with extra steps.
- **A giant shared fixture.** Every test depends on data it did not create, and one change breaks five unrelated tests.
- **Truncating without `RESTART IDENTITY`.** Ids keep climbing between runs and id-sensitive assertions become order-dependent.
- **Seeds that use the module-level pool inside a rollback-based test.** They commit, and the "isolated" test leaks rows.

## Related topics

- [Migrations](migrations.md) — why reference data is a seed and not a migration.
- [Transactions](transactions.md) — the injected-`tx` pattern that makes rollback tests possible.
- [Testing with a database](../orms/testing-with-a-database.md) — per-test isolation strategies in depth.
- [SQLite](sqlite.md) — the fastest test database, and why the examples use it.
- [Password hashing](../express-libraries/password-hashing.md) — hashing a generated dev password correctly.
- [Secrets management](../security/secrets-management.md) — where credentials live instead of seed files.
- [Continuous integration](../production/ci.md) — resetting and seeding on every run.
- [Authentication and session security](../security/authentication-and-session-security.md) — why a known admin account is fatal.
