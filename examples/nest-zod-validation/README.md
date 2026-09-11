# nest-zod-validation — Standard Schema validation in NestJS 12

The same CRUD validation as `nest-crud-module`, done with **Zod 4** instead of
`class-validator`. There is no DTO class in this project: Nest 12 accepts any
[Standard Schema](https://github.com/standard-schema/standard-schema) object, so
the schema *is* the type and the contract at once.

## What it demonstrates

| Thing | Where |
| --- | --- |
| `@Body({ schema })` — schema on the parameter metadata | `src/tasks/tasks.controller.ts` |
| `@Query({ schema })` with coercion and defaults | `src/tasks/tasks.controller.ts` |
| `StandardSchemaValidationPipe` registered globally | `src/main.ts` |
| A custom `exceptionFactory` shaping the 400 body from `issues` | `src/main.ts` |
| `@SerializeOptions({ schema })` + `StandardSchemaSerializerInterceptor` | controller + `src/main.ts` |
| Response stripping: `ownerEmail` / `internalNote` never leave | `src/tasks/task.schemas.ts` |
| Zod 4 spelling: `z.email()`, `z.uuid()`, `z.iso.datetime()`, `z.strictObject()` | `src/tasks/task.schemas.ts` |
| One definition per shape, `z.infer` for the TypeScript type | `src/tasks/task.schemas.ts` |

## Prerequisites

Node **20.19+ / 22.12+ / 24 LTS**. Nothing else.

## Install, build, run

```bash
cd examples/nest-zod-validation
npm install
npm run setup     # = npm run build = tsc -p tsconfig.json
npm start
```

Port **3032**, overridable with `PORT`.

## How the three pieces fit

```ts
// 1. the schema travels on the parameter
create(@Body({ schema: createTaskSchema }) body: CreateTaskInput) { … }

// 2. a global pipe finds it and validates, returning the schema's OUTPUT
app.useGlobalPipes(new StandardSchemaValidationPipe({ transform: true }))

// 3. a global interceptor reads @SerializeOptions({ schema }) on the way out
app.useGlobalInterceptors(new StandardSchemaSerializerInterceptor(app.get(Reflector)))
```

The verified option surface, read from `@nestjs/common@12.0.1`'s own `.d.ts`:

```ts
interface StandardSchemaValidationPipeOptions {
  transform?: boolean                  // default true — return the parsed output
  validateCustomDecorators?: boolean   // default false
  validateOptions?: Record<string, unknown>
  errorHttpStatusCode?: ErrorHttpStatusCode  // default 400
  exceptionFactory?: (issues: readonly StandardSchemaV1.Issue[]) => any
}
```

`transform: true` matters more than it looks: with it, `query.limit` is the
**number** 20 when the caller sent nothing and the number 5 when they sent
`?limit=5`, because those are the schema's output type. With `transform: false`
you get the raw input back after a successful check, and your handler still has
strings.

## Routes

### `GET /health`

```bash
curl -s http://localhost:3032/health
```

```json
{"status":"ok"}
```

### `GET /tasks?status=&limit=&offset=`

```bash
curl -s 'http://localhost:3032/tasks?limit=1'
```

```json
{"data":[{"id":"d5a0e575-bf0b-45d4-8a9c-2b4c8759416e","title":"Learn Standard Schema","notes":"","status":"doing","createdAt":"2026-09-11T18:27:06.629Z"}],"total":2}
```

Out of range, with the `exceptionFactory` body:

```bash
curl -s 'http://localhost:3032/tasks?limit=0'
```

```json
{"error":{"code":"VALIDATION_FAILED","message":"Request validation failed","issues":[{"path":"limit","message":"Too small: expected number to be >=1"}]}}
```

An unknown query key, because the query schema is a `strictObject`:

```bash
curl -s 'http://localhost:3032/tasks?bogus=1'
```

```json
{"error":{"code":"VALIDATION_FAILED","message":"Request validation failed","issues":[{"path":"","message":"Unrecognized key: \"bogus\""}]}}
```

Note the empty `path`: an unrecognized-key issue is reported against the object,
not against the key. That is Zod's issue shape, not Nest's.

### `POST /tasks`

```bash
curl -s -X POST http://localhost:3032/tasks \
  -H 'content-type: application/json' \
  -d '{"title":"schema-first 2","ownerEmail":"ada@example.com"}'
```

```json
{"id":"75570e19-6b9c-4db7-87f5-a375a5aef180","title":"schema-first 2","notes":"","status":"todo","createdAt":"2026-09-11T18:27:11.891Z"}
```

`status` was not sent and came back `"todo"` — that is `.default('todo')` in the
request schema. `ownerEmail` **was** sent, was accepted, and is **not** in the
response — that is the response schema.

Failures:

```bash
curl -s -X POST http://localhost:3032/tasks -H 'content-type: application/json' \
  -d '{"title":"x","ownerEmail":"nope"}'
```

```json
{"error":{"code":"VALIDATION_FAILED","message":"Request validation failed","issues":[{"path":"ownerEmail","message":"Invalid email address"}]}}
```

```bash
curl -s -X POST http://localhost:3032/tasks -H 'content-type: application/json' \
  -d '{"title":"x","isAdmin":true}'
```

```json
{"error":{"code":"VALIDATION_FAILED","message":"Request validation failed","issues":[{"path":"","message":"Unrecognized key: \"isAdmin\""}]}}
```

`z.strictObject` is the mass-assignment defence. A plain `z.object` would have
**stripped** `isAdmin` and returned 201 — safe, but silent. Strict tells the
caller.

### `GET /tasks/:id` versus `GET /tasks/:id/raw`

This is the serializer, isolated. Same handler body, same service call; the only
difference is `@SerializeOptions({ schema: publicTaskSchema })`.

```bash
curl -s http://localhost:3032/tasks/d5a0e575-bf0b-45d4-8a9c-2b4c8759416e
```

```json
{"id":"d5a0e575-bf0b-45d4-8a9c-2b4c8759416e","title":"Learn Standard Schema","notes":"","status":"doing","createdAt":"2026-09-11T18:27:06.629Z"}
```

```bash
curl -s http://localhost:3032/tasks/d5a0e575-bf0b-45d4-8a9c-2b4c8759416e/raw
```

```json
{"id":"d5a0e575-bf0b-45d4-8a9c-2b4c8759416e","title":"Learn Standard Schema","notes":"","status":"doing","createdAt":"2026-09-11T18:27:06.629Z","ownerEmail":null,"internalNote":"never serialize me"}
```

The `/raw` route is there to prove the point and would be a bug in a real
service. An allow-list response schema is the only reliable way to stop a field
added to the storage model six months from now from appearing in the API by
itself.

### `PATCH /tasks/:id`

```bash
curl -s -X PATCH http://localhost:3032/tasks/d5a0e575-bf0b-45d4-8a9c-2b4c8759416e \
  -H 'content-type: application/json' -d '{"status":"done"}'
```

```json
{"id":"d5a0e575-bf0b-45d4-8a9c-2b4c8759416e","title":"Learn Standard Schema","notes":"","status":"done","createdAt":"2026-09-11T18:27:06.629Z"}
```

The update schema is `createTaskSchema.partial()` — one line, and it cannot drift
from the create schema.

### A malformed id is still a pipe, not a schema

```bash
curl -s http://localhost:3032/tasks/nope
```

```json
{"message":"Validation failed (uuid is expected)","error":"Bad Request","statusCode":400}
```

That body is Nest's built-in `ParseUUIDPipe` and the default exception filter —
this example deliberately installs no filter of its own, so you can see which
bodies come from where. `nest-crud-module` shows what a filter does to them.

## class-validator or Standard Schema?

| | `class-validator` (`nest-crud-module`) | Standard Schema (this example) |
| --- | --- | --- |
| Source of truth | a DTO class with decorators | a schema object |
| TypeScript type | the class | `z.infer<typeof schema>` |
| Needs `emitDecoratorMetadata` | yes, for the DTO | no (still needed for Nest's own DI) |
| Extra runtime deps | `class-validator`, `class-transformer` | your schema library |
| Reuse outside Nest | awkward | the same schema runs in a worker, a CLI, or the browser |
| Swagger generation | `@nestjs/swagger` reads the decorators | needs a schema→OpenAPI bridge |
| Unknown keys | `forbidNonWhitelisted: true` | `z.strictObject` |
| Response filtering | `ClassSerializerInterceptor` + `@Exclude` | `@SerializeOptions({ schema })` |

Both are current and supported in Nest 12. Pick one per service and do not mix
them in the same module — two validation styles in one codebase means two places
to look when a field is rejected.

## Related examples

- `nest-crud-module` — the `class-validator` version of the same routes.
- `nest-minimal-api` — the skeleton with no validation at all.
