# nest-mongoose — @nestjs/mongoose 12 and Mongoose 9

A NestJS 12 API over MongoDB: decorator schemas, model injection, a populated
reference, and the two NoSQL-injection defences that actually matter.

> ### This example needs a real MongoDB server
>
> It is the only one in the NestJS set that does. Everything else defaults to
> SQLite and runs unattended.
>
> ```bash
> docker run --rm -p 27017:27017 mongo:8
> ```
>
> Without it the app prints the hint below and exits 1 — it does not hang, and
> it does not pretend to be healthy. `smoke.json` is marked
> `"requiresService": true`, so `scripts/run-examples.mjs` reports it as
> **skipped-no-service** rather than failed.

### Honest status of this README

The build, the boot path and the "no server" failure path were executed on the
authoring machine. **The MongoDB-backed routes were not**: the Docker daemon was
not running there (`docker info` → *"failed to connect to the docker API at
npipe:////./pipe/dockerDesktopLinuxEngine"*), and no MongoDB was listening on
27017. The route bodies below are therefore described from the code, not pasted
from a live response, and `smoke.json` carries the same warning. The failure
output further down **is** real.

## What it demonstrates

| Thing | Where |
| --- | --- |
| `MongooseModule.forRoot(uri, { retryAttempts: 0 })` | `src/app.module.ts` |
| `MongooseModule.forFeature([{ name, schema }])` | `src/products/products.module.ts` |
| `@Schema()` / `@Prop()` / `SchemaFactory.createForClass` | `src/products/product.schema.ts` |
| `@InjectModel(Product.name)` and `Model<ProductDocument>` | `src/products/products.service.ts` |
| `@InjectConnection()` for a readiness probe | `src/health.controller.ts` |
| A reference + `.populate('categoryId', 'slug title')` | `GET /products/:id` |
| **NoSQL injection defence** — `$eq` and an escaped `RegExp` | `src/products/products.service.ts` |
| Duplicate key (`code: 11000`) → 409 | `src/products/products.service.ts` |
| `isValidObjectId` so a bad id is 404, not a CastError 500 | `src/products/products.service.ts` |
| Idempotent fixtures through `OnModuleInit` | `src/products/products.module.ts` |

## Prerequisites

- Node **20.19+ / 22.12+ / 24 LTS**
- MongoDB 8, reachable at `mongodb://127.0.0.1:27017/nest_mongoose_example`
  (override with `MONGODB_URI`)

## Install, build, run

```bash
cd examples/nest-mongoose
npm install
npm run setup     # = npm run build
docker run --rm -p 27017:27017 mongo:8   # in another terminal
npm start
```

### What happens with no server — real output

```bash
PORT=3035 node dist/main.js
```

```
  nest-mongoose needs a MongoDB server and could not reach one at:
    mongodb://127.0.0.1:27017/nest_mongoose_example

  Start one with Docker:

    docker run --rm -p 27017:27017 mongo:8

  …then run `npm start` again. Override the target with MONGODB_URI.

  (driver said: connect ECONNREFUSED 127.0.0.1:27017)
```

Exit code **1**.

That message comes from a deliberate pre-flight connection in `src/main.ts`
before Nest boots. Two things make it useful:

- `retryAttempts: 0` on `MongooseModule.forRoot` — the default retries ten times
  and buries the cause under thirty seconds of noise;
- `serverSelectionTimeoutMS: 3000` — the driver's default is 30 s, which looks
  like a hang.

## Routes

Port **3035**, overridable with `PORT`.

### `GET /health` — liveness

```json
{"status":"ok"}
```

It deliberately says nothing about MongoDB. A liveness probe that checks a
dependency gets your healthy process restarted during a database failover, which
is precisely when you need it running.

### `GET /ready` — readiness

Readiness *is* allowed to care. It reads `connection.readyState` and answers
**503** with `{"status":"degraded","mongodb":"disconnected"}` when the driver is
not connected, so a load balancer stops routing to this instance while the app
stays up.

### `GET /products?limit=&offset=`

Returns `{ data, meta: { total, limit, offset } }`, sorted by `sku`, using
`.lean()` — plain objects instead of hydrated documents, which is what you want
for a read you are about to serialise.

### `GET /products/:id`

`populate('categoryId', 'slug title')` resolves the reference and selects only
two fields of it. An id that is not a valid ObjectId is a **404**, because
`findById` on a malformed id throws a `CastError` that would otherwise surface as
a 500:

```ts
if (!isValidObjectId(id)) throw new NotFoundException(`No product with id ${id}`)
```

### `GET /products/search?q=` — the NoSQL-injection route

This is the reason the example exists.

```bash
curl -s 'http://localhost:3035/products/search?q[$ne]=x'
```

Express parses `q[$ne]=x` into the **object** `{ $ne: 'x' }`. Handed straight to
`find({ sku: q })`, that runs an operator the caller chose — `$ne` matches
everything, `$gt` walks an index, `$regex` can be a denial of service, and on
older stacks `$where` was remote code execution. The defence is three lines,
all of them in this example:

1. the controller rejects a non-string `q` with a 400 — a search term is a
   string, and that is checkable;
2. the service calls `String(term)` so nothing object-shaped survives;
3. the query uses `{ sku: { $eq: value } }`, which pins the comparison to
   equality and cannot be re-interpreted as an operator.

The name half of the search escapes the term before it becomes a `RegExp`:

```ts
input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
```

Without that, `.*` is a caller-supplied scan and `(a+)+$` is a caller-supplied
CPU bill.

### `POST /products`

```bash
curl -s -X POST http://localhost:3035/products \
  -H 'content-type: application/json' \
  -d '{"name":"Trackball","sku":"TB-009","priceCents":8900,"tags":["input"]}'
```

A repeated `sku` hits the unique index and comes back **409** — the service
catches driver error `code: 11000` rather than checking first, because a check
before an insert is a race.

The DTO constrains `sku` with `@Matches(/^[A-Z0-9-]{3,32}$/)`, and the schema
itself is `strict: true`, so a key the schema does not declare is dropped at the
storage layer even if validation somehow let it through. Defence in depth: the
pipe rejects it, and the schema would not have written it.

### `DELETE /products/:id`

204 on success, 404 when `deletedCount === 0`.

## Related examples

- `examples/orm-mongoose` — the same ideas from plain Express 5.
- `nest-typeorm` / `nest-prisma` — the SQL counterparts, which run with no server.
