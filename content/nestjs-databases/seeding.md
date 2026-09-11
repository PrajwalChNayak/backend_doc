---
title: Seeding
description: Seeding a Nest application through NestFactory.createApplicationContext so seeds reuse your providers — idempotent upserts, reference data versus demo data, and never putting test accounts in production.
status: current
updated: 2026-09-11
---

A seed script written outside the application ends up with its own database connection, its own password-hashing code and its own idea of what a valid user looks like — and all three drift. Nest has a better answer: `NestFactory.createApplicationContext` boots the module graph with no HTTP server, so a seed can inject the same services the API uses. The database-level material — idempotency, deterministic fake data, truncate-and-reload — is in [Seeding](../databases/seeding.md); this page is about doing it through the container.

## Two kinds of seed, kept apart

They have different lifecycles, different audiences and different risks. Conflating them is how demo accounts reach production.

| | Reference data | Development / demo data |
| --- | --- | --- |
| Examples | countries, currencies, plan tiers, permission names, feature flags | 500 fake users, sample orders, a signed-in demo account |
| Where it runs | **every** environment, including production | local and ephemeral preview environments only |
| How it runs | as part of the deploy, after migrations | by hand, or when a preview environment is created |
| Must be idempotent | yes | it is recreated from scratch anyway |
| Lives in | `src/database/seeds/reference/` | `src/database/seeds/dev/` |

Keep them in separate directories with separate entry points. A single `seed` script with an `if (isDev)` branch is one merge away from running the wrong half.

## A standalone application context

`createApplicationContext` gives you the container without a listener: providers are constructed, `onModuleInit` runs, and `app.get()` resolves anything the module graph exports.

```ts title="src/database/seeds/reference/main.ts"
import { Logger } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { AppModule } from '../../../app.module.js'
import { PlansSeeder } from './plans.seeder.js'
import { PermissionsSeeder } from './permissions.seeder.js'

const logger = new Logger('seed:reference')

const app = await NestFactory.createApplicationContext(AppModule, {
  // Keep the output quiet enough to read in a CI log.
  logger: ['error', 'warn', 'log'],
})

try {
  await app.get(PermissionsSeeder).run()
  await app.get(PlansSeeder).run()
  logger.log('reference data is up to date')
} catch (err) {
  logger.error(`seed failed: ${(err as Error).message}`)
  process.exitCode = 1
} finally {
  // Closes the pool and runs every shutdown hook. Without it the process
  // hangs with an open connection and CI kills it on a timeout.
  await app.close()
}
```

Four things that make this worth doing over a standalone script:

- **The seeder is a provider.** It injects `UsersService`, `PasswordHasher`, `ConfigService` — the real ones. A seeded password is hashed by the same code that verifies it at login, which is not true of a script that reaches for `argon2` directly.
- **Configuration is validated.** The same `ConfigModule` schema runs, so a seed cannot silently connect to the wrong database because `DATABASE_URL` was unset.
- **`app.close()` closes everything.** Pools, Redis clients, scheduled timers. A script that forgets this leaves the process hanging, and the usual "fix" is a `process.exit(0)` that also abandons in-flight writes.
- **`process.exitCode = 1` on failure.** A seed that logs an error and exits 0 is a deploy step that cannot fail, which means it is not a deploy step at all.

:::warning What `createApplicationContext` also does
It constructs *every* provider in `AppModule`, which includes `@nestjs/schedule` cron jobs, BullMQ workers and any `onApplicationBootstrap` hook that starts a timer. In a seed process those are at best noise and at worst a second worker consuming the production queue.

Give the seed its own root module that imports only what it needs:

```ts title="src/database/seeds/seed.module.ts"
import { Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { DatabaseModule } from '../database.module.js'
import { PlansSeeder } from './reference/plans.seeder.js'
import { PermissionsSeeder } from './reference/permissions.seeder.js'

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), DatabaseModule],
  providers: [PlansSeeder, PermissionsSeeder],
})
export class SeedModule {}
```

Then bootstrap `SeedModule` instead of `AppModule`. You keep the providers you want and none of the background machinery.
:::

```json title="package.json"
{
  "scripts": {
    "seed:reference": "node dist/database/seeds/reference/main.js",
    "seed:dev": "node dist/database/seeds/dev/main.js"
  }
}
```

## Idempotent seeds

A reference seed runs on every deploy, so running it twice must be indistinguishable from running it once. That means an upsert keyed on a **natural key** — a code, a slug, a name — never on a generated id.

```ts title="src/database/seeds/reference/plans.seeder.ts"
import { Injectable, Logger } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { Repository } from 'typeorm'
import { Plan } from '../../../billing/plan.entity.js'

const PLANS: readonly Pick<Plan, 'code' | 'name' | 'monthlyCents' | 'seatLimit'>[] = [
  { code: 'free', name: 'Free', monthlyCents: 0, seatLimit: 3 },
  { code: 'team', name: 'Team', monthlyCents: 4900, seatLimit: 25 },
  { code: 'business', name: 'Business', monthlyCents: 19900, seatLimit: 250 },
]

@Injectable()
export class PlansSeeder {
  private readonly logger = new Logger(PlansSeeder.name)
  private readonly plans: Repository<Plan>

  constructor(@InjectRepository(Plan) plans: Repository<Plan>) {
    this.plans = plans
  }

  async run() {
    // upsert() is INSERT … ON CONFLICT (code) DO UPDATE. One statement,
    // atomic, and safe to run concurrently with another copy of itself.
    await this.plans.upsert([...PLANS], { conflictPaths: ['code'] })
    this.logger.log(`${PLANS.length} plans reconciled`)
  }
}
```

`upsert` requires a unique constraint on `code` — without one the conflict target does not exist and the statement errors. That constraint belongs in a migration, which is why seeds run *after* migrations.

The same thing in Prisma:

```ts title="src/database/seeds/reference/plans.seeder.ts"
async run() {
  for (const plan of PLANS) {
    await this.prisma.plan.upsert({
      where: { code: plan.code },
      create: plan,
      update: { name: plan.name, monthlyCents: plan.monthlyCents, seatLimit: plan.seatLimit },
    })
  }
}
```

Note what `update` does **not** include: `code`, and nothing that an operator might reasonably have changed in production. An upsert that overwrites every column on every deploy silently reverts manual fixes. Update only the fields the code owns.

:::danger Deleting reference rows is not idempotent
A seed that reconciles by deleting rows not in its list looks correct and is a data-loss bug: a plan removed from the array is `DELETE`d, and every `FOREIGN KEY` pointing at it either cascades or blocks the deploy.

Retire reference data with a flag, never a delete:

```ts
await this.plans.update({ code: 'legacy-pro' }, { retiredAt: new Date() })
```

Rows that are referenced by customer data are not yours to remove.
:::

Whatever the tool, the properties to hold are the same: keyed on a natural key, safe to run twice, safe to run concurrently with itself (two replicas of a deploy job), and it does not delete.

## Development data

Demo data does not need to be idempotent, because you recreate the database. It does need to be **deterministic** — a fixed seed value for the random generator — so that a bug someone reproduces locally is reproducible for you too, and so a test that asserts "the third user" is not flaky.

```ts title="src/database/seeds/dev/users.seeder.ts"
import { Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { UsersService } from '../../../users/users.service.js'

@Injectable()
export class DevUsersSeeder {
  private readonly logger = new Logger(DevUsersSeeder.name)
  private readonly users: UsersService
  private readonly config: ConfigService

  constructor(users: UsersService, config: ConfigService) {
    this.users = users
    this.config = config
  }

  async run(count = 50) {
    // The guard is inside the seeder, not only in the script that calls it.
    if (this.config.getOrThrow<string>('NODE_ENV') === 'production') {
      throw new Error('refusing to run development seeds in production')
    }

    for (let i = 0; i < count; i++) {
      // A deterministic, obviously-fake address on a reserved domain.
      await this.users.create({
        email: `user${i}@example.invalid`,
        displayName: `Demo User ${i}`,
        password: this.config.getOrThrow<string>('DEV_SEED_PASSWORD'),
      })
    }
    this.logger.log(`${count} demo users created`)
  }
}
```

`this.users.create()` rather than `repository.insert()` is the whole reason to seed through the container. The service hashes the password, normalises the email, emits the `user.created` event and enforces the invariants — so the seeded rows are rows the application would actually have produced. Seeding around the service gives you data your application considers invalid, and the resulting bug report says "it only happens with seeded data".

`example.invalid` is a reserved TLD that can never resolve, so a stray notification cannot reach a real inbox.

## Never seed production with test accounts

:::danger This is a real breach class, not a hypothetical
```ts vulnerable title="DO NOT COPY — src/database/seeds/seed.ts"
await this.users.create({
  email: 'admin@example.com',
  password: 'admin123',
  roles: ['admin'],
})
```

The failure chain is always the same. The seed was written for local development. Someone made it part of the deploy so preview environments would have a login. Preview shares a deploy path with production. Six months later an unmodified account with a known password and the `admin` role exists in production, and it does not look out of place in a user table with fifty thousand rows.

Attackers scan for exactly this. `admin@example.com`, `test@test.com`, `demo/demo` and the default credentials of every popular framework are in the first page of every credential-stuffing list.
:::

Three controls, and you want all three:

**1. A hard environment guard inside the seeder,** as above. Not in the shell script that calls it — in the code, where it survives someone running the script by hand.

**2. No hard-coded credentials, ever.** Even in a development seed, the password comes from `DEV_SEED_PASSWORD` and the script fails without it. That makes a copied seed useless in an environment where the variable is not set, which is the point.

**3. A test that asserts the absence.** The only control that keeps working after everyone who remembers this page has left.

```ts title="test/no-seeded-admins.e2e-spec.ts"
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Test } from '@nestjs/testing'
import { getRepositoryToken } from '@nestjs/typeorm'
import { Repository } from 'typeorm'
import { AppModule } from '../src/app.module.js'
import { User } from '../src/users/user.entity.js'

const FORBIDDEN = ['admin@example.com', 'test@test.com', 'demo@demo.com']

test('no seeded accounts exist', async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
  const app = await moduleRef.createNestApplication().init()
  const users: Repository<User> = moduleRef.get(getRepositoryToken(User))

  const found = await users.find({ where: FORBIDDEN.map((email) => ({ email })) })
  assert.deepEqual(found, [], `seeded accounts present: ${found.map((u) => u.email).join(', ')}`)

  await app.close()
})
```

Run it against staging as a smoke test as well as in CI. A check that only runs against an empty test database proves nothing about production.

The legitimate need behind the bad seed — "a preview environment needs a login" — is met by issuing a short-lived, environment-scoped credential when the preview environment is created, from the same mechanism that creates its database. Not by putting an account in the repository.

## Where seeding sits in the deploy

```text
build image
  └─ migration job        (DDL credentials, migrations only)
       └─ reference seed  (application credentials, idempotent upserts)
            └─ roll out new replicas
```

Reference seeding is a separate step from migrations even though both run before the rollout, because they use different credentials and fail for different reasons. A seed does not need DDL; it should run as the application user, and it should fail the deploy if it fails.

Do **not** seed from `onApplicationBootstrap`. It is the same argument as [Migrations](migrations.md): every replica would run it on every start, concurrently, and a seed that is slow or failing then becomes a failing readiness probe and a restart loop. Idempotent upserts make that survivable rather than correct — it is still N× the work on every deploy, forever.

## Security considerations

**No credentials in the repository.** Not in a seed file, not in a fixture, not in a comment showing "the test password". A hard-coded password in a seed is a hard-coded password in production the first time the seed runs there.

**Development seeds refuse to run in production, from inside the code.** An environment check in the shell wrapper is bypassed by running the script directly, which is exactly what someone does while debugging a deploy at 2am.

**Seed through services, so password hashing is the real hashing.** A seed that writes `password_hash` directly will one day write a bcrypt hash into a column your application now reads as argon2, and the accounts are silently unauthenticatable — or worse, a plaintext password into a column that is compared with `===`.

**Fake data must be obviously fake and unreachable.** `@example.invalid` or `@example.com` addresses, `+1 555` phone numbers, no real names copied from a production export. A seed that "borrows" a production dump has just moved personal data into every developer laptop and CI runner, which is a reportable incident in most jurisdictions.

**Never copy production data into a seed or a preview environment unmasked.** If you need realistic volumes, generate them. If you need realistic *shapes*, mask irreversibly — hash the emails, replace the names, drop the payment records.

**Reference seeds run as the application user.** They insert rows; they do not need DDL. Giving the seed job the migration credentials just because it is convenient undoes the separation [Migrations](migrations.md) sets up.

**Do not log seeded secrets.** A seeder that logs "created admin with password X" puts it in your CI log, where it is retained and widely readable.

**Test the absence of default accounts** and run that test against every environment, not just CI.

## Production considerations

- **Reference seeds are idempotent and run every deploy.** Demo seeds never run in production.
- **Run after migrations, before the rollout.** The constraints an upsert relies on are created by a migration.
- **Own only the fields the code owns.** An upsert that rewrites every column reverts operational fixes on every deploy.
- **Retire with a flag, never a delete.** Referenced rows are not yours to remove.
- **Give the seed its own root module.** Bootstrapping `AppModule` starts cron jobs and queue workers in a process that should do one thing.
- **`await app.close()` in a `finally`.** Otherwise the process hangs holding a connection and CI kills it on a timeout.
- **Set `process.exitCode` on failure.** A seed that cannot fail is not a deploy gate.
- **Make it safe to run concurrently.** Two copies of the deploy job overlap more often than you would think; `ON CONFLICT` handles it, a read-then-insert does not.
- **Keep it fast.** A reference seed that takes minutes is a deploy that takes minutes. Batch the upserts rather than looping one round trip per row.
- **Log what changed, not what was considered.** "3 plans reconciled, 1 updated" is useful; 500 lines of "checked plan free" is not.
- **Version the seed data with the code.** The array in the repository is the source of truth, and a deploy that adds a plan is a code change with a review.

## Common mistakes

- **Seeding from `onApplicationBootstrap`.** Every replica, every start, concurrently.
- **Bootstrapping `AppModule` for a seed.** Cron jobs and queue workers start in the seed process.
- **Forgetting `app.close()`.** The process hangs; someone adds `process.exit(0)` and now writes are abandoned mid-flight.
- **Exiting 0 on failure.** The deploy continues against half-seeded reference data.
- **Upserting on a generated id.** A re-run inserts duplicates instead of reconciling.
- **No unique constraint behind the conflict target.** `upsert` errors at deploy time.
- **Overwriting every column on every run.** Manual fixes are reverted silently.
- **Deleting rows that are not in the seed list.** Foreign keys cascade, or the deploy blocks.
- **Writing `password_hash` directly.** The hashing drifts from what login verifies.
- **A hard-coded admin account.** The breach class at the top of this page.
- **An environment guard only in the shell wrapper.** Running the script directly bypasses it.
- **Copying production data into a development seed.** Personal data on every laptop and CI runner.
- **Non-deterministic fake data.** "The third user" differs per run and the tests flake.

## Related topics

- [Seeding](../databases/seeding.md) — idempotency patterns, deterministic fake data, truncate-and-reload and seeding for tests.
- [Migrations](migrations.md) — the step that runs before this one, with different credentials.
- [Testing with a database](testing-with-a-database.md) — fixtures per test, and why a seed is not a fixture.
- [Database fixtures](../nestjs-testing/database-fixtures.md) — building test data through the container.
- [Configuration](../nestjs/configuration.md) — `ConfigService`, validation, and keeping the seed honest about which database it is pointed at.
- [Modules](../nestjs/modules.md) — a narrow root module for a standalone process.
- [Authentication](../nestjs-libraries/authentication.md) — the service a seeded user must be created through.
- [Secrets and config validation](../nestjs-security/secrets-and-config.md) — why the seed password is a variable, not a literal.
- [Continuous integration](../nestjs-production/ci.md) — running the seed and the absence-of-default-accounts test in the pipeline.
- [Build and deployment](../nestjs-production/build-and-deployment.md) — where the seed job sits in the release sequence.
