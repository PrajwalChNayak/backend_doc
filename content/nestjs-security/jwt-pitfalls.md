---
title: JWT pitfalls
description: Algorithm confusion, jwt.decode() used for trust, missing exp/iss/aud, weak HS256 secrets and the revocation problem — in NestJS 12 with @nestjs/jwt 12.0.1, shown as forged tokens accepted and then rejected.
status: current
updated: 2026-09-11
---

A JWT is a signed claim that your application treats as the truth about who is calling. Every failure on this page comes from the same root: something accepted a token without checking the one property that makes it worth anything. `@nestjs/jwt` **12.0.1** wraps `jsonwebtoken` **9.0.3**, which has closed two of the classic holes at the library level — so this page is precise about which forgeries still work against a Nest 12 application and which do not.

The token format, the JWKS mechanics and the browser-storage debate are covered in [JWT pitfalls](../security/jwt-pitfalls.md). The wiring — `JwtModule`, `JwtStrategy`, refresh rotation — is in [Authentication](../nestjs-libraries/authentication.md). This page is the failure modes.

## What `@nestjs/jwt` 12.0.1 actually runs

Read from the package's own `dependencies`, not assumed:

```json title="node_modules/@nestjs/jwt/package.json"
{ "dependencies": { "jsonwebtoken": "9.0.3", "@types/jsonwebtoken": "9.0.10" } }
```

`JwtService.verify()` and `verifyAsync()` call `jsonwebtoken.verify()` with the module's `verifyOptions` merged under any per-call options. `JwtService.decode()` calls `jsonwebtoken.decode()` and **verifies nothing**. That distinction is the whole page.

## `alg: none`

### The threat

The JWT header names its own algorithm. `{"alg":"none"}` with an empty signature says "this token is unsigned, trust it anyway". A verifier that honours the header has no authentication at all — an attacker mints any claims they like.

### The exploit

```bash
HEADER=$(printf '{"alg":"none","typ":"JWT"}' | basenc --base64url | tr -d '=')
PAYLOAD=$(printf '{"sub":"u-1","email":"attacker@example.test","role":"admin","iat":1789000000}' \
  | basenc --base64url | tr -d '=')
FORGED="$HEADER.$PAYLOAD."

curl -s -H "authorization: Bearer $FORGED" localhost:3000/admin/users
```

### What actually happens in Nest 12

```json title="401 Unauthorized"
{ "message": "Unauthorized", "statusCode": 401 }
```

```text title="server log"
JsonWebTokenError: jwt signature is required
```

`jsonwebtoken` 9.0.3 refuses an unsigned token whenever a key is configured, and refuses it even with no key unless you literally pass `algorithms: ['none']`. There is no combination of `JwtModule` options that accepts `alg: none` by accident — you have to ask for it in writing.

:::danger The one way to re-open it
```ts vulnerable title="DO NOT COPY — src/app.module.ts"
JwtModule.register({
  secret: process.env.JWT_SECRET,
  // 'none' in the list is a complete authentication bypass.
  verifyOptions: { algorithms: ['none', 'HS256'] },
})
```
:::

So treat `alg: none` as a regression test rather than a live threat: assert the 401 in your suite, and grep your codebase for `'none'` in any algorithm list.

## Algorithm confusion

### The threat

An RS256 deployment publishes its public key. If the verifier can be persuaded to treat that public key as an **HMAC secret**, the attacker signs `HS256` tokens with a value they already have. This is the forgery that has broken real production systems, and it is the reason "always pin `algorithms`" is the rule.

### The exploit

```bash
# The public key is public — fetch it from wherever you publish it.
curl -s localhost:3000/.well-known/jwt-public-key.pem -o pub.pem

# Sign a token with HS256 using the PEM bytes as the shared secret.
node -e '
const jwt = require("jsonwebtoken")
const key = require("fs").readFileSync("pub.pem", "utf8")
console.log(jwt.sign({ sub: "u-1", role: "admin" }, key, { algorithm: "HS256", expiresIn: "1h" }))
' > forged.jwt

curl -s -H "authorization: Bearer $(cat forged.jwt)" localhost:3000/admin/users
```

### What happens with a plain `publicKey`

```json title="401 Unauthorized"
{ "message": "Unauthorized", "statusCode": 401 }
```

```text title="server log"
JsonWebTokenError: secretOrPublicKey must be a symmetric key when using HS256
```

When `JwtModule` is given a `publicKey`, `jsonwebtoken` derives the permitted algorithms from the key type — an RSA key means `RS*`/`PS*` only — and separately refuses an `HS*` header against a non-secret key. Two independent checks, both in the library.

### Where it is still exploitable

The derivation depends on the library seeing the key. `secretOrKeyProvider` takes that away: it hands you the raw token and asks you which key to use.

:::danger A key provider that trusts the token's own header
```ts vulnerable title="DO NOT COPY — src/app.module.ts"
import { JwtModule, JwtSecretRequestType } from '@nestjs/jwt'

JwtModule.register({
  // On VERIFY, `tokenOrPayload` is the raw token string the attacker sent.
  secretOrKeyProvider: (requestType, tokenOrPayload) => {
    if (requestType === JwtSecretRequestType.SIGN) return PRIVATE_KEY

    // Decoding the attacker's header to choose the key is the bug. A header of
    // {"alg":"HS256"} now selects the symmetric branch, and the attacker has
    // the value in SHARED_SECRET or, worse, the public key is used as one.
    const header = JSON.parse(Buffer.from(String(tokenOrPayload).split('.')[0], 'base64url').toString())
    return header.alg.startsWith('HS') ? SHARED_SECRET : PUBLIC_KEY
  },
})
```

Any provider that reads `alg` from the untrusted header to pick a key has reimplemented algorithm confusion by hand. The same applies to a `kid` lookup that does not constrain the resulting key's type — see [JWT pitfalls](../security/jwt-pitfalls.md) for the JWKS variant.
:::

### The fix: pass `algorithms` on every verify path

Pinning the algorithm list removes the dependency on key-type derivation entirely. It is one option, and it belongs in three places.

**One — the module.** `verifyOptions` applies to every `JwtService.verify()` and `verifyAsync()` call, because `JwtService` merges per-call options *over* the module defaults, so the pin survives unless a caller deliberately replaces it.

```ts good title="src/auth/auth.module.ts"
import { Module } from '@nestjs/common'
import { ConfigModule, ConfigService } from '@nestjs/config'
import { JwtModule } from '@nestjs/jwt'

@Module({
  imports: [
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        privateKey: config.getOrThrow<string>('JWT_PRIVATE_KEY'),
        publicKey: config.getOrThrow<string>('JWT_PUBLIC_KEY'),
        signOptions: {
          algorithm: 'RS256',
          expiresIn: '15m',
          issuer: 'https://api.example.test',
          audience: 'https://app.example.test',
        },
        verifyOptions: {
          // The pin. Without it the permitted set is derived from the key.
          algorithms: ['RS256'],
          issuer: 'https://api.example.test',
          audience: 'https://app.example.test',
          clockTolerance: 5,
        },
      }),
    }),
  ],
})
export class AuthModule {}
```

**Two — the Passport strategy.** `passport-jwt` 4.0.1 has its own options object and does not see `JwtModule`'s at all. A pinned module plus an unpinned strategy is an unpinned application.

```ts good title="src/auth/strategies/jwt.strategy.ts"
import { Injectable, UnauthorizedException } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { PassportStrategy } from '@nestjs/passport'
import { ExtractJwt, Strategy } from 'passport-jwt'
import { UsersService } from '../../users/users.service.js'

interface AccessTokenClaims {
  sub: string
  tokenVersion: number
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  private readonly users: UsersService

  constructor(config: ConfigService, users: UsersService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: config.getOrThrow<string>('JWT_PUBLIC_KEY'),
      algorithms: ['RS256'],                       // pinned here too
      issuer: 'https://api.example.test',
      audience: 'https://app.example.test',
      ignoreExpiration: false,                     // the default; state it anyway
    })
    this.users = users
  }

  async validate(claims: AccessTokenClaims) {
    const user = await this.users.findActiveById(claims.sub)
    if (!user || user.tokenVersion !== claims.tokenVersion) {
      throw new UnauthorizedException()
    }
    return { id: user.id, role: user.role }
  }
}
```

**Three — any direct call.** A guard or interceptor that calls `jwtService.verifyAsync(token, { … })` must not drop the list:

```ts good title="src/auth/guards/jwt-auth.guard.ts"
import { Injectable, UnauthorizedException } from '@nestjs/common'
import type { CanActivate, ExecutionContext } from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import type { Request } from 'express'

@Injectable()
export class JwtAuthGuard implements CanActivate {
  private readonly jwt: JwtService

  constructor(jwt: JwtService) {
    this.jwt = jwt
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>()
    const header = request.headers.authorization ?? ''
    const [scheme, token] = header.split(' ')

    if (scheme !== 'Bearer' || !token) throw new UnauthorizedException()

    try {
      // Options passed here are merged OVER the module's verifyOptions, so the
      // module-level pin survives. Repeating it makes that independent of
      // whatever someone later changes in the module.
      request.user = await this.jwt.verifyAsync(token, {
        algorithms: ['RS256'],
        issuer: 'https://api.example.test',
        audience: 'https://app.example.test',
      })
    } catch {
      // Never echo the library error: "jwt expired" and "invalid signature"
      // tell an attacker which half of the token to work on.
      throw new UnauthorizedException()
    }
    return true
  }
}
```

:::best-practice
Prefer `RS256` with `privateKey`/`publicKey` over a shared `secret` whenever more than one service verifies your tokens. Only the issuer needs the private key; every verifier gets a public key that cannot mint anything. With `HS256` every verifier is also a forger.
:::

## `decode()` is not verification

### The threat

`JwtService.decode()` base64-decodes the payload and returns it. It does not check the signature, the expiry, the issuer or the audience. Any code path that reads claims from `decode()` and acts on them accepts tokens the attacker wrote.

### The exploit

This is the forgery that *does* work, because it never reaches a verifier.

:::danger A guard built on `decode()`
```ts vulnerable title="DO NOT COPY — src/auth/guards/jwt-auth.guard.ts"
import { Injectable, UnauthorizedException } from '@nestjs/common'
import type { CanActivate, ExecutionContext } from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import type { Request } from 'express'

@Injectable()
export class JwtAuthGuard implements CanActivate {
  private readonly jwt: JwtService

  constructor(jwt: JwtService) {
    this.jwt = jwt
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>()
    const token = (request.headers.authorization ?? '').replace('Bearer ', '')

    // "We already verified it at the gateway." Nothing here checks anything.
    const claims = this.jwt.decode(token)
    if (!claims) throw new UnauthorizedException()

    request.user = claims
    return true
  }
}
```
:::

```bash
# No key needed. The signature is three bytes of garbage.
HEADER=$(printf '{"alg":"RS256","typ":"JWT"}' | basenc --base64url | tr -d '=')
PAYLOAD=$(printf '{"sub":"u-1","role":"admin","exp":9999999999}' | basenc --base64url | tr -d '=')
curl -s -H "authorization: Bearer $HEADER.$PAYLOAD.AAAA" localhost:3000/admin/users
```

```json title="200 OK — the attacker is an administrator"
[
  { "id": "u-771", "email": "dana@example.test", "role": "admin" },
  { "id": "u-772", "email": "ravi@example.test", "role": "user" }
]
```

### The fix

Replace `decode` with `verifyAsync` — the guard shown above under "any direct call" is the correct version of this same file. After the fix, the identical request:

```json title="401 Unauthorized"
{ "message": "Unauthorized", "statusCode": 401 }
```

`decode()` has exactly two legitimate uses, and neither is a trust decision:

- **Reading `kid` to select a verification key** — and the key you select must still be used by `verify`, with a pinned algorithm.
- **Client-side display**, such as showing the expiry in a debugging panel.

:::warning "The gateway already verified it"
This is the most common justification for `decode()` in a Nest service, and it is only true if the service is unreachable except through the gateway. In a Kubernetes cluster with a flat pod network it is not: anything that can open a socket to the pod skips the gateway. If you genuinely terminate verification at the edge, the service must reject requests that did not come from it — mutual TLS, a signed internal header, or a network policy — and that control has to be tested like any other.
:::

## Missing `exp`, `iss` and `aud`

`jsonwebtoken` checks `exp` only when the claim is present, and checks `iss`/`aud` only when you pass `issuer`/`audience` to verify. Omit the sign option and the claim never exists; omit the verify option and the claim is never read. Both omissions are silent.

:::danger A token with no expiry and no audience
```ts vulnerable title="DO NOT COPY — src/auth/auth.module.ts"
JwtModule.register({
  secret: process.env.JWT_SECRET,
  // No expiresIn: the token never expires.
  // No issuer/audience: any token signed with this secret is accepted.
  signOptions: {},
})
```
:::

Two distinct exploits come out of that one block.

**A token that never dies.** A token issued to a laptop in 2024, recovered from a log file or a backup, still authenticates today:

```bash
curl -s -H "authorization: Bearer $(cat old-token-from-2024.jwt)" localhost:3000/me
```

```json title="200 OK"
{ "id": "u-771", "email": "dana@example.test" }
```

**A token minted for something else.** Most organizations share one secret across more services than they think. A token your batch-job service issues to itself now authenticates against your customer API:

```bash
# Token minted by the internal reporting service, audience "reports", sub "svc-reports".
curl -s -H "authorization: Bearer $REPORTING_SERVICE_TOKEN" localhost:3000/admin/users
```

```json title="200 OK — a service token authenticating as a user"
[ { "id": "u-771", "email": "dana@example.test", "role": "admin" } ]
```

The fix is on both sides of the pair — the `AuthModule` block above sets all four. After it:

```json title="401 Unauthorized"
{ "message": "Unauthorized", "statusCode": 401 }
```

```text title="server log"
JsonWebTokenError: jwt audience invalid. expected: https://app.example.test
```

| Claim | Set with | Checked with | If you omit the verify option |
| --- | --- | --- | --- |
| `exp` | `signOptions.expiresIn` | automatic when present | never expires |
| `nbf` | `signOptions.notBefore` | automatic when present | — |
| `iss` | `signOptions.issuer` | `verifyOptions.issuer` | any issuer accepted |
| `aud` | `signOptions.audience` | `verifyOptions.audience` | any audience accepted |
| `sub` | your payload | `verifyOptions.subject` | any subject accepted |
| `iat` | automatic | `verifyOptions.maxAge` | age never bounded |

:::warning `ignoreExpiration: true` is never a fix
It shows up when a refresh endpoint needs to read the subject from an expired access token. Do not. Refresh against the refresh token, which has its own server-side record; see [Authentication](../nestjs-libraries/authentication.md).
:::

## Weak HS256 secrets

### The threat

An HS256 signature is an HMAC. Anybody holding a token can brute-force the secret **offline** — no requests to your server, no rate limit, no log line. A dictionary word falls in seconds; `secret` and `changeme` are in every wordlist ever published.

### The exploit

```bash
hashcat -m 16500 token.jwt rockyou.txt
```

```text
eyJhbGciOiJIUzI1NiIs...:supersecret
Session..........: hashcat
Status...........: Cracked
Time.Started.....: 3 secs
```

With the secret, the attacker mints tokens indistinguishable from yours — any subject, any role, any expiry.

### The fix

```bash
# 32 bytes of CSPRNG output, base64url. Nothing memorable, nothing derived.
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

And make a weak one impossible to deploy, by validating it at boot rather than trusting a code review:

```ts good title="src/config/validation.ts"
import { z } from 'zod'

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  // 43 base64url characters is 32 bytes. Anything shorter fails the deploy.
  JWT_SECRET: z.string().min(43),
  JWT_ISSUER: z.url(),
  JWT_AUDIENCE: z.url(),
})
```

```ts good title="src/app.module.ts"
import { Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { envSchema } from './config/validation.js'

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true, cache: true, validationSchema: envSchema })],
})
export class AppModule {}
```

A default value in code is the same bug with better manners:

:::danger A fallback secret
```ts vulnerable title="DO NOT COPY"
JwtModule.register({ secret: process.env.JWT_SECRET ?? 'dev-secret' })
```

Every environment where the variable is unset — a misconfigured container, a new region, a CI job that got promoted — signs with `dev-secret`, which is in your git history. `config.getOrThrow()` and a boot-time schema are the fix; see [Secrets and config validation](secrets-and-config.md).
:::

## You cannot revoke a JWT

### The threat

A verified token is valid until `exp`, full stop. Firing an employee, detecting a stolen device, demoting an admin, or a user changing their password all leave every outstanding token working. "Stateless authentication" means "no way to say no".

There are exactly three honest answers, and they trade off differently.

### 1. Short TTL plus refresh rotation with reuse detection

The access token expires in 15 minutes, so the revocation window is 15 minutes. The refresh token is opaque, stored server-side as a hash, single-use, and rotated on every exchange; presenting a consumed one revokes the whole family. This is the default answer and it is fully worked in [Authentication](../nestjs-libraries/authentication.md) — the `RefreshTokenService` there is the implementation.

The trade-off is that revocation is not immediate. For most applications 15 minutes is acceptable; for an admin console it is not.

### 2. A `jti` denylist

Give every token a unique `jti` and check it against a Redis set on each request. Immediate revocation, at the cost of a network round trip per request — which is most of what statelessness was buying you.

```ts good title="src/auth/token-denylist.service.ts"
import { Inject, Injectable } from '@nestjs/common'
import type Redis from 'ioredis'
import { REDIS } from '../redis/redis.module.js'

@Injectable()
export class TokenDenylistService {
  private readonly redis: Redis

  constructor(@Inject(REDIS) redis: Redis) {
    this.redis = redis
  }

  /**
   * The TTL is the token's own remaining lifetime, so the set never grows
   * beyond the tokens that could still be presented. `exp` is in seconds.
   */
  async revoke(jti: string, exp: number): Promise<void> {
    const ttlSeconds = Math.max(1, exp - Math.floor(Date.now() / 1000))
    await this.redis.set(`jwt:revoked:${jti}`, '1', 'EX', ttlSeconds)
  }

  async isRevoked(jti: string): Promise<boolean> {
    return (await this.redis.exists(`jwt:revoked:${jti}`)) === 1
  }
}
```

```ts good title="src/auth/guards/jwt-auth.guard.ts"
import { Injectable, UnauthorizedException } from '@nestjs/common'
import type { CanActivate, ExecutionContext } from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import type { Request } from 'express'
import { TokenDenylistService } from '../token-denylist.service.js'

interface AccessTokenClaims {
  sub: string
  jti: string
  exp: number
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  private readonly jwt: JwtService
  private readonly denylist: TokenDenylistService

  constructor(jwt: JwtService, denylist: TokenDenylistService) {
    this.jwt = jwt
    this.denylist = denylist
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>()
    const token = (request.headers.authorization ?? '').split(' ')[1]
    if (!token) throw new UnauthorizedException()

    let claims: AccessTokenClaims
    try {
      claims = await this.jwt.verifyAsync<AccessTokenClaims>(token, { algorithms: ['RS256'] })
    } catch {
      throw new UnauthorizedException()
    }

    // Signature first, denylist second. Checking the denylist on an unverified
    // token lets anyone probe your revocation set with forged jti values.
    if (await this.denylist.isRevoked(claims.jti)) throw new UnauthorizedException()

    request.user = { id: claims.sub }
    return true
  }
}
```

Set `jti` when signing: `this.jwt.signAsync(payload, { jwtid: randomUUID() })`.

:::warning The denylist must fail closed
If Redis is unreachable, `isRevoked()` throwing means requests fail — which is correct. A `catch { return false }` turns an outage into a window where every revoked token works again.
:::

### 3. A token version claim

Put an integer on the user row, copy it into the token, and compare on every request. One `UPDATE users SET token_version = token_version + 1` invalidates every token that user holds, everywhere, immediately.

```ts good title="src/auth/strategies/jwt.strategy.ts"
import { Injectable, UnauthorizedException } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { PassportStrategy } from '@nestjs/passport'
import { ExtractJwt, Strategy } from 'passport-jwt'
import { UsersService } from '../../users/users.service.js'

interface AccessTokenClaims {
  sub: string
  tokenVersion: number
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  private readonly users: UsersService

  constructor(config: ConfigService, users: UsersService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: config.getOrThrow<string>('JWT_PUBLIC_KEY'),
      algorithms: ['RS256'],
      issuer: 'https://api.example.test',
      audience: 'https://app.example.test',
    })
    this.users = users
  }

  async validate(claims: AccessTokenClaims) {
    const user = await this.users.findActiveById(claims.sub)

    // One comparison covers password change, forced logout, deactivation and
    // "log out everywhere" — all of them bump tokenVersion.
    if (!user || user.tokenVersion !== claims.tokenVersion) {
      throw new UnauthorizedException()
    }
    return { id: user.id, role: user.role }
  }
}
```

This is usually the best value: you were probably loading the user anyway to get a current role, and a stale role cached in a token is its own vulnerability.

| Approach | Revocation latency | Per-request cost | Granularity |
| --- | --- | --- | --- |
| Short TTL + refresh rotation | up to the access TTL | none | per session |
| `jti` denylist | immediate | one Redis read | per token |
| Token version claim | immediate | one user read (usually already happening) | per user |

:::best-practice Never cache the role in the token and trust it
A demoted admin keeps their access until the token expires. If the role is in the token at all, treat it as a hint for the UI and read the authoritative value in `validate()`.
:::

## Where the token lives in a browser

| Storage | Read by XSS | Sent automatically | CSRF applies |
| --- | --- | --- | --- |
| `localStorage` | **yes** | no | no |
| JavaScript memory only | only while the page runs | no | no |
| `httpOnly` cookie | no | **yes** | **yes** |

There is no free option. `localStorage` is directly readable by any script that lands on your origin, including one from a compromised dependency, and it persists across tabs and restarts. An `httpOnly` cookie is unreadable by script — but it travels on cross-site requests, which is precisely the condition that makes CSRF possible.

The usual answer for a first-party browser application:

- **Access token in memory only.** A JavaScript variable in the auth module, never persisted. An XSS can still use it while the page is open; it cannot exfiltrate it for later.
- **Refresh token in an `httpOnly; Secure; SameSite=Strict` cookie scoped to the refresh path.** It is only ever sent to one endpoint, and CSRF against that endpoint achieves nothing useful because the response body — the new access token — is unreadable to the attacker's page under the same-origin policy.
- **Then handle CSRF anyway** for every cookie-authenticated endpoint. See [CSRF](csrf.md).

If you put the whole access token in a cookie, you have chosen session-style authentication with extra parsing; consider using an actual session, which at least gives you revocation. See [Authentication and session security](authentication-and-session-security.md).

## Clock skew

`exp` and `nbf` are compared against the verifier's clock. Two machines a few seconds apart produce "jwt expired" on a token issued half a second ago, or `NotBeforeError` on a token that is perfectly valid. The symptom is a small, constant fraction of 401s that nobody can reproduce.

```ts good title="src/auth/auth.module.ts"
JwtModule.register({
  secret: process.env.JWT_SECRET as string,
  signOptions: { expiresIn: '15m' },
  verifyOptions: {
    algorithms: ['HS256'],
    // Seconds of tolerance on exp and nbf. Small, and a stopgap for NTP.
    clockTolerance: 5,
  },
})
```

Keep it at a handful of seconds. `clockTolerance: 300` extends the life of every revoked token by five minutes, which quietly widens the window that a short TTL exists to narrow. Run NTP; the tolerance is for jitter, not for a broken clock.

## Verifying

The suite below is the exploit list turned into assertions. Every one of them is a regression somebody will introduce.

```ts title="test/jwt.e2e-spec.ts"
import { Test } from '@nestjs/testing'
import { JwtService } from '@nestjs/jwt'
import request from 'supertest'
import { AppModule } from '../src/app.module.js'

const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url')

describe('JWT verification', () => {
  let app: import('@nestjs/common').INestApplication
  let jwt: JwtService

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = moduleRef.createNestApplication()
    await app.init()
    jwt = app.get(JwtService)
  })

  afterAll(() => app.close())

  const get = (token: string) =>
    request(app.getHttpServer()).get('/me').set('authorization', `Bearer ${token}`)

  it('accepts a token this application signed', async () => {
    const token = await jwt.signAsync({ sub: 'u-771', tokenVersion: 1 })
    await get(token).expect(200)
  })

  it('rejects an unsigned alg:none token', async () => {
    const forged = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub: 'u-771', role: 'admin' })}.`
    await get(forged).expect(401)
  })

  it('rejects a token with a garbage signature', async () => {
    const token = await jwt.signAsync({ sub: 'u-771', tokenVersion: 1 })
    await get(`${token.slice(0, -4)}AAAA`).expect(401)
  })

  it('rejects a token signed with the public key as an HMAC secret', async () => {
    const publicKey = process.env.JWT_PUBLIC_KEY as string
    const forged = await jwt.signAsync(
      { sub: 'u-771', role: 'admin' },
      { secret: publicKey, algorithm: 'HS256' },
    )
    await get(forged).expect(401)
  })

  it('rejects a token for another audience', async () => {
    const token = await jwt.signAsync({ sub: 'u-771' }, { audience: 'https://reports.example.test' })
    await get(token).expect(401)
  })

  it('rejects a token from another issuer', async () => {
    const token = await jwt.signAsync({ sub: 'u-771' }, { issuer: 'https://evil.example.test' })
    await get(token).expect(401)
  })

  it('rejects an expired token', async () => {
    const token = await jwt.signAsync({ sub: 'u-771', tokenVersion: 1 }, { expiresIn: '-1s' })
    await get(token).expect(401)
  })

  it('rejects a token whose tokenVersion is stale', async () => {
    const token = await jwt.signAsync({ sub: 'u-771', tokenVersion: 0 })
    await get(token).expect(401)
  })

  it('does not say why the token failed', async () => {
    const token = await jwt.signAsync({ sub: 'u-771', tokenVersion: 1 }, { expiresIn: '-1s' })
    const response = await get(token).expect(401)
    expect(JSON.stringify(response.body)).not.toContain('expired')
  })
})
```

The last assertion matters more than it looks. `jsonwebtoken` distinguishes `TokenExpiredError` from `JsonWebTokenError`, and a filter that forwards `error.message` tells an attacker whether they need a new signature or just a newer timestamp.

## Production considerations

- **Grep for `.decode(` in CI.** It is a one-line check that catches the only forgery on this page that actually succeeds.
- **Grep for `algorithms` too — as an absence.** Every `verifyOptions`, every `PassportStrategy(Strategy)` super call, and every direct `verifyAsync` should have one.
- **Publish the public key, rotate on a schedule.** With `RS256` and a `kid` header you can run two keys at once: sign with the new one, accept both, retire the old after the longest TTL has passed. See [Secrets and config validation](secrets-and-config.md).
- **Keep the payload small and public.** Everything in a JWT is base64, not encrypted. An email address in a token is an email address in every proxy log and browser cache.
- **Never log the token.** `Authorization` headers must be redacted before the request logger sees them. See [Safe logging](safe-logging.md).
- **Alert on verification failures by type.** A spike in `invalid signature` is somebody probing; a spike in `jwt expired` is usually your own clock or a client bug.
- **Bound the token size.** A JWT in a header is subject to your proxy's header limit; claims that grow with a user's permissions eventually produce a 431 for exactly the users with the most access.

## Common mistakes

- **`jwtService.decode()` anywhere a decision is made.** It verifies nothing; this is the forgery that works.
- **Trusting a gateway that the service is reachable around.** Verify at the service, or make the service unreachable by anything else and test that.
- **Omitting `algorithms` from `verifyOptions`.** The permitted set is then derived from the key, and any `secretOrKeyProvider` breaks that derivation.
- **Pinning `algorithms` on the module but not on the `JwtStrategy`.** `passport-jwt` has its own options object.
- **A `secretOrKeyProvider` that reads `alg` or `kid` from the untrusted header without constraining the key type.** Hand-rolled algorithm confusion.
- **`'none'` in an algorithm list.** The only way to accept an unsigned token, and it is a complete bypass.
- **No `expiresIn`.** The token is permanent, and permanent credentials end up in log files.
- **No `issuer`/`audience` on either side.** Every service sharing the secret can authenticate against every other.
- **A short, memorable, or hard-coded HS256 secret.** Cracked offline with no traffic to your server.
- **`secret: process.env.JWT_SECRET ?? 'dev-secret'`.** Ships to production as the fallback.
- **`ignoreExpiration: true` to make refresh work.** Refresh against the refresh token.
- **Believing a JWT can be revoked.** Pick short TTL, a `jti` denylist, or a token version — and write it down.
- **A denylist that fails open.** A Redis outage un-revokes every token.
- **Checking the denylist before the signature.** It turns your revocation set into a probe target.
- **Caching the role in the token and trusting it.** A demoted admin stays an admin until `exp`.
- **Storing the access token in `localStorage`.** Directly readable by any script that reaches your origin.
- **`clockTolerance` in the minutes.** It extends the life of every token you were trying to expire.
- **Forwarding `error.message` from a failed verification.** It tells the attacker which half of the token to fix.

## Related topics

- [JWT pitfalls](../security/jwt-pitfalls.md) — the framework-independent treatment, including JWKS, `kid` injection and claim design.
- [Authentication](../nestjs-libraries/authentication.md) — `JwtModule`, `JwtStrategy`, guards and the refresh-rotation service.
- [Authentication and session security](authentication-and-session-security.md) — the stateful alternative, where revocation is a delete.
- [CSRF](csrf.md) — the cost of putting the token in a cookie.
- [Authorization and IDOR](authorization-and-idor.md) — why a verified `sub` is only the beginning of the check.
- [Guards](../nestjs-request-handling/guards.md) — where verification runs in the request lifecycle.
- [Secrets and config validation](secrets-and-config.md) — making a weak or missing signing key impossible to deploy.
- [Safe logging](safe-logging.md) — keeping tokens out of logs and URLs.
- [Rate limiting and abuse](rate-limiting.md) — bounding the login endpoint that mints these tokens.
- [Microservices and transports](../nestjs-advanced/microservices.md) — service-to-service tokens and why the audience claim exists.
- [End-to-end tests](../nestjs-testing/e2e-tests.md) — the testing-module setup the suite uses.
