# nest-minimal-api — the smallest honest NestJS 12 API

One module, one controller, one service, a real TypeScript build step, and
nothing else. If you want to know what Nest actually requires before any of the
convenience layers arrive, this is the whole of it.

## What it demonstrates

| Thing | Where |
| --- | --- |
| `@Module` — the unit Nest resolves dependencies inside | `src/app.module.ts` |
| `@Controller` / `@Get` / `@Post` route mapping | `src/app.controller.ts` |
| `@Injectable` + constructor injection | `src/app.service.ts` |
| `@Param` and `@Query` parameter decorators | `src/app.controller.ts` |
| `NestFactory.create()` and `app.listen(PORT)` | `src/main.ts` |
| Why `reflect-metadata` is imported first | `src/main.ts` |
| A **real build step** — Nest cannot run from type-stripping | `tsconfig.json`, `npm run build` |

## Prerequisites

- Node.js **20.19+, 22.12+, or 24 LTS**. `@nestjs/core@12` declares
  `engines.node: ">= 20"`; this handbook targets **Node 24 LTS**.
- Nothing else. No database, no Docker, no `.env` file.

> The `@nestjs/cli` needs a newer Node than the app does — `@nestjs/schematics@12`
> declares `>=22.12.0`. You do not need the CLI to run this example; `tsc` is
> enough.

## Why there is a build step at all

Node 24 can execute TypeScript directly by stripping the types — but stripping
only erases syntax, it cannot *emit* anything. Decorators emit: `@Controller()`
becomes a call, and `emitDecoratorMetadata` writes a `design:paramtypes` entry
that is how Nest discovers which class to inject into a constructor. So:

```json
{
  "experimentalDecorators": true,
  "emitDecoratorMetadata": true
}
```

and a compile to `dist/`. `npm start` runs plain JavaScript — there is no
TypeScript at runtime.

Two tsconfig details worth copying:

- `"module": "nodenext"` with **no** `"type"` field in `package.json` emits
  CommonJS. Nest 12's own packages are ESM (`"type": "module"` in
  `@nestjs/core` and `@nestjs/common`), and this CommonJS output consumes them
  through Node's `require(esm)` support — which is why the floor is Node 20.19.
- `"moduleResolution": "node"` **no longer exists** in TypeScript 7. It fails
  with `TS5108: Option 'moduleResolution=node10' has been removed`. Use
  `nodenext`.

## Install, build, run

```bash
cd examples/nest-minimal-api
npm install
npm run setup     # = npm run build = tsc -p tsconfig.json
npm start
```

```
[Nest] 17424  - 09/11/2026, 11:51:00 PM     LOG [NestFactory] Starting Nest application...
[Nest] 17424  - 09/11/2026, 11:51:00 PM     LOG [RoutesResolver] AppController {/}:
[Nest] 17424  - 09/11/2026, 11:51:00 PM     LOG [RouterExplorer] Mapped {/health, GET} route
[Nest] 17424  - 09/11/2026, 11:51:00 PM     LOG [NestApplication] Nest application successfully started
nest-minimal-api listening on http://localhost:3030
```

Port **3030**, overridable with `PORT`.

## Routes

### `GET /health`

```bash
curl -s http://localhost:3030/health
```

```json
{"status":"ok"}
```

Liveness only. It does not touch a database, because a liveness probe that
checks a dependency restarts healthy processes during a dependency blip.

### `GET /`

```bash
curl -s http://localhost:3030/
```

```json
{"name":"nest-minimal-api","framework":"NestJS 12 on Express 5","node":"v24.20.0","uptimeSeconds":4}
```

### `GET /greet/:name`

```bash
curl -s http://localhost:3030/greet/Ada
```

```json
{"message":"Hello, Ada!","at":"2026-09-11T18:21:04.424Z"}
```

An unacceptable name is a 404 produced by throwing `NotFoundException` — you
never touch `res` to set a status:

```bash
curl -s 'http://localhost:3030/greet/%3Cscript%3E'
```

```json
{"message":"No greeting for \"<script>\"","error":"Not Found","statusCode":404}
```

### `GET /echo?msg=`

```bash
curl -s 'http://localhost:3030/echo?msg=hello'
```

```json
{"echo":"hello","received":"2026-09-11T18:21:04.641Z"}
```

`@Query()` hands you a copy of `req.query`. In Express 5 `req.query` is a
**getter** and cannot be assigned to, so a validation layer must write its
output somewhere else — see `nest-crud-module` and `nest-zod-validation` for the
two supported ways of doing that.

### `POST /echo?tag=`

```bash
curl -s -i -X POST 'http://localhost:3030/echo?tag=t' | head -1
```

```
HTTP/1.1 201 Created
```

Nest answers **201** for a POST by default. Use `@HttpCode(200)` when the route
does not create anything.

### Unknown routes

```bash
curl -s http://localhost:3030/no-such-route
```

```json
{"message":"Cannot GET /no-such-route","error":"Not Found","statusCode":404}
```

That body is Nest's built-in exception filter. `nest-crud-module` replaces it
with a filter of its own.

## The point

A Nest application is three decorators and a factory call. Everything else in
this set of examples — pipes, guards, interceptors, filters, ORM modules — is
additive, and each one is worth adding only when you can name the problem it
solves. Start here, then read `nest-crud-module` to see the same shape with the
request pipeline filled in.

## Related examples

- `nest-crud-module` — the same skeleton with DTOs, a ValidationPipe, a guard, an
  interceptor and an exception filter.
- `nest-esm` — this example again as a pure-ESM project, so you can diff the two
  `tsconfig.json` files.
