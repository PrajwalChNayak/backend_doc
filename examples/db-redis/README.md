# db-redis — cache-aside, locks and SCAN with node-redis

An Express 5 API over `redis@6` (node-redis). A deliberately slow in-memory store stands
in for the expensive thing you are caching, so the difference between a hit and a miss
shows up in the response body.

## What it demonstrates

| Thing | Where |
| --- | --- |
| One reused client + a bounded `reconnectStrategy` | `src/redis.js` |
| Cache-aside: read cache → miss → read store → write back with a TTL | `GET /users/:id` |
| Invalidate by **deleting** the key, not updating it | `PATCH /users/:id` |
| `SET key value NX EX ttl` as a distributed lock | `POST /locks/:name` |
| Compare-and-delete lock release via a Lua script | `DELETE /locks/:name` |
| `SCAN` (cursor, non-blocking) instead of `KEYS` | `GET /cache/keys` |
| Pub/sub on a **separate** connection via `duplicate()` | `src/redis.js`, `src/server.js` |
| Redis failures degrading to "always a miss" rather than 500s | `GET /users/:id` |

## Prerequisites

Node 24 and a Redis server.

```bash
docker run --rm -p 6379:6379 redis:8
```

Default `REDIS_URL` is `redis://localhost:6379`.

**Without Redis the example prints a connection-help block and exits 1.** Set
`DEGRADED_OK=1` to keep serving with `/health` returning `503 {"status":"degraded"}`.

## Install and run

```bash
cd examples/db-redis
npm install
npm start
```

Default port **3014** (`PORT`). Other knobs: `CACHE_TTL` (seconds, default 30),
`SLOW_MS` (simulated store latency, default 250).

## Routes

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` | `PING`; 503 when Redis is down |
| GET | `/users/:id` | cache-aside read (1, 2 or 3 exist) |
| PATCH | `/users/:id` | update the store and invalidate the key |
| POST | `/locks/:name` | acquire a lock with `SET … NX EX` |
| DELETE | `/locks/:name` | release it (send `x-lock-token`) |
| GET | `/cache/keys?match=&count=` | list keys with `SCAN` |
| DELETE | `/cache/keys?match=` | delete matching keys, page by page |
| GET | `/stats` | how many times the backing store was actually read |

### The cache working

```bash
curl -s localhost:3014/users/1
# {"source":"store","ttl":30,"tookMs":253,"user":{"id":1,...}}

curl -s localhost:3014/users/1
# {"source":"cache","ttl":29,"tookMs":1,"user":{"id":1,...}}

curl -s localhost:3014/stats
# {"backingStoreReads":1,"simulatedStoreLatencyMs":250,"cacheTtlSeconds":30}
```

Two requests, one read of the backing store.

### Invalidation

```bash
curl -s -X PATCH localhost:3014/users/1 -H 'content-type: application/json' \
  -d '{"name":"Augusta Ada King"}'
# {"user":{"id":1,...,"name":"Augusta Ada King"},"invalidatedKeys":1}

curl -s localhost:3014/users/1
# {"source":"store",...}   <- repopulated with the new value
```

### The lock

```bash
curl -s -X POST localhost:3014/locks/nightly-report -H 'content-type: application/json' -d '{"ttl":30}'
# 201 {"acquired":true,"token":"7f3c…","expiresInSeconds":30}

curl -s -X POST localhost:3014/locks/nightly-report -H 'content-type: application/json' -d '{"ttl":30}'
# 409 {"acquired":false,"expiresInSeconds":28}

curl -s -X DELETE localhost:3014/locks/nightly-report -H 'x-lock-token: 7f3c…'
# {"released":true}
```

### SCAN

```bash
curl -s 'localhost:3014/cache/keys?match=example:user:*'
# {"match":"example:user:*","pages":1,"count":2,"keys":["example:user:1","example:user:2"]}
```

## The points this example makes

### The TTL is a correctness bound, not a speed knob

A cached value is a copy that can be wrong. The TTL is your maximum staleness, and the
backstop for every invalidation you forget to write. A cache entry with no expiry is a
second source of truth that nothing keeps in sync.

### Invalidate by deleting

`PATCH` deletes the key rather than writing the new value into it. Writing races with
any reader that is already mid-repopulate and can leave the cache holding the *older*
value indefinitely. Deleting is idempotent and always converges to a fresh read.

### `SET … NX EX` in one command

```js
await redis.set(key, token, { expiration: { type: 'EX', value: ttl }, condition: 'NX' })
```

`NX` makes the write conditional, so exactly one caller wins with no check-then-act
race. `EX` guarantees the lock disappears if the winner crashes before releasing it —
a lock without an expiry deadlocks the job forever the first time a pod is OOM-killed.
The value is a random token so `DELETE` can verify ownership before deleting; that
compare-and-delete runs as a Lua script because doing it as `GET` then `DEL` is a race.

> Single-node `SET NX EX` is a *best-effort* lock. It is fine for "don't run this cron
> twice", not for anything where two holders would corrupt data. For that you need
> fencing tokens or a consensus system.

Note the option shape: node-redis v6 deprecated the flat `{ EX: 30, NX: true }` form in
favour of `{ expiration: { type: 'EX', value: 30 }, condition: 'NX' }`. The old keys
still work and still emit a deprecation notice in the types.

### `SCAN`, never `KEYS`

Redis executes commands on one thread. `KEYS pattern` walks the whole keyspace in a
single uninterruptible pass — on a few million keys that is hundreds of milliseconds
during which every other client is blocked. `SCAN` is a cursor: it returns a bounded
page and lets other commands run in between.

The price is a weaker guarantee. A key present for the entire iteration is returned at
least once; keys added or removed mid-scan may or may not appear, and duplicates are
possible. `GET /cache/keys` collects into a `Set` for exactly that reason.

In node-redis v5 and later, `scanIterator()` yields **one array of keys per page**, not
one key at a time.

### Pub/sub needs its own connection

Once a connection issues `SUBSCRIBE`, Redis only accepts subscribe/unsubscribe/ping/quit
on it — a `GET` on that socket is an error. `redis.duplicate()` clones the config onto a
fresh connection, which is what `src/server.js` does for the `example:events` channel.
The same applies to blocking commands (`BLPOP`, `XREAD BLOCK`): they occupy the
connection for their whole timeout.

## Production considerations

- Redis being down should degrade the response, not fail it. `GET /users/:id` catches
  cache errors and falls through to the store — a cache outage becomes slow, not broken.
- The default `reconnectStrategy` retries forever. A bounded one surfaces a wrong
  `REDIS_URL` instead of hiding it in logs.
- `redis.quit()` on shutdown drains in-flight commands; `destroy()` drops them.
- Namespace your keys (`example:user:1` here). A shared Redis with unprefixed keys makes
  `SCAN`-and-delete somebody else's outage.
- Set `maxmemory` and an eviction policy on the server. Without them a cache with TTLs
  still grows until the box runs out of RAM.
