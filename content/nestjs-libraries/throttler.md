---
title: Rate limiting with Throttler
description: "@nestjs/throttler 6.5.0: named throttler definitions, ThrottlerGuard as a global guard, @Throttle and @SkipThrottle, Redis storage for multiple replicas, and the getTracker proxy-trust bypass."
status: current
updated: 2026-09-11
---

`@nestjs/throttler` is **6.5.0**, published 2025-12-02. It is **not** on the 12.x line that the rest of the first-party packages share — `@nestjs/throttler@12` does not exist, and asking npm for it fails. The package implements rate limiting as a [guard](../nestjs-request-handling/guards.md), which is the cheap pipeline stage that can still read per-route metadata.

## Why it exists

An unlimited endpoint is a free credential-stuffing target, a free password-reset email cannon, and a free way to exhaust your database pool. Rate limiting is the control that makes each of those cost the attacker something.

`@nestjs/throttler` is worth having over a hand-rolled counter for three reasons: it composes several limits with different windows, it reads route metadata so a single global registration can be overridden per handler, and its storage is an interface, so the in-memory default can be swapped for Redis without touching a controller.

The threat model — what rates to pick, what to do about distributed attacks, and why a limiter is not a substitute for a slow hash — is in [Rate limiting and abuse](../nestjs-security/rate-limiting.md). This page is the package.

## Installing

:::tabs
@tab npm
```bash
npm install @nestjs/throttler@6.5.0
```
@tab pnpm
```bash
pnpm add @nestjs/throttler@6.5.0
```
@tab yarn
```bash
yarn add @nestjs/throttler@6.5.0
```
:::

Peers are `@nestjs/common`, `@nestjs/core` and `reflect-metadata`. Nest 12 satisfies them.

## Named throttler definitions

The module takes an array of throttler definitions, or an object with a `throttlers` array plus shared options. Each definition is `{ name, ttl, limit }`, and **`ttl` is in milliseconds** — the package exports `seconds()`, `minutes()`, `hours()`, `days()` and `weeks()` so you never have to count zeros.

```ts title="src/app.module.ts"
import { Module } from '@nestjs/common'
import { APP_GUARD } from '@nestjs/core'
import { ThrottlerGuard, ThrottlerModule, minutes, seconds } from '@nestjs/throttler'

@Module({
  imports: [
    ThrottlerModule.forRoot({
      throttlers: [
        { name: 'short', ttl: seconds(1), limit: 3 },
        { name: 'medium', ttl: seconds(10), limit: 20 },
        { name: 'long', ttl: minutes(1), limit: 100 },
      ],
      errorMessage: 'Too many requests. Slow down.',
    }),
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
```

Every named throttler is evaluated on every request, and **all of them must pass**. That is the point of having three: `short` catches a burst, `long` catches a grinder that stays under the burst limit, and neither can be tuned around without tripping the other.

A definition with no `name` is given the name `'default'`. The bare-array form — `ThrottlerModule.forRoot([{ ttl: seconds(60), limit: 10 }])` — is the one-limiter shorthand.

Per-definition options beyond the three basics:

| Option | Effect |
| --- | --- |
| `blockDuration` | how long to keep rejecting after the limit is hit; defaults to `ttl` |
| `skipIf` | `(context) => boolean` — bypass this throttler entirely for matching requests |
| `ignoreUserAgents` | array of `RegExp`; a matching `User-Agent` is not counted |
| `getTracker` | override who is being counted (see below) |
| `generateKey` | override the storage key |
| `setHeaders` | emit the `X-RateLimit-*` headers; defaults to `true` |

`limit` and `ttl` are `Resolvable` — either a number or `(context) => number | Promise<number>`. That is how you give authenticated users a higher ceiling than anonymous ones without writing a second guard.

### Configuring it from `ConfigService`

```ts title="src/app.module.ts"
import { Module } from '@nestjs/common'
import { ConfigModule, ConfigService } from '@nestjs/config'
import { ThrottlerModule, seconds } from '@nestjs/throttler'

@Module({
  imports: [
    ThrottlerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        throttlers: [
          {
            name: 'default',
            ttl: seconds(config.get<number>('THROTTLE_TTL_SECONDS', 60)),
            limit: config.get<number>('THROTTLE_LIMIT', 100),
          },
        ],
      }),
    }),
  ],
})
export class AppModule {}
```

## The guard

Registering `ThrottlerGuard` under `APP_GUARD` applies every named throttler to every route. That is the correct default: an endpoint you forgot about is exactly the one that gets abused.

The guard rejects with `ThrottlerException`, which extends `HttpException` with **429 Too Many Requests**. When `setHeaders` is on — the default — every response carries:

| Header | Meaning |
| --- | --- |
| `X-RateLimit-Limit` | the ceiling for this throttler |
| `X-RateLimit-Remaining` | how many requests are left in the window |
| `X-RateLimit-Reset` | milliseconds until the window rolls |
| `Retry-After` | set only on a rejection, while blocked |

For a throttler with a name other than `'default'`, the name is appended: `X-RateLimit-Limit-short`, `Retry-After-long`, and so on. Clients that read `X-RateLimit-Remaining` will not see it if your only throttler is named something else — either keep one throttler called `default` or document the suffixed names.

### Per-route overrides

```ts title="src/auth/auth.controller.ts"
import { Body, Controller, Get, Post } from '@nestjs/common'
import { SkipThrottle, Throttle, minutes } from '@nestjs/throttler'

@Controller('auth')
export class AuthController {
  // Five login attempts per fifteen minutes, and stay blocked for an hour
  // after that. The other named throttlers still apply.
  @Post('login')
  @Throttle({ default: { limit: 5, ttl: minutes(15), blockDuration: minutes(60) } })
  login(@Body() body: LoginDto) {
    return this.auth.login(body)
  }

  // Skip only the burst limiter; 'medium' and 'long' still count.
  @Get('session')
  @SkipThrottle({ short: true })
  session() {
    return this.auth.currentSession()
  }
}
```

Both decorators are keyed by throttler **name**, and both work on a class as well as a method. `@SkipThrottle()` with no argument skips the `'default'` throttler only — not all of them, which is a common misreading. To exempt a route from everything, name each one: `@SkipThrottle({ short: true, medium: true, long: true })`.

The guard reads these with `getAllAndOverride([handler, class])`, so a method-level decorator replaces a controller-level one.

:::best-practice
Do not lower the global limit to protect one expensive endpoint. Set a sane global ceiling and tighten the handful of routes that deserve it — login, refresh, password reset, MFA verification, signup, and anything that sends an email or an SMS. Those are the routes where an attacker's cost is your cost.
:::

### Keys are per-route by default

`generateKey` defaults to a SHA-256 of `ControllerName-handlerName-throttlerName-tracker`. The controller and handler names are in the key, which means **each route has its own counter**. A user who exhausts their budget on `GET /invoices` can still call `GET /reports`.

That is usually what you want. When it is not — a global per-IP budget across every endpoint — override it:

```ts title="src/common/throttler/global-key.guard.ts"
import { Injectable } from '@nestjs/common'
import type { ExecutionContext } from '@nestjs/common'
import { ThrottlerGuard } from '@nestjs/throttler'
import { createHash } from 'node:crypto'

@Injectable()
export class GlobalKeyThrottlerGuard extends ThrottlerGuard {
  protected generateKey(context: ExecutionContext, suffix: string, name: string): string {
    return createHash('sha256').update(`global-${name}-${suffix}`).digest('hex')
  }
}
```

## The `getTracker` trap

This is the failure that turns a rate limiter into a decoration, and it is worth writing out in full.

The default tracker is `req.ip`. Behind a load balancer, every request arrives from the load balancer, so `req.ip` is the same value for every client on earth — one shared bucket, and your legitimate traffic rate-limits itself.

The obvious fix is to read the forwarded header. The obvious fix is also the hole:

```ts vulnerable title="DO NOT COPY — src/common/throttler/ip.guard.ts"
@Injectable()
export class IpThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, any>): Promise<string> {
    // Attacker-controlled. A fresh value per request means an infinite budget.
    return req.headers['x-forwarded-for'] ?? req.ip
  }
}
```

`X-Forwarded-For` is a request header. Anyone can send it, and anyone can send a different one on every request:

```bash
for i in $(seq 1 10000); do
  curl -s -o /dev/null -X POST https://api.example.com/auth/login \
    -H "X-Forwarded-For: 10.0.$((i / 256)).$((i % 256))" \
    -d '{"email":"victim@example.com","password":"guess'"$i"'"}'
done
```

Ten thousand login attempts, ten thousand distinct buckets, zero 429s. The limiter reported success the whole time.

### The fix

**Never read the header yourself. Configure the trusted proxy count and read `req.ip`.** Express computes `req.ip` from `X-Forwarded-For` by walking back exactly as many hops as `trust proxy` says are yours, and everything the client injected is beyond that boundary.

```ts title="src/main.ts"
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module.js'

async function bootstrap() {
  const app = await NestFactory.create(AppModule)

  // The NUMBER of proxies between the internet and this process.
  // One ALB: 1. ALB behind CloudFront: 2. Directly exposed: do not set it.
  app.set('trust proxy', 1)

  await app.listen(3000)
}

bootstrap()
```

```ts good title="src/common/throttler/ip.guard.ts"
import { Injectable } from '@nestjs/common'
import type { ExecutionContext } from '@nestjs/common'
import { ThrottlerGuard } from '@nestjs/throttler'

@Injectable()
export class IpThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, any>): Promise<string> {
    // req.ip already honours `trust proxy`. Nothing here is client-settable.
    return req.ip
  }
}
```

:::danger `trust proxy: true` is the same bug
`app.set('trust proxy', true)` trusts the **entire** chain, which means it trusts whatever the client prepended. It is indistinguishable from reading the raw header. Set the integer hop count, and change it when your topology changes.

Verify it. Send `curl -H 'X-Forwarded-For: 1.2.3.4' https://api.example.com/whoami` from outside and confirm the server does not report `1.2.3.4`. If it does, every IP-based control you own is bypassable — the limiter, the deny-list, and the audit log.
:::

### Track the user, not the address

An IP is a poor identity: carrier NAT puts thousands of users behind one address, and an attacker with a botnet has thousands of addresses. For authenticated routes, track the principal:

```ts title="src/common/throttler/user.guard.ts"
import { Injectable } from '@nestjs/common'
import { ThrottlerGuard } from '@nestjs/throttler'

@Injectable()
export class UserThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, any>): Promise<string> {
    return req.user?.id ? `user:${req.user.id}` : `ip:${req.ip}`
  }
}
```

Order matters: this guard must run **after** the authentication guard, or `req.user` is always undefined and every request falls back to the IP branch. Multiple `APP_GUARD` providers run in declaration order.

For a login endpoint specifically, track the **submitted identifier as well as** the IP — otherwise an attacker rotating addresses still gets unlimited attempts against one account. Normalize it (lowercase, trim) so `Victim@Example.com` and `victim@example.com` share a bucket.

## Redis storage for multiple replicas

The default storage is `ThrottlerStorageService`, an in-process `Map`. With three replicas behind a load balancer, a limit of 100 becomes an effective limit of 300 — and the count resets on every deploy.

The storage layer is a one-method interface:

```ts
export interface ThrottlerStorage {
  increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord>
}
```

The maintained Redis implementation is `@nest-lab/throttler-storage-redis` **1.2.0**, from the same maintainer as the throttler itself. It peers on `@nestjs/throttler >=6.0.0` and `ioredis >=5.0.0`, so `ioredis` 6.0.0 works.

```bash
npm install @nest-lab/throttler-storage-redis@1.2.0 ioredis@6.0.0
```

```ts title="src/app.module.ts"
import { Module } from '@nestjs/common'
import { ConfigModule, ConfigService } from '@nestjs/config'
import { APP_GUARD } from '@nestjs/core'
import { ThrottlerGuard, ThrottlerModule, seconds, minutes } from '@nestjs/throttler'
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis'
import Redis from 'ioredis'

@Module({
  imports: [
    ThrottlerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        throttlers: [
          { name: 'short', ttl: seconds(1), limit: 3 },
          { name: 'long', ttl: minutes(1), limit: 100 },
        ],
        storage: new ThrottlerStorageRedisService(
          new Redis(config.getOrThrow<string>('REDIS_URL'), {
            maxRetriesPerRequest: 2,
            enableOfflineQueue: false,
          }),
        ),
      }),
    }),
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
```

`ThrottlerStorageRedisService` implements the increment as a Lua script, so the read-modify-write is atomic on the Redis side — two replicas incrementing the same key at the same millisecond cannot both see the old value.

:::warning Decide what happens when Redis is down
`enableOfflineQueue: false` makes `increment()` reject immediately instead of queueing. That turns a Redis outage into 500s on every request rather than a silent stall — which is a deliberate choice, not the only one.

The alternative is to catch the error in a `ThrottlerGuard` subclass and fail open, accepting that your limits do not exist while Redis is down. Fail open for a read-heavy public API; fail closed for anything an attacker would love unlimited access to. What you must not do is leave it undecided and find out during the incident.
:::

See [Redis](../nestjs-databases/redis.md) for connection lifecycle, and note that a rate-limit store and a cache are different workloads — do not let the cache's eviction policy quietly delete your counters.

## Security considerations

**A rate limiter keyed on a client-controlled value is not a rate limiter.** `X-Forwarded-For`, `X-Real-IP`, a custom `X-Client-Id`, an API key the client picked — all forgeable. Derive the tracker from something the infrastructure or your own authentication established.

**`trust proxy` must be the exact hop count.** `true` trusts the client's prepended entries; too low a number tracks your load balancer; too high tracks whatever the attacker sent.

**Limit login by identifier *and* by address.** By address alone, a botnet gets unlimited attempts. By identifier alone, an attacker spraying one password across many accounts is never slowed.

**Multiple replicas without shared storage means your limit is `limit × replicas`**, and it resets on deploy. That is the difference between a control and a comment.

**A limiter is not a defense against a slow endpoint.** If one request can pin a core for two seconds, a limit of 100/minute still lets a handful of clients take the service down. Fix the endpoint; see [Performance](../nestjs-production/performance.md).

**A limiter is not a substitute for a slow password hash.** Argon2 is what makes an offline attack on a stolen database expensive — see [Password hashing](../express-libraries/password-hashing.md).

**Do not leak whether an account exists through the limit.** Rejecting after three attempts for real accounts and never for unknown ones is a user-enumeration oracle. Count the attempt either way.

**Log 429s with the tracker and the route.** They are the earliest signal of credential stuffing, and they are cheap to alert on. Never log the submitted password. See [Safe logging](../nestjs-security/safe-logging.md).

**Rate limiting runs in a guard, which runs after middleware.** Anything expensive in middleware — body parsing of a large payload, for instance — happens *before* the limiter can reject. Cap body size at the platform level as well.

## Production considerations

**Use Redis storage the moment you run more than one instance**, which includes a single instance during a rolling deploy.

**Exempt the health endpoints.** A probe every second against a 3-per-second burst limit will eventually report your service as unhealthy. `skipIf` on the definition, or `@SkipThrottle` naming every throttler, on the probe routes — see [Health checks with Terminus](terminus.md).

**Publish the headers and document the names.** `X-RateLimit-Remaining` is what lets a well-behaved client back off before it is rejected. Remember the suffix rule for non-`default` names.

**`Retry-After` is emitted on rejection while blocked.** Clients that honour it stop hammering you; clients that do not are the ones the `blockDuration` is for.

**Pick `blockDuration` deliberately.** It defaults to `ttl`, which means the limit rolls off as fast as it accumulated. For login, a longer block — an hour after five failures — is the whole point.

**Watch for the limiter firing on legitimate traffic.** A corporate NAT or a mobile carrier can put hundreds of real users on one address. Track authenticated users by id, and keep a way to raise the ceiling for a known client without a deploy: a `Resolvable` `limit` that reads a config value does it.

**Rate limiting at the edge and in the application are complementary.** The edge stops volumetric attacks before they cost you a process; the application knows which route and which user, which the edge does not. Do both if you can.

**Watch Redis memory.** One key per tracker per throttler per route, each with a TTL. Normally small, but a per-route key times a wide tracker space times several named throttlers grows faster than people expect.

## Common mistakes

- **Writing `@nestjs/throttler@12`.** It does not exist; 6.5.0 is current.
- **Reading `X-Forwarded-For` inside `getTracker`.** An infinite budget, one header away.
- **`app.set('trust proxy', true)`.** Trusts the client's own entries. Use the hop count.
- **Not setting `trust proxy` behind a proxy at all.** Every client shares the load balancer's address, so real users limit each other while the limiter reports success.
- **Treating `ttl` as seconds.** It is milliseconds. `ttl: 60` is a sixty-millisecond window. Use `seconds(60)`.
- **`@SkipThrottle()` expecting it to skip everything.** It skips `'default'` only.
- **`@Throttle({ limit: 5, ttl: 60000 })`.** The argument is keyed by throttler name: `@Throttle({ default: { limit: 5, ttl: 60000 } })`.
- **In-memory storage with more than one replica.** The effective limit is multiplied by the replica count and resets on deploy.
- **Registering the throttler guard before the authentication guard** while tracking `req.user.id`. It is always undefined, so everything falls back to the IP.
- **No exemption for health probes.** The orchestrator's own traffic trips the limiter.
- **Limiting login by IP only.** Password spraying across accounts is unaffected.
- **Leaving the Redis-outage behaviour undecided.** You will discover it during the outage.
- **Assuming a global limit protects one expensive route.** It does not; tighten that route.

## Related topics

- [Rate limiting and abuse](../nestjs-security/rate-limiting.md) — the threat model, choosing rates, and the attacks this control does and does not stop.
- [Guards](../nestjs-request-handling/guards.md) — why rate limiting is a guard, and how guard ordering works.
- [Authentication](authentication.md) — the login and refresh endpoints that need the tightest limits.
- [Redis](../nestjs-databases/redis.md) — operating the shared counter store.
- [Health checks with Terminus](terminus.md) — the probe routes to exempt.
- [Configuration](../nestjs/configuration.md) — supplying limits and the Redis URL from validated config.
- [Safe logging](../nestjs-security/safe-logging.md) — recording 429s without recording credentials.
- [Performance](../nestjs-production/performance.md) — why a slow endpoint outruns any limiter.
- [Rate limiting](../express-libraries/rate-limiting.md) — the Express equivalent, with `express-rate-limit`.
