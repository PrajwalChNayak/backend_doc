# nest-crud-module — the reference NestJS 12 feature module

A complete `tasks` feature: DTOs, a global `ValidationPipe`, a guard, an
interceptor, an exception filter, and a repository behind a service. The store
is in memory, so the example needs no database, no Docker and no `.env`.

This is the file layout to copy when you start a real Nest service.

## What it demonstrates

| Concern | File | Point of interest |
| --- | --- | --- |
| Feature module boundary | `src/tasks/tasks.module.ts` | providers are private unless `exports`ed |
| Controller = HTTP only | `src/tasks/tasks.controller.ts` | every handler is two lines |
| Service = the rules | `src/tasks/tasks.service.ts` | "missing is a 404" is expressed by throwing |
| Repository = storage | `src/tasks/tasks.repository.ts` | swap it for TypeORM and nothing above changes |
| DTO validation | `src/tasks/dto/` | `class-validator` decorators are the contract |
| Mass-assignment defence | `src/main.ts` | `whitelist` + `forbidNonWhitelisted` |
| Query coercion | `src/tasks/dto/list-tasks.dto.ts` | `transform: true` + `@Type(() => Number)` |
| Custom decorator + `Reflector` | `src/common/public.decorator.ts`, `api-key.guard.ts` | `SetMetadata` written, `getAllAndOverride` read |
| Guard | `src/common/api-key.guard.ts` | constant-time key compare, runs **before** pipes |
| Interceptor | `src/common/envelope.interceptor.ts` | `{ data, meta }` envelope + timing header |
| Exception filter | `src/common/http-exception.filter.ts` | one error shape; unknown errors never leak a stack |
| `ParseUUIDPipe` | `src/tasks/tasks.controller.ts` | "not a uuid" (400) is a different answer from "no such task" (404) |

## Prerequisites

Node **20.19+ / 22.12+ / 24 LTS**. Nothing else.

## Install, build, run

```bash
cd examples/nest-crud-module
npm install
npm run setup     # = npm run build = tsc -p tsconfig.json
npm start
```

Port **3031**, overridable with `PORT`. The API key defaults to
`dev-secret-key`; override it with `API_KEY`.

## The request pipeline, in the order it actually runs

```
middleware → guard → interceptor (pre) → pipe → handler
                   → interceptor (post) → filter (error path only)
```

Two consequences you can see in this example:

- The guard runs **before** the `ValidationPipe`, so `POST /tasks` with no API
  key and a garbage body is a **401**, not a 400. Rejecting an unauthenticated
  request must not depend on its body parsing.
- Errors skip the interceptor's `map()` and go to the filter, which is why the
  success envelope (`{ data, meta }`) and the error envelope (`{ error }`) are
  defined in two different files.

## Routes

### `GET /health`

```bash
curl -s http://localhost:3031/health
```

```json
{"status":"ok"}
```

It sits on its own controller with no guard and no interceptor, so the body is
exactly that — a probe should not have to unwrap an envelope.

### `GET /tasks?status=&limit=&offset=`

```bash
curl -s 'http://localhost:3031/tasks?limit=2'
```

```json
{"data":[{"id":"47111012-2698-46b0-8a20-1df3ba091329","title":"Read the request pipeline docs","notes":"","status":"doing","createdAt":"2026-09-11T18:24:36.892Z","updatedAt":"2026-09-11T18:24:36.892Z"},{"id":"66706ae6-b5f3-4cb6-97ec-617e64e52c21","title":"Write a DTO for every route","notes":"","status":"todo","createdAt":"2026-09-11T18:24:36.892Z","updatedAt":"2026-09-11T18:24:36.892Z"}],"meta":{"total":3,"limit":2,"offset":0,"requestId":"9cdee1ed-6be0-4090-af41-dea52a2d7092","durationMs":4.134}}
```

`limit` and `offset` arrive as strings and leave the pipe as numbers, with
defaults applied — because the DTO says `@Type(() => Number)` and the pipe says
`transform: true`.

Out of range:

```bash
curl -s 'http://localhost:3031/tasks?limit=500'
```

```json
{"error":{"code":"VALIDATION_FAILED","message":"Request validation failed","details":["limit must not be greater than 100"],"requestId":"d1f2606c-82bb-4697-9454-91f929517f19"}}
```

An undeclared query key is a 400 too, not a silent ignore:

```bash
curl -s 'http://localhost:3031/tasks?nope=1'
```

```json
{"error":{"code":"VALIDATION_FAILED","message":"Request validation failed","details":["property nope should not exist"],"requestId":"3a475b0a-099f-40e9-8e02-778f7e497ad4"}}
```

### `GET /tasks/:id`

```bash
curl -s http://localhost:3031/tasks/not-a-uuid
```

```json
{"error":{"code":"BAD_REQUEST","message":"Validation failed (uuid is expected)","requestId":"4099a4d6-719c-457f-911d-61f11223be3f"}}
```

```bash
curl -s -i http://localhost:3031/tasks/2a9f0b24-3f6a-4c1e-9f6d-0b1f4b0c9a11 | head -1
```

```
HTTP/1.1 404 Not Found
```

### `POST /tasks` — needs the key

```bash
curl -s -X POST http://localhost:3031/tasks \
  -H 'content-type: application/json' -d '{"title":"x"}'
```

```json
{"error":{"code":"UNAUTHORIZED","message":"A valid x-api-key header is required"}}
```

With the key:

```bash
curl -s -X POST http://localhost:3031/tasks \
  -H 'content-type: application/json' -H 'x-api-key: dev-secret-key' \
  -d '{"title":"smoke task 2","status":"todo"}'
```

```json
{"data":{"id":"802f3fe8-5da0-4a4a-8bab-112f32110d79","title":"smoke task 2","notes":"","status":"todo","createdAt":"2026-09-11T18:24:42.408Z","updatedAt":"2026-09-11T18:24:42.408Z"},"meta":{"requestId":"05a61204-fbdb-4211-b173-78a8d9126849","durationMs":0.273}}
```

**Mass assignment is a 400, not a silent drop:**

```bash
curl -s -X POST http://localhost:3031/tasks \
  -H 'content-type: application/json' -H 'x-api-key: dev-secret-key' \
  -d '{"title":"m","isAdmin":true}'
```

```json
{"error":{"code":"VALIDATION_FAILED","message":"Request validation failed","details":["property isAdmin should not exist"],"requestId":"91f82af1-5a0e-4fd5-b3f6-e1f65ae8de5e"}}
```

`whitelist: true` alone would have quietly deleted `isAdmin` and created the
task. `forbidNonWhitelisted: true` is what turns it into an answer. Use both.

### `PATCH /tasks/:id` — needs the key

```bash
curl -s -X PATCH http://localhost:3031/tasks/47111012-2698-46b0-8a20-1df3ba091329 \
  -H 'content-type: application/json' -H 'x-api-key: dev-secret-key' \
  -d '{"status":"done"}'
```

```json
{"data":{"id":"47111012-2698-46b0-8a20-1df3ba091329","title":"Read the request pipeline docs","notes":"","status":"done","createdAt":"2026-09-11T18:24:36.892Z","updatedAt":"2026-09-11T18:24:50.394Z"},"meta":{"requestId":"ffca0519-6d6b-4e52-a241-5fc2a44455c4","durationMs":0.547}}
```

The body class is `PartialType(CreateTaskDto)` — every rule from the create DTO
still applies, but nothing is required.

### `DELETE /tasks/:id` — needs the key

```bash
curl -s -i -X DELETE http://localhost:3031/tasks/47111012-2698-46b0-8a20-1df3ba091329 \
  -H 'x-api-key: dev-secret-key' | head -3
```

```
HTTP/1.1 204 No Content
X-Powered-By: Express
x-request-id: 2cf5fdc1-fe66-4bbe-ab51-df4c2ecce05c
```

The handler returns `undefined`, and the interceptor deliberately passes
`undefined` through untouched — wrapping it would write a body on a response
that is defined to have none.

## What the guard is and is not

`ApiKeyGuard` is a shared-secret check, which is the right shape for a
service-to-service caller and the wrong shape for a user. It exists here to show
the mechanism: `@Public()` writes metadata with `SetMetadata`, the guard reads it
back with `Reflector.getAllAndOverride`, handler metadata beats controller
metadata. `@Roles()` in `nest-jwt-auth` is the same three moving parts with a
user attached.

The comparison uses `timingSafeEqual` on equal-length buffers. A `===` on a
secret is a byte-at-a-time oracle over a network you do not control.

## Where the layers stop

- `src/tasks/tasks.controller.ts` is the only file that mentions HTTP verbs.
- `src/tasks/tasks.service.ts` is the only file that decides a rule.
- `src/tasks/tasks.repository.ts` is the only file that knows how rows are
  stored.

Replace the repository with `nest-typeorm`'s or `nest-prisma`'s and the two
files above it do not change. That is the entire argument for the layering.

## Related examples

- `nest-minimal-api` — the same skeleton with none of this, to see what Nest
  requires versus what you chose.
- `nest-zod-validation` — the same validation done with Zod 4 through Nest 12's
  Standard Schema support instead of `class-validator`.
- `nest-jwt-auth` — a real user behind the guard, with roles.
