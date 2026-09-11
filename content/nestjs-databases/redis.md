---
title: Redis
description: Redis in a Nest application two ways — @nestjs/cache-manager 12 with cache-manager 7 and @keyv/redis for cache-aside, and a raw ioredis provider for everything the cache abstraction cannot express.
status: current
updated: 2026-09-11
---

Redis shows up in a Nest application in two distinct roles, and conflating them causes most of the trouble. As a **cache** it belongs behind `@nestjs/cache-manager`, which gives you a store-agnostic interface and lets tests run against memory. As a **data structure server** — locks, rate-limit counters, streams, pub/sub, sorted sets — it needs the real client, and that means a custom provider. This page wires up both. The command-level material is in [Redis](../databases/redis.md).

## Two stacks, one process

| | `@nestjs/cache-manager` 12.0.0 | a raw `ioredis` 6.0.0 provider |
| --- | --- | --- |
| Interface | `get` / `set` / `del` / `wrap` / `mget` | every Redis command |
| Underlying client | `@keyv/redis` 5.1.6, which uses `@redis/client` | `ioredis` |
| Swap to memory in tests | one line | no |
| Locks, `INCR`, streams, pub/sub, Lua | no | yes |
| TTL unit | **milliseconds** | seconds (`EX`) or milliseconds (`PX`) |

Running both in one process is normal and correct — they are different jobs. It does mean two connections; size for that.

## The cache stack

```bash
npm install @nestjs/cache-manager@12.0.0 cache-manager@7.2.9 @keyv/redis@5.1.6 keyv
```

`cache-manager` 7 is built on Keyv: a "store" is a `Keyv` instance, and `@keyv/redis` is the Redis adapter. `@nestjs/cache-manager` 12 declares `cache-manager >= 6` and `keyv >= 5` as peer dependencies, so both are installed explicitly.

```ts title="src/cache/cache.module.ts"
import { Module } from '@nestjs/common'
import { CacheModule } from '@nestjs/cache-manager'
import { ConfigModule, ConfigService } from '@nestjs/config'
import { createKeyv } from '@keyv/redis'
import { Keyv } from 'keyv'

@Module({
  imports: [
    CacheModule.registerAsync({
      isGlobal: true,
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        stores: [createKeyv(config.getOrThrow<string>('REDIS_URL'), { namespace: 'api' })],
        // cache-manager 7 measures every TTL in MILLISECONDS.
        ttl: 60_000,
        // Refresh in the background when less than 10s of TTL remains, so a
        // popular key is never recomputed by a request that had to wait.
        refreshThreshold: 10_000,
        nonBlocking: true,
      }),
    }),
  ],
})
export class AppCacheModule {}
```

Four details that are easy to get wrong:

- **TTLs are milliseconds.** `ttl: 60` is sixty *milliseconds*, which looks exactly like a cache that does not work. This changed in cache-manager 6; examples written for 5 use seconds.
- **`stores` is an array** and it is tiered: a `[new Keyv(), createKeyv(url)]` pair gives you an in-process L1 in front of Redis. Useful, but be certain you can tolerate a stale L1 on the replicas that did not see the invalidation.
- **`namespace`** prefixes every key. Set it per service, so two applications sharing a Redis cannot collide and `SCAN`-based cleanup is scoped.
- **`isGlobal: true`** is justified here for the same reason it is for config: the cache is a cross-cutting concern, and threading an import through every feature module buys nothing.

### Using it

Inject either the `Cache` class token or `CACHE_MANAGER`. They resolve to the same instance; the class token avoids an `@Inject()`.

```ts title="src/products/products.service.ts"
import { Injectable } from '@nestjs/common'
import { Cache } from '@nestjs/cache-manager'
import { ProductsRepository } from './products.repository.js'

@Injectable()
export class ProductsService {
  private readonly cache: Cache
  private readonly repo: ProductsRepository

  constructor(cache: Cache, repo: ProductsRepository) {
    this.cache = cache
    this.repo = repo
  }

  // wrap() is cache-aside in one call: read, and on a miss run the function,
  // store the result and return it. Concurrent callers share one execution.
  getById(id: number) {
    return this.cache.wrap(`product:${id}`, () => this.repo.findById(id), 5 * 60_000)
  }

  async update(id: number, patch: Partial<{ name: string; priceCents: number }>) {
    const updated = await this.repo.update(id, patch)
    // Invalidate AFTER the write commits, never before.
    await this.cache.del(`product:${id}`)
    return updated
  }
}
```

`wrap` is the whole cache-aside pattern, including single-flighting: several concurrent requests for a cold key run the loader once rather than all stampeding the database. Writing that by hand with `get` / `set` and getting the race right is more code than it looks.

The cache interface from `cache-manager` 7 is small and worth knowing in full: `get`, `mget`, `set`, `mset`, `del`, `mdel`, `clear`, `ttl`, `wrap`, `on` / `off`, `disconnect`.

### The CacheInterceptor, and when not to use it

```ts title="src/products/products.controller.ts"
import { CacheInterceptor, CacheKey, CacheTTL } from '@nestjs/cache-manager'
import { Controller, Get, UseInterceptors } from '@nestjs/common'
import { ProductsService } from './products.service.js'

@Controller('products')
export class ProductsController {
  private readonly products: ProductsService

  constructor(products: ProductsService) {
    this.products = products
  }

  @Get('featured')
  @UseInterceptors(CacheInterceptor)
  @CacheKey('products:featured')
  @CacheTTL(30_000)
  featured() {
    return this.products.listFeatured()
  }
}
```

`CacheInterceptor` caches `GET` responses keyed by the request URL by default.

:::danger Do not register CacheInterceptor globally on an authenticated API
The default key is the request URL. It does not include the user. Register it with `APP_INTERCEPTOR` across an API where responses differ per caller and `GET /me` is cached from the first request and served to everybody else — one user's profile, one tenant's invoices, one customer's order list, handed to the next caller with a 200.

Use it only on genuinely public, identical-for-everyone routes, and put it on those handlers explicitly. Anywhere the response depends on who is asking, use `cache.wrap()` with the subject in the key:

```ts
this.cache.wrap(`orders:${user.tenantId}:${user.id}:page:${page}`, () => this.repo.list(user, page), 30_000)
```
:::

Subclass `CacheInterceptor` and override `trackBy(context)` if you want per-user caching from the interceptor — that method exists precisely so the key can include the authenticated subject.

## A raw ioredis provider

Locks, counters, streams and pub/sub need commands the cache interface does not expose. That is a custom provider — the same token / `useFactory` / `inject` shape as the `pg` pool in [Connections and DI](connections-and-di.md).

```bash
npm install ioredis@6.0.0
```

```ts title="src/redis/redis.tokens.ts"
export const REDIS = Symbol('REDIS')
```

```ts title="src/redis/redis.module.ts"
import { Global, Module } from '@nestjs/common'
import { ConfigModule, ConfigService } from '@nestjs/config'
import Redis from 'ioredis'
import { REDIS } from './redis.tokens.js'
import { RedisService } from './redis.service.js'

@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: REDIS,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new Redis(config.getOrThrow<string>('REDIS_URL'), {
          connectTimeout: 5_000,
          maxRetriesPerRequest: 2,
          // Fail fast while disconnected instead of queueing commands that
          // resolve thirty seconds later — a cache wants a miss, not a wait.
          enableOfflineQueue: false,
          retryStrategy: (times) => Math.min(times * 200, 5_000),
          lazyConnect: false,
        }),
    },
    RedisService,
  ],
  exports: [RedisService],
})
export class RedisModule {}
```

```ts title="src/redis/redis.service.ts"
import { Inject, Injectable, Logger, OnApplicationShutdown } from '@nestjs/common'
import type Redis from 'ioredis'
import { REDIS } from './redis.tokens.js'

@Injectable()
export class RedisService implements OnApplicationShutdown {
  private readonly logger = new Logger(RedisService.name)
  private readonly client: Redis

  constructor(@Inject(REDIS) client: Redis) {
    this.client = client
    // Without an 'error' listener this is an unhandled 'error' event on an
    // EventEmitter, which terminates the process.
    this.client.on('error', (err: Error) => this.logger.error(`redis: ${err.message}`))
  }

  get raw(): Redis {
    return this.client
  }

  /** Increment a counter with a TTL on first write. One round trip. */
  async bump(key: string, windowMs: number) {
    const [[, count]] = (await this.client
      .multi()
      .incr(key)
      .pexpire(key, windowMs, 'NX')
      .exec()) as [[Error | null, number], unknown]
    return count
  }

  async onApplicationShutdown() {
    // quit() finishes in-flight commands; disconnect() severs immediately.
    await this.client.quit()
  }
}
```

:::warning BullMQ needs its own client
BullMQ requires `maxRetriesPerRequest: null`, because a blocking worker command has to survive a reconnect. Sharing the cache client with BullMQ means one of the two is misconfigured. Give BullMQ a separate provider with its own options — [Background jobs with BullMQ](../nestjs-libraries/bullmq.md).
:::

Pub/sub also needs its own connection: a client in subscriber mode can only issue subscribe-family commands, so a subscribing client cannot serve `GET` as well.

## Redis is not durable

This is the assumption that turns a cache into an outage.

- **The default configuration can lose data.** RDB snapshots are periodic, and `appendfsync everysec` still has a one-second window. A managed provider's failover can drop the last writes.
- **`maxmemory-policy allkeys-lru` evicts your keys while they are still valid.** That is the correct policy *for a cache* and catastrophic for anything you expected to still be there.
- **A restart may come back empty.**

So: **the application must work with Redis down**, slower but correct. In practice that means every cache call is wrapped, and a cache error is treated as a miss.

```ts title="src/cache/safe-cache.service.ts"
import { Injectable, Logger } from '@nestjs/common'
import { Cache } from '@nestjs/cache-manager'

@Injectable()
export class SafeCacheService {
  private readonly logger = new Logger(SafeCacheService.name)
  private readonly cache: Cache

  constructor(cache: Cache) {
    this.cache = cache
  }

  async wrap<T>(key: string, load: () => Promise<T>, ttlMs: number): Promise<T> {
    try {
      return await this.cache.wrap(key, load, ttlMs)
    } catch (err) {
      this.logger.warn(`cache unavailable for ${key}: ${(err as Error).message}`)
      // Degrade to the source of truth. Slower, still correct.
      return load()
    }
  }
}
```

A cache read that throws and propagates turns a Redis blip into a full outage. A cache read that falls through turns it into elevated database load, which is survivable and visible.

The exception is Redis used as a **rate-limit store or a lock**. Failing open there is a security decision, not a resilience one: if the counter store is down, you have no rate limit. Decide deliberately, and say which way in the code — [Rate limiting and abuse](../nestjs-security/rate-limiting.md).

Anything that must survive a restart is not a cache. Sessions, job state, outbox rows and idempotency keys belong in the database, optionally with Redis in front.

## Security considerations

**The cache key must contain every input the response depends on.** Tenant id, user id, role, locale, currency, feature flags. A key that omits the subject is a cross-user data leak with a 200 status code, and it is invisible in logs because nothing errored.

**Never cache an authorization decision without the subject in the key.** `can:delete:order:42` cached from an administrator's request answers `true` for the next caller. Include the principal, or do not cache it.

**Do not put secrets, tokens or full credit-card records in Redis.** It is often unencrypted at rest, frequently accessible to more services than your database, and eviction leaves no audit trail.

**Redis has no per-key access control.** Anything that can reach the port and authenticate reads everything. Bind to a private network, require `AUTH` (or ACL users), and enable TLS — `rediss://` in the URL for a managed instance.

**Disable or rename dangerous commands** where the provider allows it: `FLUSHALL`, `CONFIG`, `KEYS`, `DEBUG`. An injection or an SSRF that reaches Redis is far less useful without them.

**Never interpolate untrusted input into a Lua script.** `EVAL` with a script built by concatenation is injection with a different syntax. Pass values as `ARGV`, keys as `KEYS`, and keep the script text constant — `defineCommand` in `ioredis` makes that the natural shape.

**Cache poisoning follows from a weak key.** If any part of the key comes from a header the client controls (`Host`, `X-Forwarded-Host`, `Accept-Language`), an attacker can write to a key another user will read. Derive keys from validated, server-side values.

**`SCAN`, never `KEYS`.** `KEYS *` blocks the server for the duration on a large keyspace, which is a one-command denial of service — including when you run it yourself during an incident.

## Production considerations

- **TTLs are milliseconds** in `cache-manager` 7. Check every number you copied from an older example.
- **Every key gets a TTL.** A cache without expiry is a memory leak that ends in eviction of the keys you did want.
- **Set `maxmemory` and `maxmemory-policy`.** Without a policy Redis returns errors on write when it fills, instead of evicting.
- **`enableOfflineQueue: false` for cache and rate-limit clients.** Queued commands that resolve after a reconnect are worse than an immediate miss.
- **Bound `maxRetriesPerRequest`** so a request cannot hang across a long reconnect — except on BullMQ's client, which needs `null`.
- **An `'error'` listener on every client.** An unhandled `'error'` event terminates the process.
- **`quit()` in a shutdown hook**, with `app.enableShutdownHooks()` enabled, so in-flight commands finish.
- **Count two connections per process** (cache plus raw), more with BullMQ and pub/sub. Multiply by replicas before comparing against the provider's connection limit.
- **Report Redis as *degraded*, not *down*, in readiness.** Failing readiness because the cache is unavailable takes the whole fleet out of rotation over a performance problem. [Health checks](health-checks.md).
- **Instrument hit rate and loader latency.** A cache whose hit rate quietly fell to 5% is a database incident that has not happened yet.
- **Invalidate after the write commits.** Deleting the key before the transaction commits lets a concurrent read repopulate it with the old value.
- **Namespace keys per service and per schema version.** A deploy that changes a cached shape should not read the previous shape back.

## Common mistakes

- **`ttl: 60` meaning sixty milliseconds.** The unit changed; entries expire before anything can read them.
- **`CacheInterceptor` registered globally on an authenticated API.** One user's response served to everyone.
- **A cache key without the tenant or user.** The same leak, written by hand.
- **Letting a cache error propagate.** A Redis blip becomes a full outage instead of extra database load.
- **Sharing one client between the cache and BullMQ.** The two need incompatible `maxRetriesPerRequest` settings.
- **Using the subscribing client for normal commands.** A client in subscriber mode accepts only subscribe-family commands.
- **No `'error'` listener.** The process exits on the first connection blip.
- **Storing sessions or job state in a cache with an LRU eviction policy.** They are evicted while still needed.
- **`KEYS` in application code.** It blocks the server; use `SCAN`.
- **Invalidating before the write commits.** A concurrent read repopulates the stale value.
- **No TTL on a key written in a loop.** Unbounded growth until eviction starts throwing away the useful keys.
- **Interpolating input into a Lua script.** Injection, one abstraction layer over.

## Related topics

- [Redis](../databases/redis.md) — the commands: `SET … EX … NX`, `SCAN`, pub/sub, stampede protection and durability settings.
- [Caching](../nestjs-libraries/cache-manager.md) — `@nestjs/cache-manager` in depth, including interceptor customisation.
- [Connections and DI](connections-and-di.md) — the custom-provider pattern the `ioredis` client uses.
- [Connection pooling](connection-pooling.md) — counting Redis connections alongside database connections per process.
- [Health checks](health-checks.md) — a custom Terminus indicator for Redis, and reporting degraded rather than down.
- [Background jobs with BullMQ](../nestjs-libraries/bullmq.md) — why BullMQ needs its own client and its own options.
- [Rate limiting and abuse](../nestjs-security/rate-limiting.md) — Redis as a counter store, and failing open versus closed.
- [Retries and timeouts](retries-and-timeouts.md) — bounding a cache call so it cannot become the slow path.
- [Interceptors](../nestjs-request-handling/interceptors.md) — how `CacheInterceptor` fits the request lifecycle.
- [Observability](../nestjs-production/observability.md) — hit rate, loader latency and the metrics that make a cache debuggable.
