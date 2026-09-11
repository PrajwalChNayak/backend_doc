---
title: CSRF
description: When CSRF applies to a NestJS 12 API and when it does not, an auto-submitting exploit against a cookie-authenticated endpoint, and the fixes in order — SameSite, origin checks, and csrf-csrf 4.0.3 wired as Nest middleware.
status: current
updated: 2026-09-11
---

Cross-site request forgery needs one condition: the browser attaches your credential automatically. Nest changes nothing about the attack and quite a lot about the plumbing — where the middleware goes, why its rejection does not look like your other errors, and which of your endpoints are even in scope. This page is the Nest wiring; the attack mechanics, the `SameSite` semantics and the double-submit reasoning are in [CSRF](../security/csrf.md).

## Does this apply to your API?

Answer this before writing any code, because a CSRF token on a bearer-token API is pure cost.

| Your authentication | CSRF applies | Why |
| --- | --- | --- |
| `express-session` cookie | **yes** | the browser sends it on cross-site requests |
| Access token in an `httpOnly` cookie | **yes** | same reason; the token being a JWT changes nothing |
| Refresh token in a cookie, access token in a header | **yes, for the refresh endpoint** | that one endpoint is cookie-authenticated |
| `Authorization: Bearer` from JavaScript memory | no | a cross-site page cannot read the token or make the browser add the header |
| HTTP Basic, client certificates | **yes** | also ambient |

A pure bearer-token Nest API that sets no authentication cookie does not need any of the controls below. The moment one endpoint authenticates from a cookie — very commonly `POST /auth/refresh` — that endpoint is in scope even if the other ninety are not.

:::warning CORS does not prevent CSRF
This is the most persistent misconception in the area and it survives into Nest codebases because `app.enableCors()` feels like a security control. CORS decides whether the attacker's page may **read** your response. The forged request is still **sent** and the side effect still happens. A form POST with `application/x-www-form-urlencoded` is a simple request: no preflight is made, so there is no CORS check to fail before the write lands.

The narrow related effect — that a JSON-only endpoint cannot be targeted by a plain HTML form, because `application/json` triggers a preflight — is a bonus, not a control. It evaporates the moment any endpoint also accepts a form body, and Nest's `express.urlencoded()` is on by default. See [CORS](cors.md).
:::

## The threat

An authenticated user visits a page the attacker controls. That page issues a state-changing request to your API, and the browser attaches the session cookie. The attacker cannot read the response — they do not need to. They need the side effect: the email address on the account changed to theirs, at which point a password reset finishes the takeover.

## A concrete exploit

A perfectly ordinary Nest controller, cookie-authenticated, with validation and a guard:

:::danger A cookie-authenticated state change with no CSRF defense
```ts vulnerable title="DO NOT COPY — src/account/account.controller.ts"
import { Body, Controller, Patch, Req, UseGuards } from '@nestjs/common'
import type { Request } from 'express'
import { SessionAuthGuard } from '../auth/guards/session-auth.guard.js'
import { AccountService } from './account.service.js'
import { ChangeEmailDto } from './dto/change-email.dto.js'

@Controller('account')
@UseGuards(SessionAuthGuard)
export class AccountController {
  private readonly account: AccountService

  constructor(account: AccountService) {
    this.account = account
  }

  @Patch('email')
  changeEmail(@Body() dto: ChangeEmailDto, @Req() request: Request) {
    // The guard proved the session cookie is valid. Nothing proved the user
    // meant to send this request.
    return this.account.changeEmail(request.session.userId, dto.email)
  }
}
```
:::

The attacker's page. Note the `POST` with a method override, because a bare HTML form cannot issue `PATCH` — and Nest happily accepts the override if anybody enabled it, or the attacker simply targets whichever endpoint takes a `POST`:

```html title="hosted at https://evil.example — the victim sees a blank page"
<body onload="document.forms[0].submit()">
  <form action="https://api.example.test/account/email" method="POST">
    <input type="hidden" name="_method" value="PATCH" />
    <input type="hidden" name="email" value="attacker@evil.example" />
  </form>
</body>
```

Reproduced from a terminal, which is what the browser actually sends:

```bash
curl -s -X POST https://api.example.test/account/email \
  -H 'content-type: application/x-www-form-urlencoded' \
  -H 'origin: https://evil.example' \
  -b 'sid=s%3AOxq1...victim session...' \
  -d '_method=PATCH&email=attacker@evil.example'
```

```json title="200 OK — the account now belongs to the attacker"
{ "id": "u-771", "email": "attacker@evil.example" }
```

No preflight was made, no CORS header was consulted, and the guard did exactly what it was written to do.

:::deprecated `csurf` is archived — do not use it
Every tutorial result for "nestjs csrf" reaches for `csurf`. It has been archived and unmaintained for years and must not be added to a new project. `csrf-csrf` **4.0.3** is the maintained replacement and is what this page uses. A `SameSite` cookie plus an origin check is also a complete answer for many APIs; an abandoned package never is.
:::

## Fix 1 — `SameSite` on the session cookie

The highest-leverage change, because it defends every endpoint at once at the cookie layer rather than per route.

```ts good title="src/main.ts"
import { NestFactory } from '@nestjs/core'
import { ConfigService } from '@nestjs/config'
import session from 'express-session'
import { AppModule } from './app.module.js'

async function bootstrap() {
  const app = await NestFactory.create(AppModule)
  const config = app.get(ConfigService)

  app.set('trust proxy', 1)
  app.use(
    session({
      store: buildSessionStore(config),
      name: 'sid',
      secret: config.getOrThrow<string>('SESSION_SECRET'),
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        secure: true,
        // Blocks the cookie on the cross-site form POST above.
        sameSite: 'lax',
        path: '/',
        maxAge: 30 * 60 * 1000,
      },
    }),
  )

  await app.listen(config.getOrThrow<number>('PORT'))
}

bootstrap()
```

| Value | Blocks | Leaves open | Use for |
| --- | --- | --- | --- |
| `'lax'` | cross-site subrequests, including the form POST | top-level `GET` navigations; subdomains are same-site | the session cookie of a normal web app |
| `'strict'` | all cross-site requests, including a link from an email | nothing, at the cost of landing users logged-out from inbound links | a refresh-token cookie, an admin console |
| `'none'` | nothing | everything — requires `secure: true` | a genuinely cross-site API, which then needs tokens |

`'lax'` plus "no state change is ever reachable by `GET`" stops the classic attack. The second half is a Nest rule you can actually enforce: nothing behind `@Get()` may write.

:::warning Browser defaults are not your defense
Modern browsers treat a cookie with no `SameSite` attribute as `Lax`, which is why some applications appear safe without configuring anything. Set it explicitly: the default is a browser policy you do not control, older clients do not apply it, and non-browser clients ignore it entirely. Setting it also documents the intent for the next person.

`SameSite=Strict` on the refresh-token cookie specifically is nearly free — it is only ever sent to one endpoint your own application calls.
:::

## Fix 2 — origin checking, as a guard

`Origin` is set by the browser on every cross-origin write and cannot be forged from script. A guard is the natural home for the check in Nest: it runs after routing, so it sees the resolved handler, and it throws an ordinary `ForbiddenException` that your exception filters already format.

```ts good title="src/common/guards/origin.guard.ts"
import { ForbiddenException, Injectable } from '@nestjs/common'
import type { CanActivate, ExecutionContext } from '@nestjs/common'
import type { Request } from 'express'

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
const ALLOWED_ORIGINS = new Set(['https://app.example.test', 'https://admin.example.test'])

@Injectable()
export class OriginGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>()
    if (SAFE_METHODS.has(request.method)) return true

    const origin = request.headers.origin ?? this.originFromReferer(request.headers.referer)

    // A missing header is a decision, not a pass. Privacy tools strip Referer,
    // and some clients send neither — so reject, and treat the header-less
    // machine-to-machine callers as bearer-token clients instead.
    if (!origin || !ALLOWED_ORIGINS.has(origin)) {
      throw new ForbiddenException('Cross-origin request rejected')
    }
    return true
  }

  private originFromReferer(referer?: string): string | undefined {
    if (!referer) return undefined
    try {
      return new URL(referer).origin
    } catch {
      return undefined
    }
  }
}
```

Register it globally, after authentication, so an unauthenticated cross-site request still gets a 401 rather than leaking that the origin check exists:

```ts good title="src/app.module.ts"
import { Module } from '@nestjs/common'
import { APP_GUARD } from '@nestjs/core'
import { OriginGuard } from './common/guards/origin.guard.js'
import { SessionAuthGuard } from './auth/guards/session-auth.guard.js'

@Module({
  providers: [
    // Declaration order is execution order.
    { provide: APP_GUARD, useClass: SessionAuthGuard },
    { provide: APP_GUARD, useClass: OriginGuard },
  ],
})
export class AppModule {}
```

This is a strong second layer and a poor only layer: the reject-on-missing-header policy is what makes it meaningful, and that policy breaks legitimate clients that are not browsers. Pair it with `SameSite`.

## Fix 3 — a double-submit token with `csrf-csrf`

`csrf-csrf` **4.0.3** implements the signed double-submit pattern: a token is HMAC'd over a session identifier and a random value, stored in a cookie, and must be echoed back in a header. A cross-site page can cause the cookie to be sent but cannot read it, so it cannot produce the header.

```bash
npm install csrf-csrf@4.0.3 cookie-parser@1.4.7
npm install --save-dev @types/cookie-parser
```

The library needs `req.cookies`, so `cookie-parser` must run first.

```ts good title="src/csrf/csrf.config.ts"
import { doubleCsrf } from 'csrf-csrf'
import type { Request } from 'express'

export const {
  doubleCsrfProtection,
  generateCsrfToken,
  invalidCsrfTokenError,
} = doubleCsrf({
  // Rotate by putting the new secret first; both are accepted.
  getSecret: () => [process.env.CSRF_SECRET as string],

  // Binds the token to one session. Without a real identifier here, a token
  // minted for any user validates for any other.
  getSessionIdentifier: (request: Request) => request.session?.id ?? '',

  cookieName: process.env.NODE_ENV === 'production'
    ? '__Host-psifi.x-csrf-token'   // the default
    : 'x-csrf-token',               // no __Host- prefix over plain HTTP
  cookieOptions: {
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    path: '/',
  },
  getCsrfTokenFromRequest: (request: Request) => request.headers['x-csrf-token'],
})
```

Every default worth knowing, read from the shipped `doubleCsrf` implementation:

| Option | Default |
| --- | --- |
| `cookieName` | `'__Host-psifi.x-csrf-token'` |
| `cookieOptions` | `sameSite: 'strict'`, `secure: true`, `httpOnly: true`, `path: '/'` |
| `ignoredMethods` | `['GET', 'HEAD', 'OPTIONS']` |
| `getCsrfTokenFromRequest` | `req.headers['x-csrf-token']` |
| `size` | 32 random bytes |
| `hmacAlgorithm` | `'sha256'` |
| `errorConfig` | status 403, message `'invalid csrf token'`, code `'EBADCSRFTOKEN'` |

:::warning The `__Host-` prefix breaks local development
The default cookie name starts with `__Host-`, which browsers accept **only** when the cookie is `Secure`, has `Path=/` and has no `Domain`. Over `http://localhost` the browser silently refuses to store it, so `req.cookies` is empty and every write is a 403 that looks like a bug in your code. Use an unprefixed name in development, as above, and keep the prefix in production where it is doing real work.
:::

### Wiring it as Nest middleware

Register it through `configure()`, not `app.use()` in `main.ts`. The reason is specific and verifiable:

`doubleCsrfProtection` reports a failure by calling `next(invalidCsrfTokenError)` — it does not throw. Nest's middleware wrapper (`RouterProxy`) catches **thrown** exceptions and routes them through your exception filters; an error handed to `next()` goes down the Express chain instead and is rendered by Express's own final handler as an HTML page. Your API then answers a CSRF failure with `<pre>invalid csrf token</pre>` while every other error is JSON.

So convert it:

```ts good title="src/csrf/csrf.middleware.ts"
import { ForbiddenException, Injectable } from '@nestjs/common'
import type { NestMiddleware } from '@nestjs/common'
import type { NextFunction, Request, Response } from 'express'
import { doubleCsrfProtection } from './csrf.config.js'

@Injectable()
export class CsrfMiddleware implements NestMiddleware {
  use(request: Request, response: Response, next: NextFunction): void {
    doubleCsrfProtection(request, response, (error?: unknown) => {
      // Thrown synchronously from inside use(), so Nest's middleware proxy
      // catches it and the application's exception filters format the body.
      if (error) throw new ForbiddenException('Invalid CSRF token')
      next()
    })
  }
}
```

```ts good title="src/app.module.ts"
import { MiddlewareConsumer, Module, RequestMethod } from '@nestjs/common'
import { CsrfMiddleware } from './csrf/csrf.middleware.js'

@Module({})
export class AppModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(CsrfMiddleware)
      // Login and the webhook receiver are excluded deliberately — see below.
      .exclude(
        { path: 'auth/login', method: RequestMethod.POST },
        { path: 'webhooks/stripe', method: RequestMethod.POST },
      )
      .forRoutes('*splat')
  }
}
```

`'*splat'` is the Nest 12 wildcard. `'*'` is invalid under `path-to-regexp` 8 and throws at bootstrap — see [Routing and path syntax](../nestjs/routing-and-path-syntax.md).

`cookie-parser` and the session middleware must both run **before** it. Global middleware applied with `app.use()` in `main.ts` always runs before module-configured middleware, which makes that the right place for those two:

```ts good title="src/main.ts"
import { NestFactory } from '@nestjs/core'
import cookieParser from 'cookie-parser'
import session from 'express-session'
import { AppModule } from './app.module.js'

async function bootstrap() {
  const app = await NestFactory.create(AppModule)

  // Order matters: cookies, then session (csrf-csrf reads req.session.id),
  // then the CSRF middleware that AppModule.configure() registers.
  app.use(cookieParser())
  app.use(session(sessionOptions))

  await app.listen(3000)
}

bootstrap()
```

### Handing the token to the client

The client needs the token to echo it. Expose one endpoint that mints it; `generateCsrfToken` sets the cookie and returns the value.

```ts good title="src/csrf/csrf.controller.ts"
import { Controller, Get, Req, Res } from '@nestjs/common'
import type { Request, Response } from 'express'
import { generateCsrfToken } from './csrf.config.js'

@Controller('csrf')
export class CsrfController {
  @Get('token')
  token(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    // GET is in ignoredMethods, so this route is reachable without a token.
    return { csrfToken: generateCsrfToken(request, response) }
  }
}
```

`@Res({ passthrough: true })` is required: without `passthrough` Nest hands you the raw response and stops serializing the return value, so the endpoint hangs.

The browser then sends `x-csrf-token` on every write. Because the value must be read by JavaScript to be echoed, either return it in a body as above or set a **second**, non-`httpOnly` mirror cookie — do not make the protection cookie itself readable.

### Endpoints that must be excluded

- **Login.** There is no session yet, so `getSessionIdentifier` has nothing to bind to. Login CSRF is a real attack (the attacker logs the victim into the *attacker's* account and then reads what the victim does there); the defense is the `SameSite` cookie plus the origin guard, not a token.
- **Webhooks.** A payment provider posting to you is a cross-site request by definition and has no token. Authenticate it with the provider's signature instead, and give it its own controller so the exclusion is one narrow path. See [Middleware](../nestjs-request-handling/middleware.md).
- **Pure bearer-token routes**, if you have a mixed API. They gain nothing and the token requirement will break your mobile client.

## How to verify the fix

Replay the exploit. The same request, after the fixes:

```bash
curl -s -i -X POST https://api.example.test/account/email \
  -H 'content-type: application/x-www-form-urlencoded' \
  -H 'origin: https://evil.example' \
  -b 'sid=s%3AOxq1...victim session...' \
  -d 'email=attacker@evil.example'
```

```text title="403 Forbidden — and in your JSON shape, not Express's HTML"
HTTP/1.1 403 Forbidden
Content-Type: application/json; charset=utf-8

{"message":"Cross-origin request rejected","statusCode":403}
```

And the legitimate flow still works:

```bash
TOKEN=$(curl -s -c jar https://api.example.test/csrf/token | node -pe 'JSON.parse(require("fs").readFileSync(0)).csrfToken')

curl -s -o /dev/null -w '%{http_code}\n' -X PATCH https://api.example.test/account/email \
  -b jar -H 'content-type: application/json' \
  -H "origin: https://app.example.test" -H "x-csrf-token: $TOKEN" \
  -d '{"email":"dana+new@example.test"}'
```

```text
200
```

```ts title="test/csrf.e2e-spec.ts"
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { AppModule } from '../src/app.module.js'

describe('CSRF protection on /account/email', () => {
  let app: import('@nestjs/common').INestApplication

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = moduleRef.createNestApplication()
    await app.init()
  })

  afterAll(() => app.close())

  it('rejects a write with a session cookie but no token', async () => {
    const agent = request.agent(app.getHttpServer())
    await agent.post('/auth/login').send({ email: 'dana@example.test', password: 'Summer2024!' })

    await agent
      .patch('/account/email')
      .set('origin', 'https://app.example.test')
      .send({ email: 'attacker@evil.example' })
      .expect(403)
  })

  it('rejects a write from a foreign origin even with a valid token', async () => {
    const agent = request.agent(app.getHttpServer())
    await agent.post('/auth/login').send({ email: 'dana@example.test', password: 'Summer2024!' })
    const { body } = await agent.get('/csrf/token').expect(200)

    await agent
      .patch('/account/email')
      .set('origin', 'https://evil.example')
      .set('x-csrf-token', body.csrfToken)
      .send({ email: 'attacker@evil.example' })
      .expect(403)
  })

  it('accepts a write with the token and the right origin', async () => {
    const agent = request.agent(app.getHttpServer())
    await agent.post('/auth/login').send({ email: 'dana@example.test', password: 'Summer2024!' })
    const { body } = await agent.get('/csrf/token').expect(200)

    await agent
      .patch('/account/email')
      .set('origin', 'https://app.example.test')
      .set('x-csrf-token', body.csrfToken)
      .send({ email: 'dana+new@example.test' })
      .expect(200)
  })

  it("does not accept another session's token", async () => {
    const victim = request.agent(app.getHttpServer())
    const attacker = request.agent(app.getHttpServer())
    await victim.post('/auth/login').send({ email: 'dana@example.test', password: 'Summer2024!' })
    await attacker.post('/auth/login').send({ email: 'mallory@example.test', password: 'Autumn2024!' })

    const { body } = await attacker.get('/csrf/token').expect(200)

    // The HMAC is over the session identifier, so a token from another
    // session does not validate here.
    await victim
      .patch('/account/email')
      .set('origin', 'https://app.example.test')
      .set('x-csrf-token', body.csrfToken)
      .send({ email: 'attacker@evil.example' })
      .expect(403)
  })

  it('sets SameSite on the session cookie', async () => {
    const response = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'dana@example.test', password: 'Summer2024!' })

    expect(response.headers['set-cookie'][0]).toMatch(/SameSite=(Lax|Strict)/i)
  })
})
```

The cross-session test is the one that catches a `getSessionIdentifier` returning a constant — a mistake that makes every other test in the file pass.

## Production considerations

- **Assert the cookie flags in CI, not in review.** A `Set-Cookie` assertion in an end-to-end test is the only thing that survives someone refactoring `main.ts`.
- **Rotate `CSRF_SECRET` with an array.** `getSecret` may return `[newest, previous]`; tokens signed with either are accepted, which is how you rotate without logging everybody out mid-session.
- **`getSessionIdentifier` must change when the session does.** Return `req.session.id`, which `Session.regenerate()` changes at login — so a token minted before authentication stops working afterwards, which is the correct behaviour.
- **Exclude webhooks by exact path, never by prefix.** `.exclude({ path: 'webhooks/stripe', method: RequestMethod.POST })` is auditable; a wildcard exclusion grows.
- **Do not put the token in a `GET` query string.** It lands in access logs and `Referer` headers. Header or body only. See [Safe logging](safe-logging.md).
- **Watch the 403 rate after deploying.** A spike usually means a client that caches the token past a session regeneration, not an attack.
- **Server-sent events and WebSockets need their own answer.** A cookie-authenticated WebSocket upgrade is a cross-site-reachable request; check `Origin` on the handshake. See [WebSockets](../nestjs-advanced/websockets.md).

## Common mistakes

- **Adding `csurf`.** Archived and unmaintained. Use `csrf-csrf` 4.0.3 or `SameSite` plus an origin check.
- **Believing `enableCors()` handles it.** CORS governs reads; CSRF is about writes that were already sent.
- **Adding CSRF tokens to a pure bearer-token API.** Cost with no benefit, and it breaks non-browser clients.
- **Forgetting the one cookie-authenticated endpoint.** `POST /auth/refresh` with an `httpOnly` refresh cookie is in scope even when nothing else is.
- **Registering `doubleCsrfProtection` with `app.use()` in `main.ts`.** It reports failures through `next(err)`, which bypasses your exception filters and answers with Express's HTML error page.
- **Registering the CSRF middleware before `cookie-parser` or the session.** `req.cookies` is undefined and every write fails.
- **Keeping the `__Host-` cookie name in development.** Browsers refuse to store it over plain HTTP, and the resulting 403s look like a code bug.
- **A constant `getSessionIdentifier`.** Any user's token then validates for any other user.
- **Making the CSRF cookie readable by script so the client can echo it.** Return the token in a body, or mirror it in a second cookie.
- **Requiring a token on login.** There is no session to bind to yet; defend login with `SameSite` and the origin check.
- **`@Res()` without `passthrough: true` on the token endpoint.** Nest stops serializing the return value and the request hangs.
- **A state change behind `@Get()`.** `SameSite=Lax` still sends the cookie on top-level navigations.
- **Treating a missing `Origin` as acceptable.** That is the whole check, opted out of.
- **Writing `'*'` in `forRoutes`.** Invalid in Nest 12; use `'*splat'`.

## Related topics

- [CSRF](../security/csrf.md) — the attack mechanics, `SameSite` semantics and the double-submit reasoning in full.
- [Authentication and session security](authentication-and-session-security.md) — the cookie configuration these defenses sit on top of.
- [JWT pitfalls](jwt-pitfalls.md) — why putting the access token in a cookie brings CSRF back.
- [CORS](cors.md) — what it does control, and the misconfigurations that matter.
- [Middleware](../nestjs-request-handling/middleware.md) — `configure()`, `exclude()`, ordering and the global-versus-module distinction.
- [Guards](../nestjs-request-handling/guards.md) — where `OriginGuard` runs and how `APP_GUARD` ordering works.
- [Routing and path syntax](../nestjs/routing-and-path-syntax.md) — why `forRoutes('*splat')` and not `'*'`.
- [Security headers](security-headers.md) — helmet, and the headers that limit what an attacker's page can do.
- [Cookies](../express-libraries/cookies.md) — the attribute reference behind the `SameSite` table.
- [Safe logging](safe-logging.md) — keeping tokens out of URLs and access logs.
- [End-to-end tests](../nestjs-testing/e2e-tests.md) — the `request.agent` cookie-jar pattern the suite uses.
