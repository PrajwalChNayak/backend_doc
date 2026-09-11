---
title: Caching
description: "@nestjs/cache-manager 12.0.0 with cache-manager 7.2.9 and @keyv/redis 5.1.6: CacheModule.registerAsync, the CACHE_MANAGER token, cache-aside with wrap, and why a global CacheInterceptor leaks data between users."
status: current
updated: 2026-09-11
---

`@nestjs/cache-manager` is **12.0.0**. It is a thin Nest module over `cache-manager` **7.2.9**, which is itself built on Keyv — so a store is any Keyv adapter, and Redis is `@keyv/redis` **5.1.6**. The module gives you an injectable cache and an optional response-caching interceptor, and one of those two is a data-leak waiting to happen.

## Why it exists

A cache trades staleness for latency and load. That is the whole deal, and it is only worth making when you can say what the staleness costs you.

What `@nestjs/cache-manager` adds over calling Redis directly is a store-agnostic interface: the same `get`/`set`/`wrap` calls work against an in-memory map in a unit test and a shared Redis in production, with the store chosen in one factory. If you need Redis-specific operations — sorted sets, pub/sub, Lua — inject the client directly instead. See [Redis](../nestjs-databases/redis.md).

## Installing

```bash
npm install @nestjs/cache-manager@12.0.0 cache-manager@7.2.9 keyv @keyv/redis@5.1.6
# only if you want the in-process L1 shown below
npm install cacheable
```

`@nestjs/cache-manager` 12.0.0 peers on `cache-manager >=6`, `keyv >=5`, `rxjs ^7.8.1` and `@nestjs/common`/`@nestjs/core` 9 through 12. Version 7 of `cache-manager` is the Keyv-based line; examples written for `cache-manager` 5 and its singular `store:` option do not apply — the option is `stores`, and each entry is a Keyv instance.

## Registering the module

```ts title="src/app.module.ts"
import { Module } from '@nestjs/common'
import { ConfigModule, ConfigService } from '@nestjs/config'
import { CacheModule } from '@nestjs/cache-manager'
import { createKeyv } from '@keyv/redis'
import { Keyv } from 'keyv'
import { CacheableMemory } from 'cacheable'

@Module({
  imports: [
    CacheModule.registerAsync({
      isGlobal: true,
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        stores: [
          // L1: in-process, tiny, very fast.
          new Keyv({ store: new CacheableMemory({ ttl: 5_000, lruSize: 1_000 }) }),
          // L2: shared across every replica.
          createKeyv(config.getOrThrow<string>('REDIS_URL')),
        ],
        ttl: 30_000,
        namespace: config.get<string>('CACHE_NAMESPACE', 'app'),
      }),
    }),
  ],
})
export class AppModule {}
```

| Option | Notes |
| --- | --- |
| `stores` | one Keyv instance or an ordered list; earlier stores are checked first |
| `ttl` | **milliseconds**, the default for entries that do not specify one |
| `namespace` | key prefix, default `keyv` |
| `refreshThreshold` | refresh asynchronously when the remaining TTL drops below this |
| `nonBlocking` | do not wait on every store when writing to several |
| `isGlobal` | register the module globally |

**`ttl` is in milliseconds.** `ttl: 60` is a sixty-millisecond cache, which behaves exactly like no cache at all while looking like a working one.

A two-store setup is the common production shape: an in-process L1 absorbs the hot keys without a network hop, and the shared L2 gives every replica the same view. The cost is that an L1 entry cannot be invalidated from another process — so keep the L1 TTL short enough that the staleness window is acceptable, and never put anything user-specific in it.

`namespace` matters for the same reason `prefix` matters on a queue: two environments sharing one Redis without distinct namespaces is one environment reading the other's data.

## Injecting the cache

```ts title="src/catalog/catalog.service.ts"
import { Inject, Injectable } from '@nestjs/common'
import { CACHE_MANAGER } from '@nestjs/cache-manager'
import type { Cache } from '@nestjs/cache-manager'
import { CatalogRepository } from './catalog.repository.js'
import type { Product } from './product.js'

@Injectable()
export class CatalogService {
  private readonly cache: Cache
  private readonly repo: CatalogRepository

  constructor(@Inject(CACHE_MANAGER) cache: Cache, repo: CatalogRepository) {
    this.cache = cache
    this.repo = repo
  }

  async findProduct(sku: string): Promise<Product | undefined> {
    return this.cache.wrap(
      `product:${sku}`,
      () => this.repo.findBySku(sku),
      60_000,
    )
  }

  async updateProduct(sku: string, patch: Partial<Product>): Promise<Product> {
    const updated = await this.repo.update(sku, patch)
    await this.cache.del(`product:${sku}`)
    return updated
  }
}
```

`CACHE_MANAGER` is the injection token; `Cache` is the type, re-exported from `@nestjs/cache-manager` so you do not import `cache-manager` for it.

| Method | Notes |
| --- | --- |
| `get<T>(key)` | `undefined` on a miss |
| `set<T>(key, value, ttl?)` | `ttl` in milliseconds |
| `del(key)` / `mdel(keys)` | delete |
| `mget<T>(keys)` / `mset(list)` | batched |
| `ttl(key)` | remaining lifetime |
| `wrap(key, fn, ttl?, refreshThreshold?)` | cache-aside in one call |
| `clear()` | wipe — see the warning below |

### Cache-aside, and why `wrap` is better than doing it by hand

The pattern is: check the cache, and on a miss compute the value, store it, and return it. `wrap` does exactly that, and it also collapses concurrent misses for the same key into a single execution of `fn`.

That last part is the reason to use it. The hand-written version:

```ts vulnerable title="DO NOT COPY — a cache stampede in six lines"
async findProduct(sku: string) {
  const hit = await this.cache.get<Product>(`product:${sku}`)
  if (hit) return hit
  const product = await this.repo.findBySku(sku)   // 500 concurrent requests, 500 queries
  await this.cache.set(`product:${sku}`, product, 60_000)
  return product
}
```

When a hot key expires under load, every in-flight request misses simultaneously and every one of them hits the database. That is a cache stampede, and it is how a cache turns into an outage: the database was fine while the cache was warm, and the traffic that arrives the instant it goes cold is the traffic the database was never sized for.

`refreshThreshold` addresses the same problem from the other side: when a read finds an entry whose remaining TTL is below the threshold, the value is refreshed in the background while the stale value is served immediately. The key never actually goes cold.

### Invalidation

There are two honest strategies and one that is not.

- **Expiry only.** Pick a TTL you can defend, accept the staleness, write no invalidation code. Correct for reference data, currency rates, feature flags.
- **Write-through invalidation.** Delete the key in the same code path that writes the row, as `updateProduct` does above. Correct when writes are few and go through one service.
- **Hoping.** Common, and it is how a cache ends up serving a price that changed six hours ago.

`clear()` wipes the entire namespace. In a multi-tenant or multi-service deployment sharing a Redis, that is a cache-wide cold start for everybody — a thundering herd on every backing store at once. Delete the keys you mean to delete.

## The `CacheInterceptor`

`CacheInterceptor` caches whole HTTP responses. It is one line to enable and it is the single most dangerous line in this package.

```ts title="src/catalog/catalog.controller.ts"
import { Controller, Get, UseInterceptors } from '@nestjs/common'
import { CacheInterceptor, CacheKey, CacheTTL } from '@nestjs/cache-manager'

@Controller('catalog')
export class CatalogController {
  // Public, identical for every caller, changes rarely. Safe to cache.
  @Get('categories')
  @UseInterceptors(CacheInterceptor)
  @CacheKey('catalog:categories')
  @CacheTTL(300_000)
  categories() {
    return this.catalog.listCategories()
  }
}
```

`@CacheKey` sets the key; `@CacheTTL` sets the lifetime in milliseconds, and both accept a factory taking the `ExecutionContext`. The interceptor only caches requests whose method is in its `allowedMethods` list, which is `['GET']` by default.

### Why a global `CacheInterceptor` is a cross-user data leak

Here is what the interceptor does when no `@CacheKey` is present, read from the shipped source: it calls `httpAdapter.getRequestUrl(request)` and uses **the request URL** as the cache key.

The URL. Not the user. Not the `Authorization` header. Not the tenant.

```ts vulnerable title="DO NOT COPY — src/app.module.ts"
@Module({
  providers: [{ provide: APP_INTERCEPTOR, useClass: CacheInterceptor }],
})
export class AppModule {}
```

With that registered and an authenticated `GET /me`:

```bash
# Alice, at 12:00:00
curl -H 'Authorization: Bearer alice-token' https://api.example.com/me
# => {"id":"alice","email":"alice@example.com","plan":"enterprise"}

# Bob, at 12:00:01 — different token, same URL, same cache key
curl -H 'Authorization: Bearer bob-token' https://api.example.com/me
# => {"id":"alice","email":"alice@example.com","plan":"enterprise"}
```

Bob receives Alice's record. Nothing errors, nothing is logged, and the two users see consistent-looking data — Bob just sees somebody else's. Every authenticated `GET` in the application has the same problem, including `/invoices`, `/settings` and `/api-keys`.

:::danger
**Never register `CacheInterceptor` globally in an application with authenticated routes.** The default key is the URL, so every user shares one cache entry per path.

Apply it per route, on responses that are genuinely identical for every caller. If you want it more broadly, subclass it and make identity part of the key — and treat that subclass as security-critical code.
:::

```ts good title="src/common/cache/user-scoped-cache.interceptor.ts"
import { Injectable } from '@nestjs/common'
import type { ExecutionContext } from '@nestjs/common'
import { CacheInterceptor } from '@nestjs/cache-manager'

@Injectable()
export class UserScopedCacheInterceptor extends CacheInterceptor {
  protected trackBy(context: ExecutionContext): string | undefined {
    const request = context.switchToHttp().getRequest()
    if (request.method !== 'GET') return undefined

    // No identity resolved yet? Do not cache. Never fall back to the bare URL.
    const userId: string | undefined = request.user?.id
    if (!userId) return undefined

    return `u:${userId}:${request.originalUrl}`
  }
}
```

Returning `undefined` from `trackBy` disables caching for that request, which is the correct fail-safe: a request whose identity you cannot establish is a request you must not serve from, or write to, a shared entry.

Even with this, think before you apply it broadly. Per-user response caching multiplies your key space by your user count, and it caches the authorization decision along with the data — so a permission revoked at 12:00 keeps working until the entry expires.

**The safer default is to cache at the service layer**, where the key is built from the arguments you can see and nothing is implicit.

## Security considerations

**The default cache key is the URL.** Anything user-specific, tenant-specific or permission-dependent must not be cached under it. This is the whole reason the previous section exists.

**A cache entry caches the authorization outcome too.** A response that was allowed when it was computed is served later without re-checking anything. Keep TTLs short on anything permission-dependent, and invalidate on permission changes.

**Query strings are part of the URL and therefore part of the key.** A URL carrying a token or a reset code — which it should not, but does — puts that secret into a shared store, and into any log line that prints a cache key.

**Do not cache anything with `Set-Cookie` or a per-request token in it.** Serving that response to a second user hands them the first user's session.

**A shared Redis without a `namespace` is a shared cache.** Two environments, or two services, reading and overwriting each other's entries.

**Cached data lives in Redis in plaintext.** Personal data in a cache is personal data in another system, with its own retention, access control and deletion obligations. If a record must be deleted on request, remember the cache holds a copy.

**A cache miss and a cache hit have different response times.** For an endpoint that answers "does this resource exist", that timing difference is an oracle. Rare, but real.

**`clear()` is a denial-of-service primitive** if it is reachable from a request handler. Do not expose it.

## Production considerations

**Cache at the service layer, not the HTTP layer**, unless the response really is identical for everyone. Service-layer keys are explicit, testable, and cannot accidentally include the caller's identity by omission.

**Use `wrap` rather than get-then-set.** Stampede protection is free and the code is shorter.

**Set `refreshThreshold` on hot keys.** The value is refreshed before it expires, so the cold-start spike never happens.

**Give the cache its own Redis, or at least its own database index.** A cache should be configured to evict under memory pressure (`allkeys-lru`); a queue and a rate limiter must not be. Sharing one instance with one eviction policy means one of them is configured wrong — see [Redis](../nestjs-databases/redis.md) and [Background jobs with BullMQ](bullmq.md).

**Decide what happens when the cache is unreachable.** The correct default is to serve from the origin and log — a cache outage should be slow, not fatal. `wrap` propagates a store error, so wrap the wrap if you need to degrade rather than fail.

**Measure the hit rate.** A cache below about 80% hits is often adding latency and complexity for very little, and a cache at 99% may be hiding a query you should have fixed. Both are worth knowing.

**Size the L1.** `CacheableMemory` with an `lruSize` is bounded; an unbounded in-process map is a memory leak with a nice API.

**Key names are an interface.** `product:{sku}`, `user:{id}:invoices` — pick a scheme, write it down, and version it (`v2:product:{sku}`) when the shape of the cached value changes. Deploying a new value shape under an old key means the new code reads the old shape from a warm cache.

**Warm the cache deliberately or not at all.** A startup warm-up that hammers the database while the instance is still failing readiness is worse than a cold start.

## Common mistakes

- **Registering `CacheInterceptor` globally with authenticated routes.** Cross-user data leak; nothing errors.
- **Treating `ttl` as seconds.** It is milliseconds, and `ttl: 60` looks like it works.
- **Get-then-set instead of `wrap`.** A stampede on every expiry of a hot key.
- **No invalidation on the write path.** Stale data for exactly as long as the TTL, every time.
- **`clear()` as invalidation.** A cache-wide cold start for every tenant on the box.
- **Caching a response that varies by user without putting the user in the key.** The default key is the URL.
- **Falling back to the URL in a custom `trackBy` when there is no user.** That is the leak you were fixing; return `undefined` instead.
- **Sharing one Redis between cache, queue and rate limiter with an eviction policy.** Your job queue quietly loses jobs.
- **No `namespace`.** Environments overwrite each other.
- **Caching personal data without thinking about deletion requests.** The cache is a second copy.
- **Following a `cache-manager` 5 example.** The `store:` option and the old redis store do not exist in 7.x; it is `stores` with Keyv adapters.
- **An unbounded in-memory store.** A memory leak that looks like a cache.
- **Not versioning the key when the cached shape changes.** New code reads an old shape from a warm cache and fails in production only.

## Related topics

- [Redis](../nestjs-databases/redis.md) — running the store, eviction policy, and when to inject the client directly.
- [Interceptors](../nestjs-request-handling/interceptors.md) — the pipeline stage `CacheInterceptor` occupies.
- [Authorization](authorization.md) — the decision a cached response freezes in place.
- [Authentication](authentication.md) — the per-request user lookup this can cache, carefully.
- [Background jobs with BullMQ](bullmq.md) — the other Redis workload, with opposite persistence requirements.
- [Health checks with Terminus](terminus.md) — a custom indicator, since Terminus ships no Redis check.
- [Performance](../nestjs-production/performance.md) — measuring before and after, instead of caching by reflex.
- [Configuration](../nestjs/configuration.md) — supplying the Redis URL and the namespace.
- [N+1 queries](../databases/n-plus-one-queries.md) — the problem a cache is often used to hide rather than fix.
