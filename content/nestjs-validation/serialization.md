---
title: Serialization
description: Controlling what a NestJS 12 response actually contains — ClassSerializerInterceptor with @Exclude and @Expose, the new StandardSchemaSerializerInterceptor, and why a response schema is what stops a password hash leaking.
status: current
updated: 2026-09-11
---

Validation decides what enters your application. Serialization decides what leaves it, and it is the half people skip. A handler that returns the entity it just loaded returns every column on that entity — including the password hash, the password-reset token, the internal risk score and the soft-delete flag — because nothing between `return user` and the JSON body removes them.

NestJS 12 gives you two interceptors for this, matching the two validation stacks: `ClassSerializerInterceptor` with `class-transformer` decorators, and the new `StandardSchemaSerializerInterceptor` with a Standard Schema.

## The leak

```ts vulnerable title="DO NOT COPY — src/users/users.controller.ts"
import { Controller, Get, Param } from '@nestjs/common'
import { UsersService } from './users.service.js'

@Controller('users')
export class UsersController {
  private readonly users: UsersService

  constructor(users: UsersService) {
    this.users = users
  }

  @Get(':id')
  async findOne(@Param('id') id: string) {
    // Returns the entity. The entity is the database row.
    return this.users.findOne(id)
  }
}
```

:::danger Every column you did not think about is in the response
```ts vulnerable title="DO NOT COPY — src/users/user.entity.ts"
import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm'

@Entity()
export class User {
  @PrimaryGeneratedColumn('uuid')
  id: string

  @Column()
  email: string

  @Column()
  displayName: string

  @Column()
  passwordHash: string

  @Column({ nullable: true })
  passwordResetToken: string | null

  @Column({ default: 'user' })
  role: string

  @Column({ default: 0 })
  failedLoginCount: number
}
```

```bash
curl -sS localhost:3000/users/8f1c-0000-0000-0000
```

```json title="200 OK — the whole row"
{
  "id": "8f1c-0000-0000-0000",
  "email": "alice@example.test",
  "displayName": "Alice",
  "passwordHash": "$argon2id$v=19$m=65536,t=3,p=4$…",
  "passwordResetToken": "0a4f1c…",
  "role": "user",
  "failedLoginCount": 0
}
```

The password hash is offline-crackable. The reset token is an account takeover: request a reset for the victim, read this endpoint, use the token. Neither requires a bug anywhere else in the application.
:::

Adding a column is a migration. Adding a column to a public API response should be a decision. Without a serialization layer, the first is silently the second.

## The fix, with `class-transformer`

Mark what must never leave, and turn the interceptor on.

```ts good title="src/users/user.entity.ts"
import { Exclude } from 'class-transformer'
import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm'

@Entity()
export class User {
  @PrimaryGeneratedColumn('uuid')
  id: string

  @Column()
  email: string

  @Column()
  displayName: string

  @Exclude()
  @Column()
  passwordHash: string

  @Exclude()
  @Column({ nullable: true })
  passwordResetToken: string | null

  @Column({ default: 'user' })
  role: string

  @Exclude()
  @Column({ default: 0 })
  failedLoginCount: number
}
```

```ts good title="src/main.ts"
import { NestFactory, Reflector } from '@nestjs/core'
import { ClassSerializerInterceptor } from '@nestjs/common'
import { AppModule } from './app.module.js'

const app = await NestFactory.create(AppModule)

app.useGlobalInterceptors(new ClassSerializerInterceptor(app.get(Reflector)))

await app.listen(3000)
```

```json title="200 OK — after"
{
  "id": "8f1c-0000-0000-0000",
  "email": "alice@example.test",
  "displayName": "Alice",
  "role": "user"
}
```

Prefer the provider form so the interceptor exists in tests built from `AppModule`:

```ts title="src/app.module.ts"
import { ClassSerializerInterceptor, Module } from '@nestjs/common'
import { APP_INTERCEPTOR } from '@nestjs/core'

@Module({
  providers: [{ provide: APP_INTERCEPTOR, useClass: ClassSerializerInterceptor }],
})
export class AppModule {}
```

`ClassSerializerInterceptor` loads `class-transformer` lazily at construction, so the same 0.5.1 peer dependency the validation stack uses is required here.

### The trap: it only works on instances

The interceptor calls `classToPlain()` on whatever the handler returned. `classToPlain` reads `@Exclude()` metadata **from the value's class**. Hand it a plain object and there is no class, no metadata, and no exclusion — it returns everything, with no error.

This is not a rare edge case. It is the normal result of:

- Prisma, which returns plain objects from `findUnique()`;
- Mongoose with `.lean()`;
- Drizzle and raw drivers, which return row objects;
- any service that builds `{ ...user, fullName }` before returning;
- TypeORM's `getRawOne()` / `getRawMany()`.

TypeORM's repository methods *do* return entity instances, which is why the example above works and why a later refactor to a query builder silently reopens the hole.

Two ways to close it. Construct the instance yourself:

```ts good title="src/users/users.service.ts"
import { Injectable } from '@nestjs/common'
import { plainToInstance } from 'class-transformer'
import { UserEntity } from './user.entity.js'

@Injectable()
export class UsersService {
  private readonly prisma: PrismaService

  constructor(prisma: PrismaService) {
    this.prisma = prisma
  }

  async findOne(id: string): Promise<UserEntity> {
    const row = await this.prisma.user.findUniqueOrThrow({ where: { id } })
    return plainToInstance(UserEntity, row)
  }
}
```

Or tell the interceptor which class to use, with the `type` option:

```ts good title="src/users/users.controller.ts"
import { Controller, Get, Param, SerializeOptions } from '@nestjs/common'
import { UserEntity } from './user.entity.js'

@Controller('users')
export class UsersController {
  @Get(':id')
  @SerializeOptions({ type: UserEntity })
  findOne(@Param('id') id: string) {
    return this.users.findOne(id)
  }
}
```

When `type` is set and the value is not already an instance of it, the interceptor runs `plainToInstance()` first and then `classToPlain()`. That is the supported way to serialize a plain object through a class's decorators.

### `@Exclude()` is a denylist. Prefer an allowlist.

`@Exclude()` requires you to remember. The column added next sprint is exposed by default, and the person adding it is thinking about the migration, not about this file.

Invert it:

```ts good title="src/users/user.response.ts"
import { Expose } from 'class-transformer'

export class UserResponse {
  @Expose()
  id: string

  @Expose()
  email: string

  @Expose()
  displayName: string

  @Expose()
  role: string
}
```

```ts good title="src/main.ts"
app.useGlobalInterceptors(
  new ClassSerializerInterceptor(app.get(Reflector), {
    // Only properties marked @Expose() survive. A new field is invisible
    // until someone deliberately exposes it.
    excludeExtraneousValues: true,
  }),
)
```

With `excludeExtraneousValues: true`, a property with no `@Expose()` is dropped whether or not anyone remembered `@Exclude()`. The failure mode flips from "leaks by default" to "missing by default", and a missing field is a bug someone reports in ten minutes.

The same effect is available per interceptor as `strategy: 'excludeAll'`, or per class by putting `@Exclude()` on the class itself and `@Expose()` on the properties you want.

:::best-practice
Use a dedicated response class per resource, separate from the persistence entity, and run it with `excludeExtraneousValues: true`. Coupling the wire format to the database schema means every column decision is also an API decision.
:::

### Reshaping with `@Transform()` and `@Expose()`

```ts title="src/users/user.response.ts"
import { Expose, Transform } from 'class-transformer'

export class UserResponse {
  @Expose()
  id: string

  @Expose()
  email: string

  @Expose({ name: 'display_name' })
  displayName: string

  @Expose()
  @Transform(({ value }) => (value instanceof Date ? value.toISOString() : value))
  createdAt: string

  @Expose()
  @Transform(({ obj }) => `${obj.firstName} ${obj.lastName}`.trim())
  fullName: string
}
```

`@Transform()` on the response side receives `{ value, obj }` — `obj` is the source object, which is how a computed field reaches the fields it is computed from. `@Expose({ name })` renames on the way out, so a `snake_case` public contract does not force `snake_case` properties through your service layer.

### Groups: one class, several audiences

```ts title="src/users/user.response.ts"
import { Expose } from 'class-transformer'

export class UserResponse {
  @Expose()
  id: string

  @Expose()
  displayName: string

  @Expose({ groups: ['self', 'admin'] })
  email: string

  @Expose({ groups: ['admin'] })
  failedLoginCount: number
}
```

```ts title="src/users/users.controller.ts"
import { Controller, Get, Param, SerializeOptions } from '@nestjs/common'

@Controller('users')
export class UsersController {
  @Get(':id')
  @SerializeOptions({ groups: ['public'] })
  findOne(@Param('id') id: string) {
    return this.users.findOne(id)
  }

  @Get(':id/admin')
  @SerializeOptions({ groups: ['admin'] })
  findOneForAdmin(@Param('id') id: string) {
    return this.users.findOne(id)
  }
}
```

`@SerializeOptions()` works on a handler or on a controller class; the handler wins. Its object is **merged over** the interceptor's defaults key by key, so an option you set globally and do not repeat is kept — but an option you *do* repeat replaces the global value rather than extending it. `@SerializeOptions({ groups: ['admin'] })` on a route where the global default set `excludeExtraneousValues: true` keeps that setting; `@SerializeOptions({ groups: [] })` genuinely means no groups.

:::danger The group is a route decision, not an authorization check
`@SerializeOptions({ groups: ['admin'] })` decides which *fields* are rendered. It does not check that the caller is an admin. Put a guard on the route. A misplaced decorator on an unguarded route is a data leak with a 200 status code.
:::

## The Standard Schema serializer

New in NestJS 12 and the natural counterpart to [Standard Schema with Zod](standard-schema-with-zod.md): describe the response with a schema and let the interceptor produce exactly that.

```ts title="src/users/schemas/user.response.ts"
import { z } from 'zod'

export const userResponseSchema = z.object({
  id: z.uuid(),
  email: z.email(),
  displayName: z.string(),
  role: z.enum(['user', 'admin']),
})

export type UserResponse = z.infer<typeof userResponseSchema>
```

```ts title="src/users/users.controller.ts"
import { Controller, Get, Param, SerializeOptions, UseInterceptors } from '@nestjs/common'
import { StandardSchemaSerializerInterceptor } from '@nestjs/common'
import { userResponseSchema } from './schemas/user.response.js'

@Controller('users')
@UseInterceptors(StandardSchemaSerializerInterceptor)
export class UsersController {
  @Get(':id')
  @SerializeOptions({ schema: userResponseSchema })
  findOne(@Param('id') id: string) {
    return this.users.findOne(id)
  }
}
```

The interface is small:

```ts
// new StandardSchemaSerializerInterceptor(reflector, { schema?, validateOptions? })

interface StandardSchemaSerializerContextOptions {
  schema?: StandardSchemaV1
  validateOptions?: StandardSchemaV1.Options
}
```

The interceptor resolves the schema as `@SerializeOptions({ schema })` first, falling back to the `schema` passed to the constructor; `validateOptions` resolves the same way. It then runs `~standard.validate()` on the response and emits the **result value** — so a `z.object()` response schema strips every key it does not declare, and that stripping is the security property.

A default schema for a whole application rarely makes sense, but a default for one controller does:

```ts title="src/users/users.controller.ts"
import { Controller, Get, UseInterceptors } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { StandardSchemaSerializerInterceptor } from '@nestjs/common'
import { userResponseSchema } from './schemas/user.response.js'

@Controller('users')
@UseInterceptors(
  new StandardSchemaSerializerInterceptor(new Reflector(), { schema: userResponseSchema }),
)
export class UsersController {
  @Get()
  list() {
    return this.users.list()
  }
}
```

### Three behaviors to know before you rely on it

**Arrays are validated element by element.** When the handler returns an array, the interceptor maps the schema over each item. Your schema must therefore describe **one item**, not the array — `userResponseSchema`, not `z.array(userResponseSchema)`. Wrapping it in `z.array()` fails on every element, because each element is an object and the schema expects an array.

**No schema means no serialization.** With neither `@SerializeOptions({ schema })` nor a constructor default, the interceptor returns the response untouched. Like the validation pipe, it is opt-in and silent about omissions.

**A failure is a 500, not a 400.** If the response does not match the schema, the interceptor throws a plain `Error` whose message lists the issues. It is a server-side contract violation, so 500 is the correct status — but it means an over-strict response schema turns a working endpoint into an outage. Two rules follow:

- Use `z.object()` for responses, not `z.strictObject()`. Stripping extra keys is the job; rejecting them converts a harmless surplus into a 500.
- Make optionality in the schema match reality. A field that is `null` in the database and non-nullable in the schema is an incident waiting for the first row that has it.

Non-object responses and `StreamableFile` are passed through untouched, so a file download or a plain string response is unaffected.

## Which one to use

| | `ClassSerializerInterceptor` | `StandardSchemaSerializerInterceptor` |
| --- | --- | --- |
| Contract lives in | Decorators on a class | A schema value |
| Default behavior | Exposes everything not `@Exclude()`d | Passes through when no schema is set |
| Allowlist mode | `excludeExtraneousValues: true` with `@Expose()` | Inherent — `z.object()` keeps only declared keys |
| Works on plain objects | Only via the `type` option or `plainToInstance()` | Yes, natively |
| Per-audience variants | `groups` | A second schema |
| Renaming a field | `@Expose({ name })` | `.transform()` in the schema |
| Response type in TS | The response class | `z.infer` of the schema |
| On mismatch | Silently omits or emits `undefined` | Throws — the endpoint 500s |
| Requires | `class-transformer` 0.5.1 | A Standard Schema library |

Match the serializer to the validation stack you chose in [Choosing an approach](choosing-an-approach.md). A class-first codebase gets response classes; a schema-first codebase gets response schemas. Mixing them in one controller means two places to look for "why is this field missing".

:::warning Both interceptors read the same `@SerializeOptions()` metadata
There is one `@SerializeOptions()` decorator and one metadata key, consumed by whichever interceptor is registered. If you register both globally, both read the same options object — the class serializer takes `groups`, `type` and the other `class-transformer` keys, and the Standard Schema serializer takes `schema` and `validateOptions`, and each ignores the other's. That works, but the response then passes through two transformations, and the second sees the output of the first. Register one.
:::

## Security considerations

**A response contract is what stops a password hash leaking.** Not code review, not a naming convention, not remembering. The control is an explicit allowlist — `excludeExtraneousValues: true` with `@Expose()`, or a `z.object()` response schema — applied to every route that returns a persisted object.

**A denylist fails open.** `@Exclude()` protects the fields someone thought of. The next column is exposed by default, and nothing fails when it is. Every allowlist form of this control fails closed instead: the new field is missing until someone adds it deliberately.

**`classToPlain()` on a plain object is a no-op.** Prisma rows, `.lean()` documents, raw query results and spread objects carry no decorator metadata, so `@Exclude()` does nothing and the interceptor returns everything. This is the most common way a correctly decorated entity still leaks. Use `@SerializeOptions({ type })` or `plainToInstance()`, and test the actual response body.

**Serialization groups are not authorization.** `@SerializeOptions({ groups: ['admin'] })` selects fields; a guard decides who may call the route. Ship both, and make the guard the thing that fails closed. See [Authorization and IDOR](../nestjs-security/authorization-and-idor.md).

**Relations serialize too.** Returning a `User` with an eagerly loaded `sessions` relation serializes each session, including its token, unless those are excluded as well. Decorate the related entities, or return a response class that does not include the relation at all.

**Errors are responses.** An exception filter that serializes an error object can put a query, a connection string or a stack trace into a 500 body. The serializer does not touch the error path — see [Exception filters](../nestjs-request-handling/exception-filters.md) and [Safe logging](../nestjs-security/safe-logging.md).

**Verify with the response body, not the entity file.** The test is a request:

```ts title="test/serialization.e2e-spec.ts"
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { AppModule } from '../src/app.module.js'

it('never returns credential fields', async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
  const app = moduleRef.createNestApplication()
  await app.init()

  const res = await request(app.getHttpServer()).get('/users/8f1c-0000-0000-0000').expect(200)

  for (const forbidden of ['passwordHash', 'passwordResetToken', 'failedLoginCount']) {
    expect(res.body).not.toHaveProperty(forbidden)
  }

  await app.close()
})
```

A test like this belongs on every resource that has a credential column, and it is cheap enough to keep for all of them.

## Production considerations

**Serialization runs on every response.** `classToPlain()` walks the object graph; a schema runs its validator. On a list endpoint returning 100 items, that is 100 traversals. Keep response shapes small, paginate, and do not serialize a relation you did not need — see [Performance](../nestjs-production/performance.md).

**Register one serializer, globally, through `APP_INTERCEPTOR`.** A per-controller interceptor is opt-in protection, and the controller someone adds next month will not have it.

**A missing field in production is usually a serialization change.** When a client reports data disappearing, check `@Expose()`, `groups`, and the response schema before the query. This is the most common false "the database lost my data" report.

**Keep the response contract in version control next to the route.** Whether it is a response class or a schema, it is the API's actual interface — more so than any document generated from it.

**Generate documentation from the same artifact.** `@nestjs/swagger` 12.0.1 reads response classes directly through `@ApiOkResponse({ type: UserResponse })`; a Zod response schema goes through `z.toJSONSchema()` or a zod-to-OpenAPI package. Either way, generate from the thing that runs so the document cannot describe a response you do not send.

**Pin `class-transformer` at 0.5.1 exactly.** It is pre-1.0, it is the package deciding what leaves your server, and its behavior has changed in patch-looking releases.

## Common mistakes

- **Returning the persistence entity from a controller with no serializer registered.** The response is the row.
- **Relying on `@Exclude()` alone.** It is a denylist; the next column is public by default.
- **Decorating an entity and returning a plain object.** Prisma rows and `.lean()` documents carry no metadata, so nothing is excluded and nothing warns you.
- **Registering the interceptor only in `main.ts`.** Tests built from `AppModule` do not run it, so they cannot catch a leak.
- **Wrapping a list response schema in `z.array()`.** The Standard Schema serializer applies the schema per element.
- **Using `z.strictObject()` for a response.** An extra key becomes a 500 instead of being stripped.
- **A response schema stricter than the data.** One `null` in a non-nullable field takes the endpoint down.
- **Treating `@SerializeOptions({ groups })` as an authorization check.** It selects fields; a guard decides access.
- **Registering both serializers globally.** They share one metadata key and one response, and the second transforms the first's output.
- **Forgetting nested relations.** The excluded field on the parent says nothing about the child's token column.
- **Verifying by reading the entity file.** Assert on the response body in a test.

## Related topics

- [Standard Schema with Zod](standard-schema-with-zod.md) — the request-side half of the schema stack.
- [class-validator and class-transformer](class-validator.md) — the same library, running on input.
- [Choosing an approach](choosing-an-approach.md) — pick the serializer that matches your validation stack.
- [Transforming payloads](transforming-payloads.md) — `@Transform()` and `class-transformer` options on the request side.
- [Whitelisting and unknown properties](unknown-properties.md) — the same allowlist idea, applied to input.
- [Interceptors](../nestjs-request-handling/interceptors.md) — where these run in the request lifecycle.
- [Exception filters](../nestjs-request-handling/exception-filters.md) — the response path serialization does not cover.
- [Authorization and IDOR](../nestjs-security/authorization-and-idor.md) — the control groups are not.
- [OpenAPI with Swagger](../nestjs-libraries/swagger.md) — documenting the response contract you just defined.
- [Logging without leaking PII](../security/logging-without-leaking-pii.md) — the same fields, on the other output channel.
