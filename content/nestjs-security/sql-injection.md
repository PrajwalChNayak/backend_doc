---
title: SQL injection
description: SQL injection inside NestJS 12 — vulnerable and fixed pairs for TypeORM, Prisma and raw pg in a provider, allow-listing dynamic identifiers, and least-privilege database roles.
status: current
updated: 2026-09-11
---

The attack has not changed because you put a DI container in front of it. What changes in Nest is *where* the hole lives: not in a route handler you can see, but three files away in a repository provider that a controller, a cron job and a queue consumer all share. This page covers the escape hatches of the ORMs Nest ships integrations for, the identifier cases parameters cannot cover, and the database grants that cap the damage.

The mechanics — union extraction, blind timing, second-order injection, why escaping is not a fix — are on [SQL injection](../security/sql-injection.md) and are unchanged. Read that first; this page is what Nest adds.

## The threat

A vulnerable query in a Nest provider is worse than the same query in an Express handler, for one structural reason: providers are shared. `UsersRepository.findByEmail()` is injected into `AuthService`, into `AdminService`, and into a `@Cron` job. One concatenated `WHERE` is reachable from every one of them, including the paths that never occurred to you to test. The blast radius is the privileges of the connection in `TypeOrmModule.forRoot()` or `DATABASE_URL`, and nothing about the module graph narrows it.

## A concrete exploit

A search endpoint. The controller is clean, the DTO is validated, and the hole is in the repository.

:::danger Concatenation inside a provider
```ts vulnerable title="DO NOT COPY — src/users/users.repository.ts"
import { Injectable } from '@nestjs/common'
import { InjectDataSource } from '@nestjs/typeorm'
import { DataSource } from 'typeorm'

@Injectable()
export class UsersRepository {
  private readonly dataSource: DataSource

  constructor(@InjectDataSource() dataSource: DataSource) {
    this.dataSource = dataSource
  }

  // `term` came from a validated DTO. Validation is not parameterization.
  search(term: string) {
    return this.dataSource.query(
      `SELECT id, email FROM users WHERE email LIKE '%${term}%'`,
    )
  }
}
```
:::

```ts vulnerable title="DO NOT COPY — src/users/users.controller.ts"
@Controller('users')
export class UsersController {
  @Get('search')
  search(@Query('q') q: string) {
    return this.users.search(q)
  }
}
```

The DTO said the term is a string with a maximum length. It is. It is also SQL.

```bash
curl -s --get localhost:3000/users/search \
  --data-urlencode "q=' UNION SELECT email, password_hash FROM users -- "
```

```json title="200 OK — every hash in the table"
[
  { "id": "admin@example.test", "email": "$argon2id$v=19$m=65536,t=3,p=4$…" },
  { "id": "ops@example.test",   "email": "$argon2id$v=19$m=65536,t=3,p=4$…" }
]
```

The response is a 200. No exception filter fires, no log line looks wrong, and the `id` column is now full of email addresses because the attacker chose the projection.

## TypeORM

`typeorm` **1.1.1** — note the major version; TypeORM reached 1.0 and `0.3.x` guidance is out of date.

### `dataSource.query()`

The second argument is the parameter array. The driver decides the placeholder dialect: `$1` on Postgres, `?` on MySQL and SQLite.

```ts good title="src/users/users.repository.ts"
import { Injectable } from '@nestjs/common'
import { InjectDataSource } from '@nestjs/typeorm'
import { DataSource } from 'typeorm'

@Injectable()
export class UsersRepository {
  private readonly dataSource: DataSource

  constructor(@InjectDataSource() dataSource: DataSource) {
    this.dataSource = dataSource
  }

  search(term: string) {
    // The pattern is built in JavaScript and sent as a value. The SQL text is constant.
    return this.dataSource.query<Array<{ id: string; email: string }>>(
      'SELECT id, email FROM users WHERE email LIKE $1 LIMIT 50',
      [`%${term}%`],
    )
  }
}
```

Building `%${term}%` in JavaScript is correct: the wildcards belong to the *value*, and the value never becomes SQL text. If you need the user's own `%` and `_` to be literal, escape them in the value and add an `ESCAPE` clause — still parameterized.

### The query builder

`.where('u.id = :id', { id })` binds `:id`. `.where('u.id = ' + id)` does not. The two lines are three characters apart and one of them is a total compromise.

:::danger Interpolated `where()`
```ts vulnerable title="DO NOT COPY"
// Both forms paste the value into the SQL text TypeORM compiles.
repo.createQueryBuilder('u').where('u.id = ' + id).getOne()
repo.createQueryBuilder('u').where(`u.email = '${email}'`).getOne()
```
:::

```ts good title="src/users/users.repository.ts"
import { Injectable } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { Repository } from 'typeorm'
import { User } from './user.entity.js'

@Injectable()
export class UsersRepository {
  private readonly repo: Repository<User>

  constructor(@InjectRepository(User) repo: Repository<User>) {
    this.repo = repo
  }

  findOneForOwner(id: string, ownerId: string) {
    return this.repo
      .createQueryBuilder('u')
      .where('u.id = :id', { id })
      .andWhere('u.ownerId = :ownerId', { ownerId })
      .getOne()
  }

  findByIds(ids: string[]) {
    // :...ids expands to one bind placeholder per element — never join the array.
    return this.repo
      .createQueryBuilder('u')
      .where('u.id IN (:...ids)', { ids: ids.slice(0, 100) })
      .getMany()
  }
}
```

`(:...ids)` is TypeORM's expansion syntax and it emits one placeholder per element. Cap the array length yourself — the number of elements is attacker-controlled even when each element is safe.

For most reads you do not need the builder at all. The `find` options object is fully parameterized and is the shortest path to a correct query:

```ts good title="src/orders/orders.repository.ts"
findOneForOwner(id: string, userId: string) {
  // Object criteria are compiled to bind parameters, always.
  return this.repo.findOne({ where: { id, userId } })
}
```

:::warning `setParameter` is not a second chance
`.where(someString).setParameter('id', id)` binds `:id` only if `:id` appears in `someString`. If the string already contains the interpolated value, `setParameter` adds an unused parameter and changes nothing. The check is "is there a `:name` placeholder in the SQL", not "did I call the binding method".
:::

## Prisma

`@prisma/client` **7.10.0**. (The npm `latest` tag for the `prisma` CLI points at an `8.0.0-rc`; pin `prisma@7`.)

`$queryRaw` is a **tagged template**. Every `${}` inside it becomes a bind parameter. `$queryRawUnsafe` takes an ordinary string and does not.

```ts good title="src/users/users.repository.ts"
import { Injectable } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { PrismaService } from '../prisma/prisma.service.js'

@Injectable()
export class UsersRepository {
  private readonly prisma: PrismaService

  constructor(prisma: PrismaService) {
    this.prisma = prisma
  }

  // lint-sql:allow $queryRaw is a tagged template — ${term} is sent as a bind parameter
  search(term: string) {
    return this.prisma.$queryRaw<Array<{ id: string; email: string }>>`
      SELECT id, email FROM users WHERE email LIKE ${`%${term}%`} LIMIT 50
    `
  }

  // Composing fragments: Prisma.sql keeps parameters as parameters and
  // Prisma.join emits one placeholder per element of the array.
  findByIds(ids: string[]) {
    const filter = Prisma.sql`id IN (${Prisma.join(ids.slice(0, 100))})`
    // lint-sql:allow $queryRaw tagged template; Prisma.join emits bind placeholders
    return this.prisma.$queryRaw<Array<{ id: string }>>`SELECT id FROM users WHERE ${filter}`
  }
}
```

`Prisma.empty` is the identity fragment, which is what makes conditional filters composable without string building:

```ts good title="src/orders/orders.repository.ts"
import { Prisma } from '@prisma/client'

listForUser(userId: string, status?: string) {
  const statusFilter = status ? Prisma.sql`AND status = ${status}` : Prisma.empty
  // lint-sql:allow every interpolation is a Prisma.sql fragment or a bind parameter
  return this.prisma.$queryRaw`
    SELECT id, status FROM orders WHERE user_id = ${userId} ${statusFilter}
  `
}
```

:::danger The two Prisma escape hatches
`$queryRawUnsafe` concatenates. `Prisma.raw` injects unescaped text into an otherwise-safe tagged template, which is worse because the surrounding code looks correct.

```ts vulnerable title="DO NOT COPY"
// Plain string argument — no parameterization at all.
prisma.$queryRawUnsafe(`SELECT id FROM users WHERE email = '${email}'`)

// A tagged template whose interpolation is re-opened by Prisma.raw.
prisma.$queryRaw`SELECT id FROM users WHERE email = ${Prisma.raw(email)}`
```
:::

`Prisma.raw` has exactly one legitimate use: an identifier you have already validated against an allow-list, covered below. If the argument came from a request and did not pass through a `Set`, it is a vulnerability.

## Raw `pg` in a provider

`pg` **8.23.0** behind a custom provider is the right choice when you want SQL and nothing else. The pool becomes an injectable token with a lifecycle hook, and every query is parameterized with `$1`-style placeholders — `pg` has no string-substitution mode to get wrong.

```ts good title="src/database/database.module.ts"
import { Module } from '@nestjs/common'
import type { OnApplicationShutdown } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import pg from 'pg'

export const PG_POOL = Symbol('PG_POOL')

@Module({
  providers: [
    {
      provide: PG_POOL,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new pg.Pool({
          connectionString: config.getOrThrow<string>('DATABASE_URL'),
          max: 10,
          // Bounds a blind pg_sleep probe and a runaway UNION alike.
          statement_timeout: 3_000,
        }),
    },
  ],
  exports: [PG_POOL],
})
export class DatabaseModule implements OnApplicationShutdown {
  async onApplicationShutdown() {
    // Close the pool so the process can exit; see Graceful shutdown.
  }
}
```

```ts good title="src/users/users.repository.ts"
import { Inject, Injectable } from '@nestjs/common'
import type { Pool } from 'pg'
import { PG_POOL } from '../database/database.module.js'

@Injectable()
export class UsersRepository {
  private readonly pool: Pool

  constructor(@Inject(PG_POOL) pool: Pool) {
    this.pool = pool
  }

  async findByEmail(email: string) {
    const { rows } = await this.pool.query(
      'SELECT id, email, password_hash FROM users WHERE email = $1',
      [email],
    )
    return rows[0] ?? null
  }

  async findByIds(ids: string[]) {
    // pg binds a JS array to a Postgres array, so ANY($1) needs no generated list.
    const { rows } = await this.pool.query(
      'SELECT id, email FROM users WHERE id = ANY($1)',
      [ids.slice(0, 100)],
    )
    return rows
  }
}
```

`= ANY($1)` with an array parameter is strictly better than generating a `$1, $2, $3` list: there is no template to get wrong and no per-element string work. `statement_timeout` on the pool is the cheapest defense in depth you can buy — it turns a five-second blind-injection probe into an error.

## Where parameterization does not help

Bind parameters replace **values**. A table name, a column name, and the direction of an `ORDER BY` are not values — they are parsed as part of the statement, so no driver will bind them. Dynamic sorting is where an otherwise-parameterized codebase reintroduces injection.

:::danger Sorting from the query string
```ts vulnerable title="DO NOT COPY — src/reports/reports.repository.ts"
list(sort: string, dir: string) {
  // Both fragments are pasted into the statement.
  return this.pool.query(`SELECT id, email FROM users ORDER BY ${sort} ${dir}`)
}
```

`?sort=(SELECT CASE WHEN (SELECT substr(password_hash,1,1) FROM users WHERE email='admin@example.test')='$' THEN id ELSE email END)` orders the result differently depending on a character of the hash. No output is echoed and the endpoint returns 200 either way.
:::

The fix is an **allow-list**, not a sanitizer. A regex "sanitizer" tries to enumerate bad input and always misses one encoding; an allow-list enumerates *good* input and uses the known-good string rather than the user's.

```ts good title="src/reports/reports.repository.ts"
import { BadRequestException, Inject, Injectable } from '@nestjs/common'
import type { Pool } from 'pg'
import { PG_POOL } from '../database/database.module.js'

// Fixed, known-safe identifiers. The client picks an entry; you use the entry.
const SORTABLE = new Set(['id', 'email', 'created_at'])
const DIRECTIONS = new Map([['asc', 'ASC'], ['desc', 'DESC']])
const TABLES = new Map([['users', 'users'], ['orders', 'orders']])

@Injectable()
export class ReportsRepository {
  private readonly pool: Pool

  constructor(@Inject(PG_POOL) pool: Pool) {
    this.pool = pool
  }

  async list(table: string, sort: string, dir: string, limit: number) {
    const tableName = TABLES.get(table)
    if (!tableName) throw new BadRequestException('Unknown table')

    // Set.has, not a regex. The value used below is the literal from SORTABLE.
    if (!SORTABLE.has(sort)) throw new BadRequestException('Unsortable column')

    const direction = DIRECTIONS.get(dir)
    if (!direction) throw new BadRequestException('Bad sort direction')

    const max = Math.min(Number(limit) || 20, 100)

    // lint-sql:allow tableName/sort/direction each came from a fixed allow-list above
    const sql = `SELECT id, email, created_at FROM ${tableName} ORDER BY ${sort} ${direction} LIMIT $1`
    const { rows } = await this.pool.query(sql, [max])
    return rows
  }
}
```

Three details that matter:

- **`Set.has` / `Map.get`, never a regex.** `/^[a-z_]+$/` accepts `password_hash`, which is a valid identifier and a leak. The question is not "is this a safe-looking string" but "is this one of the columns this endpoint is allowed to sort by".
- **Use the map's value, not the input.** `DIRECTIONS.get(dir)` returns the literal `'ASC'`. Even if the lookup key were somehow crafted, the string that reaches the SQL came from your code.
- **The `// lint-sql:allow` marker.** This repository's linter (`scripts/lint-sql.mjs`, see CONTRIBUTING §7) fails the build on any interpolated SQL. The marker is the only escape hatch for validated identifiers and it forces the justification into the diff, where a reviewer sees it. Adopt the same rule in your own codebase: interpolated SQL should be impossible to merge without an explicit, reviewed exception.

The same shape works in TypeORM and Prisma. TypeORM's `.orderBy(column, direction)` interpolates the column into the compiled SQL, so it needs the allow-list just as much as a string template does:

```ts good title="src/reports/reports.repository.ts (TypeORM)"
// Module scope: the only columns this endpoint will ever sort by.
const SORTABLE = new Set(['id', 'email', 'createdAt'])

@Injectable()
export class ReportsRepository {
  constructor(@InjectRepository(User) private readonly repo: Repository<User>) {}

  list(sort: string, dir: 'ASC' | 'DESC') {
    if (!SORTABLE.has(sort)) throw new BadRequestException('Unsortable column')
    return this.repo
      .createQueryBuilder('u')
      .orderBy(`u.${sort}`, dir === 'DESC' ? 'DESC' : 'ASC')
      .limit(100)
      .getMany()
  }
}
```

And in Prisma, the allow-list is what makes `Prisma.raw` defensible — it is the only place the word `raw` should appear in your codebase:

```ts good title="src/reports/reports.repository.ts (Prisma)"
import { Prisma } from '@prisma/client'

// Module scope: Prisma.raw is called here, over literals you typed.
const SORTABLE = new Map([
  ['email', Prisma.raw('email')],
  ['created_at', Prisma.raw('created_at')],
])

@Injectable()
export class ReportsRepository {
  constructor(private readonly prisma: PrismaService) {}

  list(sort: string, limit: number) {
    const column = SORTABLE.get(sort)
    if (!column) throw new BadRequestException('Unsortable column')
    // lint-sql:allow `column` is a pre-built Prisma.raw fragment from a fixed Map, not user input
    return this.prisma.$queryRaw`SELECT id, email FROM users ORDER BY ${column} LIMIT ${Math.min(limit, 100)}`
  }
}
```

Note where `Prisma.raw` is called: at module load, over literals you typed. It never receives a request value.

:::best-practice
Validate the sort field at the boundary as well, with an `@IsIn([...])` on the query DTO, so an unsortable column is a 400 from the pipe rather than an exception from the repository. Two layers, and the DTO version is the one that shows up in your OpenAPI document. See [Validation as a security control](validation-as-a-control.md).
:::

## How to verify the fix

Replay the exploit against the fixed build. The payload must come back as data, not as SQL.

```bash
curl -s --get localhost:3000/users/search \
  --data-urlencode "q=' UNION SELECT email, password_hash FROM users -- "
```

```json title="200 OK — no rows, because no user has that literal string in their email"
[]
```

Then the sort endpoint, which must be a 400 rather than a clever 200:

```bash
curl -s -o /dev/null -w '%{http_code}\n' 'localhost:3000/reports?table=users&sort=password_hash&dir=asc'
```

```text
400
```

Both belong in the suite, because a repository is exactly the kind of file someone "optimizes" six months later:

```ts title="test/sql-injection.e2e-spec.ts"
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { AppModule } from '../src/app.module.js'

describe('injection payloads are treated as data', () => {
  let app: import('@nestjs/common').INestApplication

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = moduleRef.createNestApplication()
    await app.init()
  })

  afterAll(() => app.close())

  it('does not let a UNION payload change the projection', async () => {
    const response = await request(app.getHttpServer())
      .get('/users/search')
      .query({ q: "' UNION SELECT email, password_hash FROM users -- " })
      .expect(200)

    expect(response.body).toEqual([])
    // The real assertion: nothing that looks like a hash came back.
    expect(JSON.stringify(response.body)).not.toContain('$argon2')
  })

  it('rejects a column that is not on the sort allow-list', async () => {
    await request(app.getHttpServer())
      .get('/reports')
      .query({ table: 'users', sort: 'password_hash', dir: 'asc' })
      .expect(400)
  })

  it('does not spend five seconds on a blind timing payload', async () => {
    const started = Date.now()
    await request(app.getHttpServer())
      .get('/users/search')
      .query({ q: "x'; SELECT pg_sleep(5); -- " })
      .expect(200)
    expect(Date.now() - started).toBeLessThan(1_000)
  })
})
```

The timing test is the one that catches a regression nobody notices, because a blind-injection endpoint returns a perfectly normal 200.

:::warning
Run these against a real database, not a mock. A mocked repository returns whatever you told it to and proves nothing about SQL. Use a container or SQLite fixture — see [Testing with a database](../nestjs-databases/testing-with-a-database.md).
:::

## Least privilege

Parameterization stops the injection. Grants decide what an injection you *missed* is able to do. The connection string in `DATABASE_URL` should belong to a role that can run the application's DML and nothing else: no ownership, no DDL, no superuser.

```sql title="grants.sql (PostgreSQL)"
-- Two roles. The app never authenticates as the first one.
CREATE ROLE app_migrator LOGIN PASSWORD :'migrator_pw';
CREATE ROLE app_runtime  LOGIN PASSWORD :'runtime_pw';

-- The migrator owns the schema and is the only role that runs DDL.
ALTER SCHEMA public OWNER TO app_migrator;

-- The runtime role gets connection, visibility, and the four DML verbs.
GRANT CONNECT ON DATABASE app TO app_runtime;
GRANT USAGE ON SCHEMA public TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_runtime;

-- Tables the migrator creates later must inherit the same grants.
ALTER DEFAULT PRIVILEGES FOR ROLE app_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_runtime;

-- And explicitly take away the verbs that turn an injection into an outage.
REVOKE CREATE ON SCHEMA public FROM app_runtime;
REVOKE TRUNCATE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA public FROM app_runtime;
```

With those grants an injected `DROP TABLE` fails on permissions, not on luck. A `UNION` read still succeeds, so this is a damage cap and never a substitute for parameterizing.

**The application must not own DDL.** Two consequences for a Nest codebase specifically:

- **`synchronize: true` must be off.** `TypeOrmModule.forRoot({ synchronize: true })` issues DDL at boot from the entity metadata. It requires the runtime role to own the tables, which undoes the entire separation above — and it will happily drop a column when someone renames a property.
- **Migrations run as a different identity.** `migrationsRun: true` has the same problem. Run migrations as a separate step in the deploy pipeline, with the migrator credential, before the new application instances start. See [Migrations](../nestjs-databases/migrations.md).

```ts good title="src/app.module.ts"
import { Module } from '@nestjs/common'
import { ConfigModule, ConfigService } from '@nestjs/config'
import { TypeOrmModule } from '@nestjs/typeorm'

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres' as const,
        // The runtime credential: DML only.
        url: config.getOrThrow<string>('DATABASE_URL'),
        autoLoadEntities: true,
        synchronize: false,   // never true outside a scratch database
        migrationsRun: false, // migrations are a deploy step, not a boot step
      }),
    }),
  ],
})
export class AppModule {}
```

## Production considerations

- **Set `statement_timeout` on the role, not just the pool.** `ALTER ROLE app_runtime SET statement_timeout = '3s'` survives a pool configured by someone else, and bounds blind-injection probes and accidental table scans alike.
- **`multipleStatements` stays off for MySQL.** `mysql2` defaults to `false`; leaving it there means a `;` in an injected value cannot start a second statement. Nothing in a Nest app needs it on.
- **Log the SQL, never the parameters.** TypeORM's `logging: ['query', 'error']` prints parameter arrays by default, which puts password hashes and tokens in your log aggregator. See [Safe logging](safe-logging.md).
- **Grep in CI.** `$queryRawUnsafe`, `Prisma.raw`, `sql.raw`, and a template literal passed to `.query(` are four patterns worth failing a build over. The three ORM escape hatches are legitimate roughly once per codebase; make each use argue for itself in review.
- **Run the linter.** `node scripts/lint-sql.mjs` scans every fenced block in `content/` and every example source file, and exits non-zero on unmarked interpolated SQL. It is the reason this handbook cannot ship an injectable snippet by accident.

## Common mistakes

- **Believing a validated DTO is a parameterized query.** `@IsString() @MaxLength(80)` accepts `' UNION SELECT …` because that is a string of eighty characters or fewer.
- **`.where('u.id = ' + id)` in a query builder.** The binding form is `.where('u.id = :id', { id })`; the concatenated form compiles the value into the SQL.
- **Calling `.setParameter()` on a `where` string that has no placeholder.** It adds an unused parameter and changes nothing about the query.
- **`$queryRawUnsafe` because "the tagged template didn't work".** It did. The unsafe variant exists for dynamic statement text, which you almost certainly do not need.
- **`Prisma.raw(userInput)` anywhere.** The only defensible `Prisma.raw` call takes a literal you typed, at module load, inside an allow-list map.
- **Joining an `IN` list with `ids.join(',')`.** Use `(:...ids)` in TypeORM, `Prisma.join()` in Prisma, or `= ANY($1)` with `pg`. And cap the length.
- **Regex-sanitizing a column name.** `/^[a-z_]+$/` cheerfully accepts `password_hash`. Enumerate the allowed columns in a `Set`.
- **Interpolating a table name from a "trusted" internal service.** Second-order injection does not care where the string came from; only the allow-list does.
- **Leaving `synchronize: true` on.** It requires DDL rights at runtime, which defeats least privilege, and it can drop a column during a deploy.
- **Running the app as the database owner.** The injection you missed becomes a schema wipe instead of a read.
- **Mocking the repository in the injection test.** A mock returns whatever you programmed. Test against a real engine.

## Related topics

- [SQL injection](../security/sql-injection.md) — the attack mechanics, blind and second-order variants, and the driver-level fixes.
- [NoSQL injection](nosql-injection.md) — the same class where the payload is an object rather than a string.
- [Validation as a security control](validation-as-a-control.md) — why the pipe is a layer, not the layer.
- [TypeORM](../nestjs-orms/typeorm.md) — the repository and query-builder APIs in full.
- [Raw drivers](../nestjs-orms/raw-drivers.md) — `pg` and `mysql2` as Nest providers.
- [PostgreSQL](../nestjs-databases/postgresql.md) — pool configuration, `statement_timeout` and roles.
- [Migrations](../nestjs-databases/migrations.md) — running DDL as a separate identity in the deploy pipeline.
- [Testing with a database](../nestjs-databases/testing-with-a-database.md) — making the injection tests run against a real engine.
- [Connections and DI](../nestjs-databases/connections-and-di.md) — the custom-provider pattern the `pg` example uses.
- [Safe logging](safe-logging.md) — why query parameters must not reach the log.
- [OWASP API Top 10 in Nest](owasp-api-top-10.md) — where injection sits in the 2023 list.
