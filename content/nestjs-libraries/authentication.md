---
title: Authentication
description: Passport strategies and JWTs in NestJS 12 — PassportStrategy, LocalStrategy, JwtStrategy, JwtModule.registerAsync, refresh-token rotation with reuse detection, and sessions as the alternative.
status: current
updated: 2026-09-11
---

Nest ships two first-party authentication packages: `@nestjs/passport` **12.0.0**, a thin bridge between Passport strategies and Nest guards, and `@nestjs/jwt` **12.0.1**, a `JwtService` wrapper over `jsonwebtoken` 9.0.3. Neither decides anything for you. What they give you is a place to put the decision that the DI container and the guard pipeline can both see.

## Why these packages exist

[Guards](../nestjs-request-handling/guards.md) already answer "may this request proceed". Authentication is the guard that runs first and populates `request.user`, and the two packages exist so that guard does not have to be hand-written per strategy.

- `@nestjs/passport` turns any of Passport's hundreds of strategies into an injectable class and a guard, so `AuthGuard('jwt')` and `AuthGuard('google')` are the same call shape.
- `@nestjs/jwt` puts signing configuration in the module graph, so `JWT_SECRET` is read once at boot through `ConfigService` rather than from `process.env` inside a service.

The [Express authentication page](../express-libraries/authentication.md) covers the underlying mechanics — token shape, session fixation, where to store a token in a browser, and an honest assessment of when Passport is worth it at all. That assessment carries over: Passport earns its place for federated identity and is mostly ceremony for email-and-password against your own table. What changes in Nest is that the ceremony is cheaper, because the strategy is a provider and can inject your services.

## Installing

:::tabs
@tab npm
```bash
npm install @nestjs/passport@12.0.0 @nestjs/jwt@12.0.1 passport@0.7.0 passport-jwt@4.0.1 passport-local@1.0.0 argon2@0.45.1
npm install --save-dev @types/passport-jwt @types/passport-local
```
@tab pnpm
```bash
pnpm add @nestjs/passport@12.0.0 @nestjs/jwt@12.0.1 passport@0.7.0 passport-jwt@4.0.1 passport-local@1.0.0 argon2@0.45.1
pnpm add -D @types/passport-jwt @types/passport-local
```
@tab yarn
```bash
yarn add @nestjs/passport@12.0.0 @nestjs/jwt@12.0.1 passport@0.7.0 passport-jwt@4.0.1 passport-local@1.0.0 argon2@0.45.1
yarn add -D @types/passport-jwt @types/passport-local
```
:::

`@nestjs/passport` 12.0.0 peers on `passport` `^0.5.0 || ^0.6.0 || ^0.7.0` — 0.7.0 is current. `@nestjs/jwt` 12.0.1 bundles `jsonwebtoken` 9.0.3 as a real dependency, so you do not install it yourself and you do not get to pick its version.

## Registering `JwtModule` with `ConfigService`

`JwtModule.register()` takes static options. In an application with validated configuration you want `registerAsync`, because the secret is a boot-time value that must come from the same place everything else does.

```ts title="src/auth/auth.module.ts"
import { Module } from '@nestjs/common'
import { ConfigModule, ConfigService } from '@nestjs/config'
import { JwtModule } from '@nestjs/jwt'
import { PassportModule } from '@nestjs/passport'
import { AuthService } from './auth.service.js'
import { AuthController } from './auth.controller.js'
import { JwtStrategy } from './strategies/jwt.strategy.js'
import { LocalStrategy } from './strategies/local.strategy.js'
import { UsersModule } from '../users/users.module.js'

@Module({
  imports: [
    UsersModule,
    PassportModule.register({ defaultStrategy: 'jwt', session: false }),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('JWT_SECRET'),
        signOptions: {
          algorithm: 'HS256',
          issuer: config.getOrThrow<string>('JWT_ISSUER'),
          audience: config.getOrThrow<string>('JWT_AUDIENCE'),
          expiresIn: '15m',
        },
        verifyOptions: {
          algorithms: ['HS256'],
          issuer: config.getOrThrow<string>('JWT_ISSUER'),
          audience: config.getOrThrow<string>('JWT_AUDIENCE'),
          clockTolerance: 5,
        },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, LocalStrategy, JwtStrategy],
  exports: [JwtModule],
})
export class AuthModule {}
```

`getOrThrow` is the point of the exercise: a missing `JWT_SECRET` kills the process at boot instead of producing tokens signed with `undefined`. See [Configuration](../nestjs/configuration.md) for the schema that guarantees it is present and long enough.

`JwtModuleOptions` in 12.0.1 carries `secret`, `publicKey`, `privateKey`, `secretOrPrivateKey`, `secretOrKeyProvider`, `signOptions`, `verifyOptions` and `global`. For asymmetric signing, set `privateKey` and `publicKey` and put `algorithm: 'RS256'` in `signOptions`; `secretOrKeyProvider` is the hook for a key that must be fetched per request, such as a rotating KMS key.

:::danger Always pass `algorithms` on verify
`JwtService.verify()` delegates to `jsonwebtoken`. Without an `algorithms` list, verification honours whichever algorithm the *token's own header* names. On an RS256 setup that is the classic confusion attack: the attacker takes your public key — which is public — signs a token with `alg: HS256` using that key as the HMAC secret, and your server verifies it as genuine because it "knows" that key.

Put `algorithms` in the module's `verifyOptions` **and** in every strategy's options, so no call site can forget it. The full catalogue of ways this goes wrong is in [JWT pitfalls](../nestjs-security/jwt-pitfalls.md).
:::

`issuer` and `audience` matter for the same reason. A signature check answers "was this signed by a key I trust", not "was this meant for me" — without `aud`, a token minted for staging verifies in production.

## Password verification with argon2

Before any strategy, the credential check. Hash with `argon2id`; the parameter-tuning method, the PHC string format, `needsRehash`, and the bcrypt fallback are all in [Password hashing](../express-libraries/password-hashing.md) and are not repeated here.

```ts title="src/auth/password.service.ts"
import { Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import argon2 from 'argon2'
import type { HashOptions } from 'argon2'

const OPTIONS: HashOptions = {
  type: argon2.argon2id,
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 4,
}

@Injectable()
export class PasswordService {
  // A real argon2id digest of a random string, generated once and held in
  // config. Verifying against it makes the "no such user" path cost the same
  // as the "wrong password" path.
  private readonly dummyHash: string

  constructor(config: ConfigService) {
    this.dummyHash = config.getOrThrow<string>('AUTH_DUMMY_HASH')
  }

  hash(plain: string): Promise<string> {
    return argon2.hash(plain, OPTIONS)
  }

  async verify(storedHash: string | undefined, plain: string): Promise<boolean> {
    if (!storedHash) {
      await argon2.verify(this.dummyHash, plain)
      return false
    }
    return argon2.verify(storedHash, plain)
  }

  needsRehash(storedHash: string): boolean {
    return argon2.needsRehash(storedHash, OPTIONS)
  }
}
```

The dummy-hash branch is not decoration. Without it, an unknown email returns in under a millisecond and a known email takes 60 — which is a user-enumeration oracle you can drive from a script.

## `LocalStrategy` — the credential exchange

`PassportStrategy(Strategy)` returns a base class whose constructor forwards to the underlying Passport strategy and whose abstract `validate()` you implement. Whatever `validate()` returns becomes `request.user`; throwing rejects.

```ts title="src/auth/strategies/local.strategy.ts"
import { Injectable, UnauthorizedException } from '@nestjs/common'
import { PassportStrategy } from '@nestjs/passport'
import { Strategy } from 'passport-local'
import { AuthService } from '../auth.service.js'
import type { AuthenticatedUser } from '../auth.types.js'

@Injectable()
export class LocalStrategy extends PassportStrategy(Strategy, 'local') {
  private readonly auth: AuthService

  constructor(auth: AuthService) {
    super({ usernameField: 'email', passwordField: 'password', session: false })
    this.auth = auth
  }

  async validate(email: string, password: string): Promise<AuthenticatedUser> {
    const user = await this.auth.validateCredentials(email, password)
    if (!user) {
      throw new UnauthorizedException('Invalid credentials', { errorCode: 'INVALID_CREDENTIALS' })
    }
    return user
  }
}
```

Two details that trip people up:

- **`super()` must be called before `this`.** The options object goes to `passport-local`; Nest's mixin passes it straight through. Assigning injected dependencies to fields happens after.
- **The second argument to `PassportStrategy` is the strategy name.** Omit it and Passport uses the strategy's own default name (`'local'`, `'jwt'`). Name it explicitly when you register two strategies of the same type — an access-token strategy and a refresh-token strategy, say.

The `AuthenticatedUser` you return should be the minimum the rest of the request needs: an id, a tenant, a role set. Do not return the row with the password hash in it — `request.user` gets serialized into logs and, on a session flow, into the session store.

## `JwtStrategy` — the per-request check

```ts title="src/auth/strategies/jwt.strategy.ts"
import { Injectable, UnauthorizedException } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { PassportStrategy } from '@nestjs/passport'
import { ExtractJwt, Strategy } from 'passport-jwt'
import { UsersService } from '../../users/users.service.js'
import type { AuthenticatedUser } from '../auth.types.js'

interface AccessTokenClaims {
  sub: string
  tenantId: string
  tokenVersion: number
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  private readonly users: UsersService

  constructor(config: ConfigService, users: UsersService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: config.getOrThrow<string>('JWT_SECRET'),
      algorithms: ['HS256'],
      issuer: config.getOrThrow<string>('JWT_ISSUER'),
      audience: config.getOrThrow<string>('JWT_AUDIENCE'),
      ignoreExpiration: false,
    })
    this.users = users
  }

  async validate(claims: AccessTokenClaims): Promise<AuthenticatedUser> {
    const user = await this.users.findActiveById(claims.sub)
    if (!user || user.tokenVersion !== claims.tokenVersion) {
      throw new UnauthorizedException('Token is no longer valid', { errorCode: 'TOKEN_REVOKED' })
    }
    return { id: user.id, tenantId: user.tenantId, roles: user.roles }
  }
}
```

`validate()` runs **after** the signature, `exp`, `iss` and `aud` have all been checked. That is why it is the right place for the checks a signature cannot make:

| Check | Why the signature does not cover it |
| --- | --- |
| the user still exists | a deleted user's token stays valid until `exp` |
| the account is not suspended | same |
| `tokenVersion` matches | bumping the stored version invalidates every outstanding token for that user, which is the cheapest revocation you can build |

That lookup costs a database round trip per request. If it shows up in your latency budget, cache it — but cache it with a short TTL and invalidate on the write path, because a stale cache here is a revoked user who is still logged in. See [Caching](cache-manager.md).

:::warning
`ignoreExpiration: true` exists and is almost never what you want. The one legitimate use is a refresh endpoint that deliberately accepts an expired access token alongside a valid refresh token — and even there, a separate strategy reading the refresh token is cleaner.
:::

## Guards

`AuthGuard(name)` builds a guard class for a registered strategy.

```ts title="src/auth/guards/jwt-auth.guard.ts"
import { Injectable } from '@nestjs/common'
import type { ExecutionContext } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { AuthGuard } from '@nestjs/passport'
import { IS_PUBLIC_KEY } from '../decorators/public.decorator.js'

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  private readonly reflector: Reflector

  constructor(reflector: Reflector) {
    super()
    this.reflector = reflector
  }

  canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ])
    if (isPublic) return true
    return super.canActivate(context)
  }
}
```

```ts title="src/app.module.ts"
import { Module } from '@nestjs/common'
import { APP_GUARD } from '@nestjs/core'
import { JwtAuthGuard } from './auth/guards/jwt-auth.guard.js'

@Module({
  providers: [{ provide: APP_GUARD, useClass: JwtAuthGuard }],
})
export class AppModule {}
```

Registering it under `APP_GUARD` makes authentication the default and `@Public()` the exception, which is the only ordering that fails safe. The opposite — decorating every protected route — means a new controller is unprotected until somebody remembers.

:::danger
`@Public()` is opt-out security. Grep for it in CI and fail the build when it lands on a route outside an approved list. The failure mode is silent: the endpoint works perfectly, for everybody.
:::

`AuthGuard` also exposes `handleRequest(err, user, info, context)` as an override point. Use it when you want a specific message for an expired token rather than a blanket 401:

```ts title="src/auth/guards/jwt-auth.guard.ts"
import { UnauthorizedException } from '@nestjs/common'
import { TokenExpiredError } from '@nestjs/jwt'

// inside JwtAuthGuard
handleRequest<TUser = unknown>(err: unknown, user: TUser, info: unknown): TUser {
  if (info instanceof TokenExpiredError) {
    throw new UnauthorizedException('Access token expired', { errorCode: 'TOKEN_EXPIRED' })
  }
  if (err || !user) {
    throw new UnauthorizedException('Unauthorized', { errorCode: 'UNAUTHORIZED' })
  }
  return user
}
```

Distinguishing *expired* from *invalid* is worth doing — it is the signal that tells a client to refresh instead of logging the user out. Do not go further than that: "invalid signature" versus "malformed" tells an attacker which half of their forgery to fix.

`@nestjs/jwt` re-exports `TokenExpiredError`, `NotBeforeError` and `JsonWebTokenError` from `jsonwebtoken`, so you do not import the underlying package to do this.

## Refresh tokens, rotation, and reuse detection

A 15-minute access token is only usable if something issues the next one. The rule that makes refresh tokens safe is **rotation**: every refresh consumes the presented token and issues a new one. The rule that makes rotation *detectable* is **reuse detection**: if a token that was already consumed shows up again, the whole family is compromised — revoke all of it.

Store refresh tokens server-side. A stateless refresh token is a long-lived credential you cannot take back.

```ts title="src/auth/refresh-token.service.ts"
import { Injectable, UnauthorizedException } from '@nestjs/common'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { RefreshTokenRepository } from './refresh-token.repository.js'

const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

@Injectable()
export class RefreshTokenService {
  private readonly repo: RefreshTokenRepository

  constructor(repo: RefreshTokenRepository) {
    this.repo = repo
  }

  async issue(userId: string, familyId = randomUUID()) {
    const token = randomBytes(32).toString('base64url')
    await this.repo.insert({
      tokenHash: sha256(token),
      userId,
      familyId,
      expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
      usedAt: null,
    })
    return { token, familyId }
  }

  async rotate(presented: string) {
    const record = await this.repo.findByHash(sha256(presented))

    if (!record || record.expiresAt.getTime() < Date.now()) {
      throw new UnauthorizedException('Invalid refresh token', { errorCode: 'INVALID_REFRESH_TOKEN' })
    }

    // Reuse detection: this token was already exchanged. Either the client
    // replayed it or somebody stole it. Both mean the family is untrustworthy.
    if (record.usedAt !== null) {
      await this.repo.revokeFamily(record.familyId)
      throw new UnauthorizedException('Refresh token reuse detected', { errorCode: 'REFRESH_REUSE' })
    }

    const consumed = await this.repo.markUsedIfUnused(record.tokenHash)
    if (!consumed) {
      // Two requests raced; exactly one wins the conditional update.
      throw new UnauthorizedException('Invalid refresh token', { errorCode: 'INVALID_REFRESH_TOKEN' })
    }

    return this.issue(record.userId, record.familyId)
  }
}
```

Four things are load-bearing:

- **Store a hash, never the token.** A leaked database dump then yields no usable credentials. `sha256` is enough here because the token is 256 bits of CSPRNG output — there is nothing to brute-force. (That is exactly why a *password* needs argon2 and this does not.)
- **`markUsedIfUnused` must be a conditional update**, not a read-then-write. `UPDATE … SET used_at = now() WHERE token_hash = $1 AND used_at IS NULL` returning a row count is atomic; a read followed by a write lets two concurrent refreshes both succeed and both mint a family.
- **`familyId` ties the chain together.** Revoking the family is what turns a stolen token into a single failed request instead of indefinite access.
- **`randomBytes(32)`, not a JWT.** There is nothing to carry in the payload, and an opaque token cannot be parsed for information by whoever gets hold of it.

The refresh endpoint itself:

```ts title="src/auth/auth.controller.ts"
import { Body, Controller, HttpCode, Post } from '@nestjs/common'
import { Public } from './decorators/public.decorator.js'
import { AuthService } from './auth.service.js'

@Controller('auth')
export class AuthController {
  private readonly auth: AuthService

  constructor(auth: AuthService) {
    this.auth = auth
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  refresh(@Body('refreshToken') refreshToken: string) {
    return this.auth.refresh(refreshToken)
  }
}
```

:::best-practice
Rate limit `POST /auth/refresh` as hard as you rate limit login. Reuse detection turns a stolen token into one failure; a rate limiter is what stops somebody probing for one. See [Rate limiting with Throttler](throttler.md).
:::

For a browser client, put the refresh token in an `httpOnly`, `Secure`, `SameSite=Strict` cookie scoped to the refresh path, and keep the access token in memory only. That way an XSS cannot read either one directly.

## The session alternative

For a first-party browser application, a server-side session is usually the better answer, and Nest does not change that calculus. Revocation that actually works on logout beats statelessness at almost every scale.

`express-session` **1.19.0** is ordinary Express middleware, applied in `main.ts`:

```ts title="src/main.ts"
import { NestFactory } from '@nestjs/core'
import { ConfigService } from '@nestjs/config'
import session from 'express-session'
import passport from 'passport'
import helmet from 'helmet'
import { AppModule } from './app.module.js'

async function bootstrap() {
  const app = await NestFactory.create(AppModule)
  const config = app.get(ConfigService)

  app.set('trust proxy', 1)
  app.use(helmet())
  app.use(
    session({
      store: buildSessionStore(config),
      name: 'sid',
      secret: config.getOrThrow<string>('SESSION_SECRET'),
      resave: false,
      saveUninitialized: false,
      rolling: true,
      proxy: true,
      cookie: {
        httpOnly: true,
        secure: config.get('NODE_ENV') === 'production',
        sameSite: 'lax',
        maxAge: 24 * 60 * 60 * 1000,
        path: '/',
      },
    }),
  )
  app.use(passport.initialize())
  app.use(passport.session())

  await app.listen(config.getOrThrow<number>('PORT'))
}

bootstrap()
```

`app.set('trust proxy', 1)` reaches the underlying Express instance; `@nestjs/platform-express` 12.0.1 bundles `express` 5.2.1, so every option behaves exactly as documented in [Authentication](../express-libraries/authentication.md) — including the `MemoryStore` warning, which you must not ignore.

With sessions you also need a `PassportSerializer`:

```ts title="src/auth/session.serializer.ts"
import { Injectable } from '@nestjs/common'
import { PassportSerializer } from '@nestjs/passport'
import { UsersService } from '../users/users.service.js'

@Injectable()
export class SessionSerializer extends PassportSerializer {
  private readonly users: UsersService

  constructor(users: UsersService) {
    super()
    this.users = users
  }

  serializeUser(user: { id: string }, done: (err: Error | null, id: string) => void) {
    done(null, user.id)
  }

  async deserializeUser(id: string, done: (err: Error | null, user: unknown) => void) {
    try {
      done(null, await this.users.findActiveById(id))
    } catch (error) {
      done(error as Error, null)
    }
  }
}
```

Serialize the **id**, not the user. A role cached in the session goes stale the moment it changes, and a demoted admin stays an admin until they log out.

| | Session | JWT |
| --- | --- | --- |
| Revocation | delete the record — immediate | needs `tokenVersion`, a deny-list, or waiting for `exp` |
| Store dependency | hard: Redis down means nobody logs in | none on the hot path |
| Cross-origin clients | `SameSite=None; Secure` plus CORS credentials | header travels anywhere |
| CSRF | applies — the cookie is sent automatically | does not, for a `Authorization` header |
| Best for | a browser app you own end to end | mobile, service-to-service, federated identity |

## Security considerations

**Pin `algorithms` on every verify path** — the module's `verifyOptions`, every `JwtStrategy`, and any direct `jwtService.verify()` call. One omission is an algorithm-confusion hole.

**Verify `iss` and `aud`, and set `expiresIn`.** A token without an expiry is a permanent credential you cannot withdraw. Fifteen minutes for an access token.

**Keep authorization data out of the token, or accept the staleness.** A `roles` claim means a revoked permission stays live until `exp`. The `tokenVersion` check in `validate()` is the cheap middle ground; the expensive-but-correct answer is reading permissions on the requests that matter. See [Authorization](authorization.md).

**Return one error for bad credentials, at one speed.** Different messages for "no such user" and "wrong password" enumerate your users; different response *times* do the same thing more quietly. The dummy-hash branch above closes the timing half.

**Rotate refresh tokens and detect reuse.** Rotation without reuse detection means a stolen token works right up until the victim next refreshes, and nobody ever finds out.

**Hash refresh tokens at rest, and store only the hash.** Same reasoning as passwords, without the brute-force cost, because the token is already high-entropy.

**Regenerate the session ID on login and on privilege change.** `passport.authenticate('local')` calls `req.logIn()`, which regenerates for you; a hand-rolled session login must call `req.session.regenerate()` itself, and must set session data *after* it.

**Never put a token or session ID in a URL.** It leaks through `Referer`, proxy logs, and browser history.

**Rate limit login, refresh, password reset and MFA verification.** See [Rate limiting and abuse](../nestjs-security/rate-limiting.md).

**Secrets are at least 32 random bytes, from the environment, validated at boot.** A guessable `JWT_SECRET` makes every other control here irrelevant — [Secrets and config validation](../nestjs-security/secrets-and-config.md).

**Do not log `request.user`, tokens, or the session ID.** See [Safe logging](../nestjs-security/safe-logging.md).

## Production considerations

**Key rotation needs two keys live at once.** For HMAC, `secretOrKeyProvider` can return the current signing secret while verification tries an array of accepted secrets. For RSA/EC, publish both public keys through the rotation window and route on `kid`.

**Clock skew across hosts is real.** `clockTolerance: 5` (seconds) absorbs it. Without it, a machine 3 seconds fast rejects freshly minted tokens.

**The `validate()` database lookup is on every authenticated request.** Budget for it, or cache it with a short TTL and an explicit invalidation on suspend/delete. Measure before you cache — one indexed primary-key lookup is often cheaper than the cache round trip.

**Refresh-token rows accumulate.** Expire them with a scheduled job or a database TTL; see [Scheduling](schedule.md). An unbounded `refresh_tokens` table is a slow-motion outage.

**Behind TLS termination, `secure: true` cookies need `trust proxy`.** Without it Express sees a plain HTTP connection from the load balancer and refuses to set the cookie at all. The symptom is "login works locally, silently does nothing in production".

**A session store is a hard dependency.** If Redis is unreachable, nobody authenticates. Health-check it as a readiness signal, not a liveness one — see [Health checks with Terminus](terminus.md).

**Log authentication events**, with a user id and request id: success, failure, logout, password change, refresh reuse detection. Never with the credential.

**Watch the token size.** Claims are sent on every request; a 2 KB token across a mobile connection is noticeable, and some proxies cap header size near 8 KB.

## Common mistakes

- **Omitting `algorithms` on verify.** Algorithm confusion in one missing option.
- **Skipping `issuer` / `audience`.** A staging token, or another tenant's token from a shared identity provider, verifies against production.
- **No `expiresIn`.** A token that never expires cannot be revoked.
- **A stateless refresh token.** Long-lived, unrevocable, and indistinguishable from a stolen one.
- **Rotation without reuse detection.** The theft is never discovered.
- **Storing refresh tokens in plaintext.** A database dump becomes a set of live sessions.
- **Read-then-write on the refresh row.** Two concurrent refreshes both succeed and the family splits.
- **Returning the full user row from `validate()`.** The password hash then lives on `request.user` and reaches logs and session stores.
- **Putting roles in the access token and never re-checking.** Revocation does nothing until expiry.
- **`ignoreExpiration: true` on the access-token strategy.** Expiry stops meaning anything.
- **`@UseGuards(new JwtAuthGuard())`.** An instance you construct yourself gets no injection, so `Reflector` is `undefined` and `@Public()` silently stops working.
- **Registering the authorization guard before the authentication guard.** Multiple `APP_GUARD` providers run in declaration order; the second one reads a `request.user` that does not exist yet.
- **Forgetting `super()` before `this` in a strategy constructor.** A runtime `ReferenceError` at boot, not a type error.
- **Relying on `@Public()` with no audit.** One missing decorator is an open endpoint and nothing fails.
- **Running `MemoryStore` for sessions in production.** Leaks memory, breaks with more than one replica, loses everything on deploy.
- **Different responses or different timings for unknown user and wrong password.** User enumeration.

## Related topics

- [Authorization](authorization.md) — what the authenticated principal is allowed to do.
- [Guards](../nestjs-request-handling/guards.md) — the pipeline stage `AuthGuard` plugs into, and why `return false` is always 403.
- [JWT pitfalls](../nestjs-security/jwt-pitfalls.md) — algorithm confusion, `kid` injection and revocation, with exploits.
- [Authentication and session security](../nestjs-security/authentication-and-session-security.md) — fixation, hijacking and the full session threat model.
- [Password hashing](../express-libraries/password-hashing.md) — argon2id parameters, tuning, and `needsRehash`.
- [Authentication](../express-libraries/authentication.md) — the framework-independent mechanics these packages wrap.
- [Configuration](../nestjs/configuration.md) — validating `JWT_SECRET` at boot instead of discovering it is missing at runtime.
- [Rate limiting with Throttler](throttler.md) — protecting the login and refresh endpoints.
- [Caching](cache-manager.md) — caching the per-request user lookup safely.
- [Scheduling](schedule.md) — expiring stale refresh-token rows.
- [Secrets and config validation](../nestjs-security/secrets-and-config.md) — where the signing key comes from.
- [Safe logging](../nestjs-security/safe-logging.md) — keeping tokens and session IDs out of the log platform.
