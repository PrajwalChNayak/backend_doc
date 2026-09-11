---
title: Rate limiting and abuse
description: @nestjs/throttler 6.5.0 inside Nest 12 — named throttlers, the trust-proxy trap that makes the limiter useless or bypassable, keying by subject, shared storage, and verification with curl.
status: current
updated: 2026-09-11
---

A rate limiter is not a performance feature. It is the control that turns "an attacker can try every password" into "an attacker can try six", and "one request costs you forty seconds of database time" into "one request per minute costs you forty seconds of database time". Nest ships a first-party implementation as a guard, which is the correct shape — and the two ways it most often fails are a proxy setting and a storage default, neither of which produces an error.

What you are defending against, the IPv6 keying problem, body-size limits, pagination caps and regex backtracking are all on [Rate limiting and abuse](../security/rate-limiting-and-abuse.md). This page is the Nest-specific configuration and its traps.

## Version, first

**`@nestjs/throttler` is `6.5.0`** (published 2025-12-02). It is not on the 12.x line — the core `@nestjs/*` packages are 12.0.1 and the throttler is versioned independently. Installing `@nestjs/throttler@12` gets you a version that does not exist.

:::warning Its peer range has not caught up
`@nestjs/throttler@6.5.0` declares its peers as `@nestjs/common` and `@nestjs/core` `^7.0.0 || ^8.0.0 || ^9.0.0 || ^10.0.0 || ^11.0.0` — read from the published `package.json`. There is no `^12.0.0` in that list yet, so npm's strict peer resolution will object when you install it alongside Nest 12. The package works; the metadata is behind. Install it and record the reason, rather than downgrading Nest or silently adding `--legacy-peer-deps` to every command in your pipeline.
:::

```bash
npm install @nestjs/throttler@6.5.0
```

## The threat

Three separate abuses, one missing control:

- **Credential stuffing.** Twenty thousand password attempts against one account, or one password against twenty thousand accounts, at whatever rate your server answers.
- **Resource exhaustion.** An endpoint that costs a hundred milliseconds of CPU, called a thousand times a second by one client.
- **Business-flow abuse.** Signups farming trial credits, coupon redemptions, invite spam. No individual request is malformed; the volume is the attack.

## A concrete exploit

```bash
for password in $(head -20000 rockyou.txt); do
  curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:3000/auth/login \
    -H 'content-type: application/json' \
    -d "{\"email\":\"victim@example.com\",\"password\":\"$password\"}"
done | sort | uniq -c
```

```text
  19999 401
      1 200
```

Ten minutes, one IP, no slowdown, and nothing in the logs distinguishes it from a user with a bad memory except the count — which nobody is counting.

## The fix in code

Register the module, then bind `ThrottlerGuard` globally with `APP_GUARD` so a new controller is covered the day it is written rather than the day somebody remembers.

```ts good title="src/app.module.ts"
import { Module } from '@nestjs/common'
import { APP_GUARD } from '@nestjs/core'
import { ThrottlerGuard, ThrottlerModule, minutes, seconds } from '@nestjs/throttler'

@Module({
  imports: [
    ThrottlerModule.forRoot({
      throttlers: [
        // Named throttlers all apply; a request must satisfy every one of them.
        { name: 'short', ttl: seconds(1), limit: 5 },
        { name: 'medium', ttl: seconds(10), limit: 30 },
        { name: 'long', ttl: minutes(1), limit: 120 },
      ],
      errorMessage: 'Too many requests. Slow down.',
    }),
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
```

:::warning `ttl` is milliseconds
`{ ttl: 60, limit: 10 }` is ten requests per **sixty milliseconds**, not per minute — an effectively unlimited endpoint that looks configured. The `seconds()`, `minutes()`, `hours()`, `days()` and `weeks()` helpers exported from the package exist for exactly this mistake; they simply multiply, and using them makes the unit visible at the call site.
:::

Two behaviors of the guard worth knowing before you tune the numbers, both read from the shipped source:

- **The key includes the controller and handler names.** `generateKey()` hashes `${ClassName}-${handlerName}-${throttlerName}-${tracker}`, so the limit is **per route**, not per application. A limit of 120/minute means 120 per minute *to each endpoint*, and an attacker spreading across twenty endpoints gets 2400.
- **`blockDuration` defaults to `ttl`.** Exceeding the limit blocks the key for the same window. Set it higher on authentication routes to make a burst expensive: `{ name: 'login', ttl: minutes(1), limit: 5, blockDuration: minutes(15) }`.

### Per-route limits

`@Throttle()` takes a record keyed by throttler name, so you can tighten one window and leave the others.

```ts good title="src/auth/auth.controller.ts"
import { Body, Controller, Post } from '@nestjs/common'
import { Throttle, minutes } from '@nestjs/throttler'
import { LoginDto } from './dto/login.dto.js'
import { RequestResetDto } from './dto/request-reset.dto.js'

@Controller('auth')
export class AuthController {
  // Five attempts a minute, then a fifteen-minute block on that key.
  @Throttle({ long: { limit: 5, ttl: minutes(1), blockDuration: minutes(15) } })
  @Post('login')
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto)
  }

  // Password reset sends email. Three per hour is generous.
  @Throttle({ long: { limit: 3, ttl: minutes(60), blockDuration: minutes(60) } })
  @Post('reset')
  requestReset(@Body() dto: RequestResetDto) {
    return this.auth.requestReset(dto)
  }
}
```

```ts good title="src/health/health.controller.ts"
import { Controller, Get } from '@nestjs/common'
import { SkipThrottle } from '@nestjs/throttler'

@SkipThrottle()
@Controller('health')
export class HealthController {
  @Get()
  check() {
    return { status: 'ok' }
  }
}
```

`@SkipThrottle()` with no argument skips every named throttler; `@SkipThrottle({ short: true })` skips one. Use it for liveness and readiness probes, which your orchestrator calls from a fixed address at a fixed rate and which must never be throttled.

## The proxy-trust trap

This is the part that decides whether any of the above works, and it fails in two opposite directions.

The guard's default tracker is one line: `getTracker(req) { return req.ip }`. Everything depends on `req.ip` being the client.

**Direction one — one bucket for the whole internet.** Behind a load balancer, an ingress controller or a CDN, every request arrives from the proxy's address. Express reports that address in `req.ip` unless you tell it otherwise, so the limiter counts every user of your application into a single counter. Symptom: legitimate users get 429s at random, someone raises the limit to make it stop, and the control is now decorative.

**Direction two — a free bypass.** The fix people apply is `trust proxy: true`, which tells Express to believe the entire `X-Forwarded-For` chain. That header is attacker-controlled:

:::danger Unbounded trust in `X-Forwarded-For`
```ts vulnerable title="DO NOT COPY — src/main.ts"
const app = await NestFactory.create<NestExpressApplication>(AppModule)
// "Trust every proxy" means "trust the client, who is claiming to be a proxy".
app.getHttpAdapter().getInstance().set('trust proxy', true)
```

```bash
# A new identity per request. The limiter counts each one separately.
for i in $(seq 1 20000); do
  curl -s -o /dev/null -X POST localhost:3000/auth/login \
    -H "X-Forwarded-For: 10.0.$((i / 256)).$((i % 256))" \
    -H 'content-type: application/json' \
    -d '{"email":"victim@example.com","password":"guess"}'
done
```

Twenty thousand attempts, zero 429s.
:::

The correct setting is the **number of proxies between the client and your process**, so Express takes the address that many hops from the right of the chain and ignores anything the client prepended:

```ts good title="src/main.ts"
import { NestFactory } from '@nestjs/core'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { AppModule } from './app.module.js'

const app = await NestFactory.create<NestExpressApplication>(AppModule)

// Exactly one proxy (an ingress, or a single ALB) sits in front of this process.
// Two proxies -> 2. A CIDR or list of proxy addresses is also accepted.
app.set('trust proxy', 1)

await app.listen(3000)
```

`NestExpressApplication` is what gives you `app.set()`; without the type parameter the method is not on the interface and you have to go through `app.getHttpAdapter().getInstance()`.

| `trust proxy` | `req.ip` behind one proxy | Spoofable? |
| --- | --- | --- |
| `false` (default) | the **proxy's** address — one bucket for everyone | no, but the limiter is useless |
| `true` | the leftmost `X-Forwarded-For` entry | **yes — trivially** |
| `1` | one hop from the right of the chain | no |
| `'loopback'` / a CIDR / a list | only entries from those addresses | no |

Count your hops and verify the number rather than reasoning about your architecture diagram:

```bash
curl -s localhost:3000/debug/whoami -H 'X-Forwarded-For: 1.2.3.4'
```

```json
{ "ip": "203.0.113.7", "forwardedFor": "1.2.3.4, 203.0.113.7" }
```

The pass condition is that `ip` is **not** `1.2.3.4`. A temporary debug route that echoes `request.ip` is worth ten minutes during a deployment change; remove it afterwards.

:::warning IPv6 keys must be a prefix, not an address
A residential IPv6 allocation is typically a `/64` or larger, so one household has 18 quintillion addresses and a per-address limiter counts every request separately. Truncate IPv6 trackers to the `/64` before keying. The full treatment, with the arithmetic, is on [Rate limiting and abuse](../security/rate-limiting-and-abuse.md).
:::

## Key by subject, not only by address

IP is the fallback identity for anonymous traffic. Where you have a better one — an account, an API key, a target email address — key on it, because that is the thing the attacker cannot cheaply rotate.

```ts good title="src/common/guards/subject-throttler.guard.ts"
import { Injectable } from '@nestjs/common'
import { ThrottlerGuard } from '@nestjs/throttler'

@Injectable()
export class SubjectThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, any>): Promise<string> {
    // An authenticated caller is tracked by identity, so rotating IPs does not help.
    if (req.user?.id) return `user:${req.user.id}`
    if (req.headers['x-api-key']) return `key:${String(req.headers['x-api-key'])}`
    return `ip:${req.ip}`
  }
}
```

For credential stuffing the most valuable key is not the caller at all — it is the **account under attack**:

```ts good title="src/auth/guards/login-throttler.guard.ts"
import { Injectable } from '@nestjs/common'
import { ThrottlerGuard } from '@nestjs/throttler'

@Injectable()
export class LoginThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, any>): Promise<string> {
    // Normalize so Victim@Example.com and victim@example.com share one counter.
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : ''
    // Both keys matter: this one caps attempts against one account from anywhere.
    return email ? `login:${email}` : `ip:${req.ip}`
  }
}
```

Apply both — the IP-keyed global guard and the subject-keyed one on the route — so an attacker needs to rotate addresses *and* spread across accounts.

```ts good title="src/auth/auth.controller.ts"
@UseGuards(LoginThrottlerGuard)
@Throttle({ long: { limit: 5, ttl: minutes(15), blockDuration: minutes(15) } })
@Post('login')
login(@Body() dto: LoginDto) {
  return this.auth.login(dto)
}
```

:::warning A body-keyed tracker runs before the body is validated
Guards run before pipes. `req.body.email` at that point is whatever JSON arrived — possibly an object, possibly absent. The `typeof … === 'string'` check above is not defensive style, it is required: `String({})` would produce `"[object Object]"` and put every malformed request into one shared counter. See [Guards](../nestjs-request-handling/guards.md).
:::

## In-memory storage is per-process

The default storage is a `Map` inside the guard's provider. That is correct for one process and wrong for everything else:

- **Two instances behind a load balancer**: each keeps its own counter, so the effective limit is `limit × instances`.
- **A rolling deploy**: every counter resets when the process does, so an attacker who notices your deploy schedule gets a clean slate.
- **`@nestjs/schedule` or cluster mode**: same problem, same cause.

Share the counters. `@nest-lab/throttler-storage-redis` **1.2.0** implements the storage interface against `ioredis` and declares `@nestjs/throttler >=6.0.0` as a peer, so it matches 6.5.0 — its `@nestjs/common` peer range stops at `^11.0.0` for the same reason the throttler's does.

If you would rather not add a dependency, the interface is one method, and writing it yourself is a legitimate choice:

```ts good title="src/common/throttler/redis-throttler.storage.ts"
import { Injectable } from '@nestjs/common'
import type { ThrottlerStorage } from '@nestjs/throttler'
import Redis from 'ioredis'

// `ThrottlerStorageRecord` is declared inside the package but is not re-exported
// from its entry point in 6.5.0, so declare the four fields `increment` returns.
interface ThrottlerStorageRecord {
  totalHits: number
  timeToExpire: number
  isBlocked: boolean
  timeToBlockExpire: number
}

@Injectable()
export class RedisThrottlerStorage implements ThrottlerStorage {
  private readonly redis: Redis

  constructor(redis: Redis) {
    this.redis = redis
  }

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    const hitKey = `throttle:${throttlerName}:${key}`
    const blockKey = `${hitKey}:blocked`

    const blockTtl = await this.redis.pttl(blockKey)
    if (blockTtl > 0) {
      return {
        totalHits: limit + 1,
        timeToExpire: Math.ceil(blockTtl / 1000),
        isBlocked: true,
        timeToBlockExpire: Math.ceil(blockTtl / 1000),
      }
    }

    // INCR then PEXPIRE only on the first hit: one window, not a sliding reset.
    const totalHits = await this.redis.incr(hitKey)
    if (totalHits === 1) await this.redis.pexpire(hitKey, ttl)
    const remainingTtl = await this.redis.pttl(hitKey)

    if (totalHits > limit) {
      await this.redis.set(blockKey, '1', 'PX', blockDuration)
      return {
        totalHits,
        timeToExpire: Math.ceil(remainingTtl / 1000),
        isBlocked: true,
        timeToBlockExpire: Math.ceil(blockDuration / 1000),
      }
    }

    return {
      totalHits,
      timeToExpire: Math.ceil(remainingTtl / 1000),
      isBlocked: false,
      timeToBlockExpire: 0,
    }
  }
}
```

```ts good title="src/app.module.ts"
ThrottlerModule.forRootAsync({
  imports: [RedisModule],
  inject: [RedisThrottlerStorage],
  useFactory: (storage: RedisThrottlerStorage) => ({
    throttlers: [{ name: 'long', ttl: minutes(1), limit: 120 }],
    storage,
  }),
})
```

`ThrottlerStorage` is both a TypeScript interface and an injection token (the package exports a symbol with the same name), so a custom storage can also be provided under that token directly.

:::warning Decide what happens when Redis is down
The code above throws if Redis is unreachable, which — with a global `APP_GUARD` — takes your API down with it. Choose deliberately: **fail closed** (reject; safest, and your outage is now Redis's outage) or **fail open** (allow, log loudly, alert). Most public APIs should fail open on the general limiter and fail closed on the authentication routes. Whichever you pick, write it down; the default of "whatever the exception filter does" is a decision made by accident.
:::

## The response, and what the client can do with it

On a block the guard throws `ThrottlerException`, which is an `HttpException` with status **429** and the default message `ThrottlerException: Too Many Requests`. It also sets these headers, verified from the source:

| Header | When |
| --- | --- |
| `X-RateLimit-Limit` | every non-blocked request |
| `X-RateLimit-Remaining` | every non-blocked request |
| `X-RateLimit-Reset` | every non-blocked request, in seconds |
| `Retry-After` | on the blocked response, in seconds |

Named throttlers other than `default` get a suffix: `X-RateLimit-Limit-short`. `setHeaders: false` turns them all off, which is worth considering on unauthenticated endpoints where you would rather not tell a prober exactly how much budget remains.

`Retry-After` is the one clients act on. If your API is consumed by browsers from another origin, list it — and the `X-RateLimit-*` headers you want readable — in `exposedHeaders` on your CORS configuration, or JavaScript cannot see them. See [CORS](cors.md).

## How to verify the fix

```bash
for i in $(seq 1 8); do
  curl -s -o /dev/null -D- -X POST localhost:3000/auth/login \
    -H 'content-type: application/json' \
    -d '{"email":"victim@example.com","password":"guess"}' \
    | grep -iE '^HTTP|^x-ratelimit-remaining|^retry-after'
done
```

```text
HTTP/1.1 401 Unauthorized
x-ratelimit-remaining: 4
HTTP/1.1 401 Unauthorized
x-ratelimit-remaining: 3
HTTP/1.1 401 Unauthorized
x-ratelimit-remaining: 2
HTTP/1.1 401 Unauthorized
x-ratelimit-remaining: 1
HTTP/1.1 401 Unauthorized
x-ratelimit-remaining: 0
HTTP/1.1 429 Too Many Requests
retry-after: 900
HTTP/1.1 429 Too Many Requests
retry-after: 900
HTTP/1.1 429 Too Many Requests
retry-after: 900
```

Then the bypass, which must change nothing:

```bash
for i in $(seq 1 8); do
  curl -s -o /dev/null -w '%{http_code} ' -X POST localhost:3000/auth/login \
    -H "X-Forwarded-For: 10.0.0.$i" \
    -H 'content-type: application/json' \
    -d '{"email":"victim@example.com","password":"guess"}'
done; echo
```

```text
401 401 401 401 401 429 429 429
```

Eight different claimed addresses, still blocked after five — because the login route is keyed by the target email, not by the caller.

```ts title="test/throttler.e2e-spec.ts"
import { Test } from '@nestjs/testing'
import request from 'supertest'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { AppModule } from '../src/app.module.js'

describe('login throttling', () => {
  let app: NestExpressApplication

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
    // The type parameter is what puts `set()` on the application object.
    app = moduleRef.createNestApplication<NestExpressApplication>()
    app.set('trust proxy', 1) // the same value main.ts sets
    await app.init()
  })

  afterAll(() => app.close())

  const attempt = (headers: Record<string, string> = {}) =>
    request(app.getHttpServer())
      .post('/auth/login')
      .set(headers)
      .send({ email: 'victim@example.com', password: 'guess' })

  it('returns 429 after the limit and sets Retry-After', async () => {
    for (let i = 0; i < 5; i++) await attempt().expect(401)

    const blocked = await attempt().expect(429)
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0)
  })

  it('cannot be bypassed with X-Forwarded-For', async () => {
    for (let i = 0; i < 5; i++) await attempt({ 'X-Forwarded-For': `10.0.0.${i}` })
    await attempt({ 'X-Forwarded-For': '10.0.0.99' }).expect(429)
  })
})
```

The second test is the important one and it is the one nobody writes. It fails the moment somebody "fixes" a load-balancer problem with `trust proxy: true`.

:::note
The default in-memory storage keeps state between tests in the same process, so throttler tests interfere with each other unless each one uses a distinct key (a different email, a different route) or the suite resets storage between cases. Give each test its own subject.
:::

## Production considerations

- **A throttle is not the only cap.** Body size, pagination maximums, upload limits, query timeouts and connection-pool size all fail independently. A limiter allowing 120 requests a minute still permits 120 forty-second queries a minute.
- **Charge by cost, not by count.** An endpoint that generates a PDF and an endpoint that returns a cached boolean should not share a budget. Named throttlers and per-route `@Throttle()` are how you express that.
- **Business-flow limits are not rate limits.** "One trial per payment instrument", "one coupon per account", "three invites per day" are counters in your database with your business rules, not a window in Redis. OWASP calls this API6 — see [OWASP API Top 10 in Nest](owasp-api-top-10.md).
- **Log 429s with the tracker.** A sustained block on one key is an attack in progress and one of the few signals that arrives pre-classified. Log the key, not the credentials — see [Safe logging](safe-logging.md).
- **Rate-limit at the edge as well.** A CDN or WAF rule stops the traffic before it costs you a Node process. The application limiter is what remains correct when somebody bypasses the edge.
- **`skipIf` for internal traffic, carefully.** `skipIf: (context) => isInternal(context)` based on a header is a bypass header; base it on the source address, and remember `trust proxy` governs what that means.
- **Probes must skip the throttle.** A readiness probe that gets a 429 is an instance removed from the load balancer during exactly the traffic spike the limiter was defending against.

## Common mistakes

- **Installing `@nestjs/throttler@12`.** No such version; it is 6.5.0.
- **Passing `ttl` in seconds.** It is milliseconds. `ttl: 60` is sixty milliseconds. Use `seconds()` / `minutes()`.
- **`trust proxy: true`.** Trusts a client-supplied header; the limiter becomes a per-request identity generator.
- **Leaving `trust proxy` unset behind a load balancer.** Every user shares one counter and legitimate traffic gets 429s.
- **Never verifying the hop count.** Echo `request.ip` once during a deploy change rather than reasoning about the diagram.
- **Keying on the IP only for login.** Credential stuffing rotates addresses. Key on the target account as well.
- **Reading `req.body` in a tracker without a type check.** Guards run before pipes; the body may be an object or absent, and `String({})` collapses every attempt into one bucket.
- **Keying IPv6 by full address.** One household has a `/64`; truncate.
- **Leaving the default in-memory storage in a multi-instance deployment.** The effective limit is `limit × instances`, and it resets on every deploy.
- **Not deciding what happens when the shared store is unavailable.** Fail open or fail closed on purpose.
- **Assuming one global limit covers everything.** The key includes the controller and handler names, so the limit is per route.
- **Forgetting `blockDuration`.** Without it the block lasts one `ttl`; on a login route that is usually far too short.
- **Throttling health and readiness probes.** `@SkipThrottle()` on the health controller.
- **Not exposing `Retry-After` through CORS.** Browser clients cannot read it, so they cannot back off.
- **Treating the limiter as the anti-abuse strategy.** It bounds volume. It does not stop one well-formed request from being wrong.

## Related topics

- [Rate limiting and abuse](../security/rate-limiting-and-abuse.md) — the threat model, IPv6 keying, body limits, pagination caps and regex cost.
- [Rate limiting with Throttler](../nestjs-libraries/throttler.md) — the module as a library, beyond the security framing.
- [Guards](../nestjs-request-handling/guards.md) — why the limiter is a guard, and what a guard can see.
- [Authentication and session security](authentication-and-session-security.md) — the login route these limits exist to protect.
- [CORS](cors.md) — exposing `Retry-After` and the rate-limit headers to browser clients.
- [Redis](../nestjs-databases/redis.md) — the shared store the counters belong in.
- [File upload security](file-upload-security.md) — the most expensive endpoint you own, and why it needs its own budget.
- [Safe logging](safe-logging.md) — recording a block without recording the attempt's contents.
- [Health and readiness probes](../nestjs-production/health-and-readiness-probes.md) — the routes that must never be throttled.
- [OWASP API Top 10 in Nest](owasp-api-top-10.md) — API4 and API6.
- [Clustering](../nestjs-production/clustering.md) — why per-process counters stop meaning anything.
