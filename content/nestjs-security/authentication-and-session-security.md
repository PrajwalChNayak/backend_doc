---
title: Authentication and session security
description: Credential stuffing, user enumeration, session fixation and password-reset design in NestJS 12 — with Throttler lockouts, constant-time comparisons, hardened express-session 1.19.0 and supertest proofs.
status: current
updated: 2026-09-11
---

Nest gives you guards, strategies and a DI container, and none of them decide whether your login endpoint is safe. The decisions that matter are the shape of the failure response, whether the session identifier survives the privilege change, what a logout actually deletes, and how many attempts a single email can absorb before the account stops answering. This page covers each one as an exploit you can run against a default Nest 12 application.

The underlying mechanics — how credential stuffing lists are built, why bcrypt cost matters, how timing oracles are measured — are in [Authentication and session security](../security/authentication-and-session-security.md) and are not repeated. The wiring is in [Authentication](../nestjs-libraries/authentication.md). What follows is what goes wrong once both are in place.

## Credential stuffing

### The threat

An attacker has four million email/password pairs from somebody else's breach. They do not need to guess anything. They need your login endpoint to answer quickly, in volume, and to say clearly which pairs worked. Roughly 0.1–2% of reused pairs hit, so four million credentials is somewhere between four thousand and eighty thousand working accounts — no vulnerability required, just an endpoint that answers as fast as you can ask.

### The exploit

A stock Nest login controller with a `LocalAuthGuard` and no limiter:

:::danger An unlimited login endpoint
```ts vulnerable title="DO NOT COPY — src/auth/auth.controller.ts"
import { Controller, HttpCode, Post, Req, UseGuards } from '@nestjs/common'
import type { Request } from 'express'
import { LocalAuthGuard } from './guards/local-auth.guard.js'

@Controller('auth')
export class AuthController {
  @UseGuards(LocalAuthGuard)
  @Post('login')
  @HttpCode(200)
  login(@Req() request: Request) {
    // No limiter, no lockout, no counter. Every request is a fresh chance.
    return { user: request.user }
  }
}
```
:::

```bash
while IFS=: read -r email password; do
  code=$(curl -s -o /dev/null -w '%{http_code}' -X POST localhost:3000/auth/login \
    -H 'content-type: application/json' \
    -d "{\"email\":\"$email\",\"password\":\"$password\"}")
  [ "$code" = 200 ] && echo "HIT $email:$password"
done < combolist.txt
```

```text
HIT dana@example.test:Summer2024!
HIT ravi@example.test:hunter2
HIT lee@example.test:Password1
```

At 400 requests per second that list is exhausted in under three hours, and every one of those requests is a well-formed 200 or 401. Nothing in the application is behaving abnormally.

### The fix in code

Two limiters that count different things, because they stop different attacks.

**Per-IP** bounds the volume from one source. **Per-account** bounds the attempts against one email regardless of how many addresses they come from — which is the half that matters, because a stuffing run is distributed by definition.

`@nestjs/throttler` is **6.5.0** — not on the 12.x line, despite the rest of the `@nestjs/*` packages.

```ts title="src/app.module.ts"
import { Module } from '@nestjs/common'
import { APP_GUARD } from '@nestjs/core'
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler'

@Module({
  imports: [
    ThrottlerModule.forRoot({
      throttlers: [
        { name: 'default', ttl: 60_000, limit: 120 },
        // Five login attempts a minute from one address, then a 15-minute block.
        { name: 'auth', ttl: 60_000, limit: 5, blockDuration: 900_000 },
      ],
    }),
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
```

`blockDuration` is the option that turns a rate limiter into a real cost: without it the attacker simply paces themselves at five per minute forever. With it, exceeding the limit locks that key out for the full fifteen minutes.

The per-account counter is a separate, deliberate piece of state, because it must survive across addresses:

```ts title="src/auth/login-attempts.service.ts"
import { Inject, Injectable } from '@nestjs/common'
import type Redis from 'ioredis'
import { REDIS } from '../redis/redis.module.js'

const MAX_FAILURES = 10
const WINDOW_SECONDS = 900

@Injectable()
export class LoginAttemptsService {
  private readonly redis: Redis

  constructor(@Inject(REDIS) redis: Redis) {
    this.redis = redis
  }

  private key(email: string): string {
    // Normalize so Dana@… and dana@… share one counter.
    return `login:fail:${email.trim().toLowerCase()}`
  }

  async isLocked(email: string): Promise<boolean> {
    const count = await this.redis.get(this.key(email))
    return Number(count ?? 0) >= MAX_FAILURES
  }

  async recordFailure(email: string): Promise<void> {
    const key = this.key(email)
    // INCR then EXPIRE only on the first failure, so the window is a sliding
    // 15 minutes from the first bad attempt rather than from the last.
    const count = await this.redis.incr(key)
    if (count === 1) await this.redis.expire(key, WINDOW_SECONDS)
  }

  async clear(email: string): Promise<void> {
    await this.redis.del(this.key(email))
  }
}
```

```ts title="src/auth/auth.service.ts"
import { Injectable, UnauthorizedException } from '@nestjs/common'
import { LoginAttemptsService } from './login-attempts.service.js'
import { PasswordService } from './password.service.js'
import { UsersService } from '../users/users.service.js'

@Injectable()
export class AuthService {
  private readonly users: UsersService
  private readonly passwords: PasswordService
  private readonly attempts: LoginAttemptsService

  constructor(users: UsersService, passwords: PasswordService, attempts: LoginAttemptsService) {
    this.users = users
    this.passwords = passwords
    this.attempts = attempts
  }

  async validate(email: string, password: string) {
    // A locked account answers exactly like a wrong password. Saying "locked"
    // tells the attacker the email is real and that they are being counted.
    if (await this.attempts.isLocked(email)) {
      throw new UnauthorizedException('Invalid email or password')
    }

    const user = await this.users.findByEmail(email)
    const ok = await this.passwords.verify(user?.passwordHash, password)

    if (!ok || !user) {
      await this.attempts.recordFailure(email)
      throw new UnauthorizedException('Invalid email or password')
    }

    await this.attempts.clear(email)
    return user
  }
}
```

:::warning A lockout is also a denial-of-service primitive
Ten failures locking an account for fifteen minutes means anybody who knows a victim's email can keep them out indefinitely. Three ways to keep the control without handing over that lever:

- **Throttle rather than hard-lock.** Add delay and a CAPTCHA-equivalent challenge after N failures instead of refusing outright.
- **Do not extend the window on attempts made while locked.** The counter above expires 15 minutes after the *first* failure; incrementing on every subsequent attempt would let an attacker hold the lock open forever.
- **Exempt a recognized device.** A request carrying a valid long-lived device cookie for that account skips the lock.
:::

### How to verify

```bash
for i in $(seq 1 7); do
  curl -s -o /dev/null -w "$i %{http_code}\n" -X POST localhost:3000/auth/login \
    -H 'content-type: application/json' \
    -d '{"email":"dana@example.test","password":"wrong"}'
done
```

```text
1 401
2 401
3 401
4 401
5 401
6 429
7 429
```

The sixth request is the limiter, not the credential check. `ThrottlerGuard` also sets the `X-RateLimit-*` headers and `Retry-After` — see [Rate limiting and abuse](rate-limiting.md) for the header contract and for the proxy-trust trap that makes an IP-keyed limiter useless behind a load balancer.

## User enumeration

### The threat

Before stuffing a list, an attacker wants to know which of those four million addresses have accounts with *you*. A signup form that says "email already registered", a login that distinguishes "no such user" from "wrong password", and a reset endpoint that 404s on unknown addresses each convert the whole list into a filtered one. The filtered list is what gets sold.

### The exploit

Three endpoints, three oracles:

```bash
# 1 — login distinguishes the two failures
curl -s -X POST localhost:3000/auth/login -H 'content-type: application/json' \
  -d '{"email":"nobody@example.test","password":"x"}'
```

```json title="404 Not Found"
{ "message": "No account with that email", "statusCode": 404 }
```

```bash
curl -s -X POST localhost:3000/auth/login -H 'content-type: application/json' \
  -d '{"email":"dana@example.test","password":"x"}'
```

```json title="401 Unauthorized — dana@example.test exists"
{ "message": "Incorrect password", "statusCode": 401 }
```

```bash
# 2 — password reset confirms the address
curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:3000/auth/forgot-password \
  -H 'content-type: application/json' -d '{"email":"nobody@example.test"}'
```

```text
404
```

```bash
# 3 — and even with identical bodies, the clock talks
curl -s -o /dev/null -w '%{time_total}\n' -X POST localhost:3000/auth/login \
  -H 'content-type: application/json' -d '{"email":"nobody@example.test","password":"x"}'
curl -s -o /dev/null -w '%{time_total}\n' -X POST localhost:3000/auth/login \
  -H 'content-type: application/json' -d '{"email":"dana@example.test","password":"x"}'
```

```text
0.004
0.071
```

Four milliseconds means the code returned before hashing anything. Seventy-one means argon2 ran, which means there was a stored hash to compare against. The bodies can be byte-identical and the difference is still a reliable signal over a handful of samples.

### The fix in code

**One response for every failure**, and the same amount of work on both paths.

```ts good title="src/auth/auth.service.ts"
import { Injectable, UnauthorizedException } from '@nestjs/common'

@Injectable()
export class AuthService {
  async validate(email: string, password: string) {
    const user = await this.users.findByEmail(email)

    // PasswordService.verify() hashes against a dummy argon2id digest when the
    // user is missing, so both branches pay the same ~60ms.
    const ok = await this.passwords.verify(user?.passwordHash, password)

    if (!ok || !user) {
      // Same status, same message, same shape, whichever half failed.
      throw new UnauthorizedException('Invalid email or password')
    }
    return user
  }
}
```

The dummy-hash technique is the one in [Authentication](../nestjs-libraries/authentication.md): hold a real argon2id digest of a random string in config, and verify against it when no user was found. Comparing against a constant string, or skipping the comparison with an early `return false`, restores the oracle.

For anything that is not a password — a reset token, an invite code, an HMAC — compare with `timingSafeEqual`, which does not stop at the first differing byte:

```ts good title="src/common/crypto/constant-time.ts"
import { createHash, timingSafeEqual } from 'node:crypto'

/**
 * Hashing both sides first means the buffers are always 32 bytes, so the
 * comparison cannot leak length — and timingSafeEqual throws on a length
 * mismatch, which would itself be an early-exit signal.
 */
export function constantTimeEquals(a: string, b: string): boolean {
  const digestA = createHash('sha256').update(a).digest()
  const digestB = createHash('sha256').update(b).digest()
  return timingSafeEqual(digestA, digestB)
}
```

`a === b` on a token is a byte-at-a-time comparison that returns as soon as it finds a difference. Over enough samples that is measurable, and a token you can measure is a token you can construct one byte at a time.

Registration and reset need the same discipline, which means changing the product behaviour and not just the code:

| Endpoint | Enumerable response | Non-enumerable response |
| --- | --- | --- |
| `POST /auth/login` | 404 "no such user" vs 401 "wrong password" | 401 "Invalid email or password", always |
| `POST /auth/register` | 409 "email already registered" | 202 "Check your email" — then mail either a welcome or a "you already have an account" |
| `POST /auth/forgot-password` | 404 for unknown addresses | 202 "If that address has an account, we sent a link" |
| `POST /auth/verify-email` | 200 vs 404 | 204 for both |

:::note The register case is a genuine trade-off
A signup form that cannot say "that email is taken" is worse to use. The usual compromise is to keep the inline check but put it behind a strict per-IP limiter and a bot challenge, so it costs an attacker far more than one request per address. Decide it deliberately; do not leak it by accident.
:::

## Session fixation

### The threat

The attacker obtains a session identifier *before* the victim authenticates — by planting one, or by reading one from a URL, a shared machine or a subdomain — and then waits for the victim to log in using it. If the identifier does not change at login, the attacker's copy is now an authenticated session belonging to the victim.

### The exploit

A hand-written session login, which is exactly what you get when you wire `express-session` yourself instead of going through Passport:

:::danger A login that keeps the session id
```ts vulnerable title="DO NOT COPY — src/auth/auth.controller.ts"
import { Body, Controller, HttpCode, Post, Req } from '@nestjs/common'
import type { Request } from 'express'
import { AuthService } from './auth.service.js'
import { LoginDto } from './dto/login.dto.js'

@Controller('auth')
export class AuthController {
  private readonly auth: AuthService

  constructor(auth: AuthService) {
    this.auth = auth
  }

  @Post('login')
  @HttpCode(200)
  async login(@Body() dto: LoginDto, @Req() request: Request) {
    const user = await this.auth.validate(dto.email, dto.password)
    // The session id the caller arrived with is the session id they leave with,
    // and it is now an authenticated session.
    request.session.userId = user.id
    return { ok: true }
  }
}
```
:::

```bash
# 1 — the attacker gets a session id from the unauthenticated app
curl -s -i localhost:3000/health | grep -i set-cookie
```

```text
Set-Cookie: sid=s%3AOxq1...; Path=/; HttpOnly; SameSite=Lax
```

```bash
# 2 — the victim is induced to use it, and logs in
curl -s -o /dev/null -X POST localhost:3000/auth/login \
  -H 'content-type: application/json' -b 'sid=s%3AOxq1...' \
  -d '{"email":"dana@example.test","password":"Summer2024!"}'

# 3 — the attacker replays the id they already had
curl -s localhost:3000/me -b 'sid=s%3AOxq1...'
```

```json title="200 OK — the attacker is Dana"
{ "id": "u-771", "email": "dana@example.test", "role": "admin" }
```

### The fix in code

Regenerate the session at every privilege change. `Session.regenerate()` in `express-session` 1.19.0 destroys the old record in the store and generates a fresh identifier, so the attacker's copy resolves to nothing.

```ts good title="src/auth/auth.controller.ts"
import { Body, Controller, HttpCode, Post, Req } from '@nestjs/common'
import type { Request } from 'express'
import { AuthService } from './auth.service.js'
import { LoginDto } from './dto/login.dto.js'

@Controller('auth')
export class AuthController {
  private readonly auth: AuthService

  constructor(auth: AuthService) {
    this.auth = auth
  }

  @Post('login')
  @HttpCode(200)
  async login(@Body() dto: LoginDto, @Req() request: Request) {
    const user = await this.auth.validate(dto.email, dto.password)

    // regenerate() destroys the old record and mints a new id.
    await new Promise<void>((resolve, reject) => {
      request.session.regenerate((error) => (error ? reject(error) : resolve()))
    })

    request.session.userId = user.id
    request.session.createdAt = Date.now()

    // save() before responding, so the store write cannot lose the race with
    // the client's next request.
    await new Promise<void>((resolve, reject) => {
      request.session.save((error) => (error ? reject(error) : resolve()))
    })

    return { ok: true }
  }
}
```

The callback-to-promise wrapping is unavoidable: `express-session` predates promises and Nest will happily return the response before the store write lands if you do not await it.

:::best-practice Let Passport do it
`passport@0.7.0`'s `req.logIn()` already calls `req.session.regenerate()`, then serializes the user, then `req.session.save()` — in that order. `req.logOut()` clears the user key, saves, and regenerates again. If you are using `@nestjs/passport` with a `LocalAuthGuard`, the fixation fix is already applied and the code above is what it does for you.

The exception is `keepSessionInfo: true`, which merges the pre-login session back over the new one. Anything an attacker planted in that session comes back with it. Use it only for a specific key you actually need (a post-login redirect target), and copy that key explicitly rather than merging the whole object.
:::

Regenerate on **every** privilege change, not only login: completing a step-up MFA challenge, assuming a support role, accepting an invitation that grants admin, and finishing a password change all move the session across a trust boundary.

## Hardening `express-session`

`express-session` is ordinary Express middleware and is applied in `main.ts`. Every option below is doing security work.

```ts good title="src/main.ts"
import { NestFactory } from '@nestjs/core'
import { ConfigService } from '@nestjs/config'
import { RedisStore } from 'connect-redis'
import session from 'express-session'
import helmet from 'helmet'
import { Redis } from 'ioredis'
import { AppModule } from './app.module.js'

async function bootstrap() {
  const app = await NestFactory.create(AppModule)
  const config = app.get(ConfigService)
  const isProduction = config.getOrThrow<string>('NODE_ENV') === 'production'

  // Express 5 under the hood; this is how the cookie's `secure` flag survives
  // TLS termination at the load balancer.
  app.set('trust proxy', 1)
  app.use(helmet())

  app.use(
    session({
      store: new RedisStore({ client: new Redis(config.getOrThrow<string>('REDIS_URL')) }),
      name: 'sid',                    // not the default; do not advertise the stack
      secret: config.getOrThrow<string>('SESSION_SECRET'),
      resave: false,                  // do not rewrite an unchanged session
      saveUninitialized: false,       // do not mint a record for anonymous visitors
      rolling: true,                  // refresh maxAge on each response: idle timeout
      proxy: true,
      cookie: {
        httpOnly: true,               // script cannot read it
        secure: isProduction,         // HTTPS only
        sameSite: 'lax',              // cross-site POSTs do not carry it
        maxAge: 30 * 60 * 1000,       // 30-minute idle window
        path: '/',
      },
    }),
  )

  await app.listen(config.getOrThrow<number>('PORT'))
}

bootstrap()
```

| Option | Value | What it prevents |
| --- | --- | --- |
| `store` | a real store | memory growth and sessions that vanish on deploy — see below |
| `secret` | 32+ random bytes from config | a forged signed cookie |
| `resave` | `false` | write amplification, and a race that resurrects a destroyed session |
| `saveUninitialized` | `false` | a store record per crawler hit, and a fixable id handed to anonymous callers |
| `rolling` | `true` | a fixed lifetime that ignores activity; this is what makes `maxAge` an idle timeout |
| `cookie.httpOnly` | `true` | an XSS reading the session id |
| `cookie.secure` | `true` in production | the cookie on a plaintext request |
| `cookie.sameSite` | `'lax'` | most CSRF — see [CSRF](csrf.md) |
| `proxy` + `trust proxy` | set | `secure: true` silently dropping every cookie behind a TLS-terminating proxy |

`saveUninitialized: false` is the one people restore without thinking, usually to stash something before login. It is also what stops an anonymous visitor from being handed a durable identifier they can give to somebody else.

### MemoryStore in production is a leak

The default store keeps every session in the process heap. That is three separate failures:

- **It never bounds.** Expired sessions are not reaped, so the heap grows with traffic until the process dies.
- **It is per-process.** Two replicas, or one `cluster` worker set, means a user is logged in on whichever instance the load balancer happens to pick. Logout on one does nothing to the others.
- **A restart logs everybody out**, including a rolling deploy.

`express-session` prints the warning itself — but only when `NODE_ENV` is exactly `production`:

```text
Warning: connect.session() MemoryStore is not
designed for a production environment, as it will leak
memory, and will not scale past a single process.
```

Set `NODE_ENV` wrong in your container and you do not even get the warning. Use `connect-redis` **10.0.0** or `connect-mongo` **6.0.0**, and assert the store type at boot rather than trusting a log line:

```ts good title="src/main.ts"
import session from 'express-session'

// A store misconfiguration must stop the deploy, not produce a log line
// nobody reads. `session.MemoryStore` is exported for exactly this.
function assertRealStore(store: session.Store, isProduction: boolean): void {
  if (isProduction && store instanceof session.MemoryStore) {
    throw new Error('Refusing to start: MemoryStore is not a production session store')
  }
}
```

## Idle and absolute timeouts

`maxAge` with `rolling: true` gives you an **idle** timeout: the window resets on every response, so an active user is never logged out. It gives you no **absolute** cap, so a session that is touched once every twenty-nine minutes lives forever. A stolen cookie that is kept warm by a script is a permanent credential.

Enforce both. The absolute limit is your own field on the session, checked by a guard:

```ts good title="src/auth/guards/session-timeout.guard.ts"
import { Injectable, UnauthorizedException } from '@nestjs/common'
import type { CanActivate, ExecutionContext } from '@nestjs/common'
import type { Request } from 'express'

const ABSOLUTE_MAX_MS = 12 * 60 * 60 * 1000

@Injectable()
export class SessionTimeoutGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>()
    const session = request.session

    if (!session?.userId) throw new UnauthorizedException()

    const createdAt = session.createdAt ?? 0
    if (Date.now() - createdAt > ABSOLUTE_MAX_MS) {
      // Destroy it here; an expired session must not be renewable.
      await new Promise<void>((resolve) => session.destroy(() => resolve()))
      throw new UnauthorizedException('Session expired')
    }
    return true
  }
}
```

`createdAt` is set once, at regeneration, and never refreshed — that is the whole point. Declare it on the session type so TypeScript does not silently accept a typo:

```ts good title="src/types/express-session.d.ts"
import 'express-session'

declare module 'express-session' {
  interface SessionData {
    userId?: string
    createdAt?: number
  }
}
```

| Timeout | Mechanism | Typical value |
| --- | --- | --- |
| Idle | `cookie.maxAge` + `rolling: true` | 15–30 minutes for sensitive apps, 8 hours for low-risk |
| Absolute | your own `createdAt` field, checked in a guard | 8–24 hours |
| Re-authentication | prompt for the password again before a sensitive action | per action, not per session |

The third row is the one people skip. Changing an email address, adding a payment method or disabling MFA should ask for the password again regardless of how fresh the session is, because those are the actions a stolen session is worth stealing for.

## Logout that actually logs out

### The threat

Clearing the cookie client-side deletes the attacker's copy of nothing. If the record is still in the store, anybody holding the identifier is still authenticated.

:::danger A logout that only clears a cookie
```ts vulnerable title="DO NOT COPY — src/auth/auth.controller.ts"
@Post('logout')
@HttpCode(204)
logout(@Res({ passthrough: true }) response: Response) {
  // The store record is untouched. The id still resolves.
  response.clearCookie('sid')
}
```
:::

```bash
curl -s -c jar -X POST localhost:3000/auth/login -H 'content-type: application/json' \
  -d '{"email":"dana@example.test","password":"Summer2024!"}' > /dev/null
SID=$(grep sid jar | awk '{print $7}')

curl -s -o /dev/null -X POST localhost:3000/auth/logout -b "sid=$SID"
curl -s localhost:3000/me -b "sid=$SID"
```

```json title="200 OK — still logged in after logout"
{ "id": "u-771", "email": "dana@example.test" }
```

### The fix in code

Destroy the server-side record, then clear the cookie.

```ts good title="src/auth/auth.controller.ts"
import { Controller, HttpCode, Post, Req, Res } from '@nestjs/common'
import type { Request, Response } from 'express'

@Controller('auth')
export class AuthController {
  @Post('logout')
  @HttpCode(204)
  async logout(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    await new Promise<void>((resolve, reject) => {
      // destroy() removes the record from the store. The id now resolves to
      // nothing, for every copy of it that exists anywhere.
      request.session.destroy((error) => (error ? reject(error) : resolve()))
    })
    response.clearCookie('sid', { path: '/', httpOnly: true, sameSite: 'lax' })
  }
}
```

`clearCookie` must repeat the attributes the cookie was set with — `path` in particular — or the browser keeps the original. Note that `res.clearCookie()` in Express 5 ignores `maxAge` and `expires`, so do not pass them.

Two more things a complete logout does:

- **"Log out everywhere"** means deleting every session for that user. That needs a user-to-session index, because a session store is keyed by session id: keep a Redis set `user:sessions:<userId>` and delete each member on request.
- **A password change invalidates other sessions.** This is not optional — the most common reason a user changes their password is that they think somebody else has it. Delete every session for the user except the current one, and regenerate the current one.

For token-based authentication the equivalent problem has no cookie to clear at all; see [JWT pitfalls](jwt-pitfalls.md).

## Password reset tokens

A reset token is a bearer credential that grants full account takeover. Four properties are non-negotiable.

| Property | Why | How |
| --- | --- | --- |
| Unguessable | it *is* the credential | `randomBytes(32).toString('base64url')` |
| Hashed at rest | a database read must not yield working tokens | store `sha256(token)`, look up by hash |
| Single use | a token in an email thread, a proxy log or a browser history stays valid otherwise | conditional `UPDATE … WHERE used_at IS NULL` |
| Short-lived | bounds every leak above | 15–60 minutes, checked server-side |

```ts good title="src/auth/password-reset.service.ts"
import { Injectable, UnauthorizedException } from '@nestjs/common'
import { createHash, randomBytes } from 'node:crypto'
import { MailService } from '../mail/mail.service.js'
import { PasswordResetRepository } from './password-reset.repository.js'
import { PasswordService } from './password.service.js'
import { SessionRegistry } from './session-registry.js'
import { UsersService } from '../users/users.service.js'

const TTL_MS = 30 * 60 * 1000

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

@Injectable()
export class PasswordResetService {
  private readonly repo: PasswordResetRepository
  private readonly users: UsersService
  private readonly passwords: PasswordService
  private readonly sessions: SessionRegistry
  private readonly mail: MailService

  constructor(
    repo: PasswordResetRepository,
    users: UsersService,
    passwords: PasswordService,
    sessions: SessionRegistry,
    mail: MailService,
  ) {
    this.repo = repo
    this.users = users
    this.passwords = passwords
    this.sessions = sessions
    this.mail = mail
  }

  async request(email: string): Promise<void> {
    const user = await this.users.findByEmail(email)
    // No user? Do nothing and return normally. The controller answers 202
    // either way, so this endpoint is not an existence oracle.
    if (!user) return

    // Invalidate any outstanding token before issuing a new one.
    await this.repo.invalidateAllForUser(user.id)

    const token = randomBytes(32).toString('base64url')
    await this.repo.insert({
      tokenHash: sha256(token),
      userId: user.id,
      expiresAt: new Date(Date.now() + TTL_MS),
      usedAt: null,
    })

    // The raw token exists only in this variable and in the email body.
    await this.mail.sendResetLink(user.email, token)
  }

  async complete(token: string, newPassword: string): Promise<void> {
    // Look up by hash: there is no way to enumerate stored tokens, and the
    // lookup is an indexed equality match rather than a scan-and-compare.
    const record = await this.repo.findByHash(sha256(token))

    if (!record || record.usedAt !== null || record.expiresAt.getTime() < Date.now()) {
      throw new UnauthorizedException('Invalid or expired reset token')
    }

    // Atomic single-use: exactly one concurrent request wins this update.
    const consumed = await this.repo.markUsedIfUnused(record.tokenHash)
    if (!consumed) throw new UnauthorizedException('Invalid or expired reset token')

    await this.users.setPasswordHash(record.userId, await this.passwords.hash(newPassword))

    // The reason people reset is that somebody else has the old password.
    // Every existing session and refresh token must go.
    await this.sessions.destroyAllForUser(record.userId)
    await this.repo.invalidateAllForUser(record.userId)
  }
}
```

```ts good title="src/auth/auth.controller.ts"
import { Body, Controller, HttpCode, Post } from '@nestjs/common'
import { Throttle } from '@nestjs/throttler'
import { ForgotPasswordDto } from './dto/forgot-password.dto.js'
import { PasswordResetService } from './password-reset.service.js'

@Controller('auth')
export class AuthController {
  private readonly reset: PasswordResetService

  constructor(reset: PasswordResetService) {
    this.reset = reset
  }

  // Three a minute. Without this the endpoint is a free mail cannon pointed
  // at any address the attacker chooses.
  @Throttle({ auth: { limit: 3, ttl: 60_000 } })
  @Post('forgot-password')
  @HttpCode(202)
  async forgotPassword(@Body() dto: ForgotPasswordDto) {
    await this.reset.request(dto.email)
    // Identical body, identical status, whether or not the account exists.
    return { message: 'If that address has an account, we have sent a reset link' }
  }
}
```

Two details that are easy to get wrong:

- **Never put the token in the redirect or in an analytics-visible URL.** A reset link opened in a browser puts the token in `document.referrer` for every third-party script on the landing page, and in every access log between the user and you. Land on a page that immediately POSTs the token and strips it from the address bar. See [Safe logging](safe-logging.md).
- **Do not send the token back in the response body** of the request endpoint, even in development. That code survives into production more often than it should, and it turns the enumeration-proof 202 into a full takeover.

## Verifying

```ts title="test/auth-security.e2e-spec.ts"
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { AppModule } from '../src/app.module.js'
import { seedUser } from './fixtures/users.fixture.js'

describe('authentication hardening', () => {
  let app: import('@nestjs/common').INestApplication

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = moduleRef.createNestApplication()
    await app.init()
    await seedUser({ email: 'dana@example.test', password: 'Summer2024!' })
  })

  afterAll(() => app.close())

  it('answers identically for an unknown user and a wrong password', async () => {
    const unknown = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'nobody@example.test', password: 'x' })
    const wrong = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'dana@example.test', password: 'x' })

    expect(unknown.status).toBe(wrong.status)
    expect(unknown.body).toEqual(wrong.body)
  })

  it('does not leak existence through timing', async () => {
    const time = async (email: string) => {
      const started = process.hrtime.bigint()
      await request(app.getHttpServer()).post('/auth/login').send({ email, password: 'x' })
      return Number(process.hrtime.bigint() - started) / 1e6
    }
    // Both paths must run argon2. A 10x gap means an early return somewhere.
    const unknown = await time('nobody@example.test')
    const known = await time('dana@example.test')
    expect(Math.max(unknown, known) / Math.min(unknown, known)).toBeLessThan(3)
  })

  it('changes the session id at login', async () => {
    const anonymous = await request(app.getHttpServer()).get('/health')
    const before = anonymous.headers['set-cookie']?.[0]

    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .set('cookie', before ?? '')
      .send({ email: 'dana@example.test', password: 'Summer2024!' })
      .expect(200)

    const after = login.headers['set-cookie'][0]
    expect(after).not.toBe(before)
  })

  it('invalidates the session server-side on logout', async () => {
    const agent = request.agent(app.getHttpServer())
    await agent.post('/auth/login').send({ email: 'dana@example.test', password: 'Summer2024!' })
    const cookie = agent.jar.getCookie('sid', { path: '/', domain: '127.0.0.1', secure: false })

    await agent.post('/auth/logout').expect(204)

    // Replay the exact cookie the server issued. It must no longer resolve.
    await request(app.getHttpServer())
      .get('/me')
      .set('cookie', `sid=${cookie?.value}`)
      .expect(401)
  })

  it('sets the cookie flags that matter', async () => {
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'dana@example.test', password: 'Summer2024!' })

    const cookie = login.headers['set-cookie'][0]
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Lax')
  })

  it('rate limits repeated failures', async () => {
    const codes: number[] = []
    for (let i = 0; i < 7; i++) {
      const response = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: 'dana@example.test', password: 'wrong' })
      codes.push(response.status)
    }
    expect(codes).toContain(429)
  })
})
```

The logout test is the one worth writing first: it fails loudly the moment somebody "simplifies" logout into a `clearCookie`.

:::warning
Run these against a real session store, not `MemoryStore`. A `MemoryStore` test passes while the production Redis store silently fails to destroy anything, because the two have different failure modes. See [Testing with a database](../nestjs-databases/testing-with-a-database.md).
:::

## Production considerations

- **Key the per-account counter in shared state.** A `Map` in a provider is per-process, so ten replicas give an attacker ten times the attempts. Redis, or the `@nestjs/throttler` storage abstraction with a shared backend.
- **Alert on the rate of 401s per account, not only per IP.** A distributed stuffing run looks like normal traffic from every address and abnormal traffic against every account.
- **Log authentication outcomes with the subject, never the credential.** "login failed, user u-771, ip hash abc" is useful. The password, the session id and the reset token never appear. See [Safe logging](safe-logging.md).
- **`trust proxy` must match your actual hop count.** Set too high, the client picks its own `X-Forwarded-For` and every per-IP control is decorative. See [Rate limiting and abuse](rate-limiting.md).
- **Session store failure must fail closed.** If Redis is unreachable, `express-session` hands the request a fresh empty session; make sure that produces a 401 and not an unauthenticated request treated as authorized.
- **Set an explicit session `name`.** The default `connect.sid` names your framework in every response.
- **Rotate `SESSION_SECRET` with an array.** `express-session` accepts `secret: [newest, previous]`, signing with the first and accepting any — which is how you rotate without logging everyone out. See [Secrets and config validation](secrets-and-config.md).

## Common mistakes

- **Different status codes for "no such user" and "wrong password".** One is an enumeration oracle even when the bodies match.
- **Returning early when the user is missing.** The response body can be identical and the timing still tells the attacker everything.
- **`storedToken === presented` on a reset or invite token.** Byte-at-a-time comparison. Hash both sides and use `timingSafeEqual`.
- **Rate limiting by IP only.** Credential stuffing is distributed by design; the account-scoped counter is the one that bites.
- **A lockout with no escape hatch.** It becomes a denial-of-service against any address the attacker knows.
- **Extending the lockout window on attempts made while locked.** The victim never gets back in.
- **Not regenerating the session at login.** Session fixation, in one line of missing code.
- **`keepSessionInfo: true` on `req.logIn()`.** It merges the pre-login session back, including whatever was planted in it.
- **`MemoryStore` in production.** Unbounded heap, per-process state, and a warning that only prints when `NODE_ENV` is exactly `production`.
- **`saveUninitialized: true`.** A durable identifier for every anonymous visitor and a store record for every crawler.
- **`secure: true` without `trust proxy`.** Behind a TLS-terminating proxy the cookie is silently never set.
- **`maxAge` with `rolling: true` as the only timeout.** No absolute cap, so a kept-warm session never dies.
- **Logout that only clears the cookie.** Every copy of the identifier still works.
- **Leaving other sessions alive after a password change.** The whole reason for the change was that somebody else had the old password.
- **Storing reset tokens in plaintext.** A single `SELECT` becomes account takeover for every pending reset.
- **Multi-use reset tokens.** They live in mail archives, proxy logs and browser history.
- **Putting the reset token in a URL that then loads third-party scripts.** `document.referrer` hands it over.
- **Returning the reset token in the response body "for testing".** It ships.

## Related topics

- [Authentication and session security](../security/authentication-and-session-security.md) — the framework-independent treatment, with MFA and recovery codes.
- [Authentication](../nestjs-libraries/authentication.md) — `JwtModule`, Passport strategies, argon2 and the refresh-token service this page assumes.
- [JWT pitfalls](jwt-pitfalls.md) — the same problems when there is no session to destroy.
- [CSRF](csrf.md) — the attack that cookie authentication specifically enables.
- [Rate limiting and abuse](rate-limiting.md) — `@nestjs/throttler` 6.5.0 in full, including proxy trust and shared storage.
- [Authorization and IDOR](authorization-and-idor.md) — what happens after the caller is authenticated.
- [Guards](../nestjs-request-handling/guards.md) — where `SessionTimeoutGuard` runs in the pipeline.
- [Secrets and config validation](secrets-and-config.md) — making `SESSION_SECRET` a boot-time requirement.
- [Safe logging](safe-logging.md) — recording authentication events without recording credentials.
- [Password hashing](../express-libraries/password-hashing.md) — argon2 parameters, `needsRehash`, and the bcrypt fallback.
- [Cookies](../express-libraries/cookies.md) — the attribute reference behind the table above.
- [End-to-end tests](../nestjs-testing/e2e-tests.md) — the fixtures and agent helpers the suite uses.
