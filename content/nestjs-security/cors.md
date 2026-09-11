---
title: CORS
description: enableCors in NestJS 12 — the production allow-list origin function, why origin true reflects every site, the endsWith origin that defeats sloppy matching, and curl verification of the preflight.
status: current
updated: 2026-09-11
---

`app.enableCors()` is one line, it makes the browser error go away, and with no arguments it sets `Access-Control-Allow-Origin: *`. That is the shape of most CORS incidents: a control that relaxes the same-origin policy, configured by someone whose goal was to stop seeing a console message. This page is the Nest configuration surface, the exact strings that defeat the usual shortcuts, and how to prove your policy with `curl`.

The attack itself — what an attacker reads, the `evil.example` page that does it, the null-origin trap, cache poisoning through a missing `Vary` — is on [CORS misconfiguration](../security/cors-misconfiguration.md) and is unchanged by the framework. Read that for the exploit; read this for what Nest does with your options.

## What Nest is actually running

`@nestjs/platform-express@12.0.1` bundles **`cors@2.8.6`**, and `enableCors()` hands your options straight to it. So the semantics below are that package's semantics, read from its shipped source — not Nest's, and not guesses:

| `origin` value | `Access-Control-Allow-Origin` | `Vary: Origin` |
| --- | --- | --- |
| omitted, or `true` | **the request's own `Origin`, reflected** | yes |
| `'*'` | `*` | **no** |
| `'https://app.example.com'` | that fixed string, always | yes |
| `['https://app.example.com', …]` | the request origin if it is `===` a member, else no header | yes |
| `/regex/` | the request origin if the regex `test`s it, else no header | yes |
| `(origin, cb) => cb(null, false)` | **no CORS headers at all, and the request is passed to the router** | no |

Two rows in that table are the whole page. `origin: true` — and therefore `enableCors()` with a bare `{ credentials: true }` — reflects whatever the caller sent. And a function that answers `false` does not merely withhold the header: it calls `next()`, so the preflight is never answered by the CORS layer.

## The threat

CORS does not add security. It *removes* a restriction the browser applies by default — the same-origin policy, which lets an attacker's page send a request to your API but not read the response. Your CORS headers are what grant that read.

Get them wrong with `credentials: true` and any site the victim visits can call your API with the victim's cookies and read the JSON: account details, tokens, whatever the session authorizes. The victim does nothing but open a tab.

## A concrete exploit

The configuration that produces it is the one people write to make CORS "just work":

:::danger Reflected origin with credentials
```ts vulnerable title="DO NOT COPY — src/main.ts"
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module.js'

const app = await NestFactory.create(AppModule)

// origin: true means "reflect whatever Origin arrived" — i.e. trust everyone.
app.enableCors({ origin: true, credentials: true })

await app.listen(3000)
```
:::

```bash
curl -i -X OPTIONS localhost:3000/api/me \
  -H 'Origin: https://evil.example' \
  -H 'Access-Control-Request-Method: GET'
```

```text
HTTP/1.1 204 No Content
Access-Control-Allow-Origin: https://evil.example
Access-Control-Allow-Credentials: true
Vary: Origin
```

The browser now permits `https://evil.example` to read authenticated responses from your API. The follow-up request confirms it:

```bash
curl -s -H 'Origin: https://evil.example' -H 'Cookie: session=<victim session>' \
  -D- localhost:3000/api/me
```

```text
HTTP/1.1 200 OK
Access-Control-Allow-Origin: https://evil.example
Access-Control-Allow-Credentials: true

{"email":"victim@example.test","apiToken":"sk_live_abc123"}
```

### The `endsWith` shortcut, and the origin that beats it

The next attempt is usually a "smart" matcher, because the allow-list has to cover `app.example.com`, `admin.example.com` and a few preview deployments:

:::danger Suffix matching
```ts vulnerable title="DO NOT COPY — src/main.ts"
app.enableCors({
  origin: (origin, callback) => {
    // Looks like "any example.com subdomain". It is not.
    callback(null, !origin || origin.endsWith('example.com'))
  },
  credentials: true,
})
```
:::

Two attacker-registrable origins pass it, and one of them is free:

```bash
# endsWith('example.com') is TRUE for this — the attacker registers the domain.
curl -i -X OPTIONS localhost:3000/api/me \
  -H 'Origin: https://evil-example.com' -H 'Access-Control-Request-Method: GET'
```

```text
HTTP/1.1 204 No Content
Access-Control-Allow-Origin: https://evil-example.com
Access-Control-Allow-Credentials: true
```

And `!origin` — written to let Postman and server-to-server calls through — makes every request without an `Origin` header allowed, which in this package resolves to `true` and therefore to origin reflection for anything that *does* send one on a later code path. The same family of bugs:

| Matcher | Attacker origin that passes |
| --- | --- |
| `origin.endsWith('example.com')` | `https://evil-example.com` |
| `origin.startsWith('https://example.com')` | `https://example.com.evil.net` |
| `origin.includes('example.com')` | `https://example.com.evil.net` |
| `/example\.com/` (unanchored) | `https://example.com.evil.net`, `https://evilexample.com` |
| `/^https:\/\/example\.com/` (no `$`) | `https://example.com.evil.net` |
| `/^https:\/\/.*\.example\.com$/` | `https://evil.com#.example.com` in some parsers — prefer exact strings |

`*.example.com` as a policy is also a bigger trust decision than it looks: it delegates your API's security to every subdomain, including the marketing CMS, the status page, and whatever a subdomain-takeover leaves pointing at an unclaimed bucket.

### `origin: '*'` with `credentials: true` fails silently

This is the other common shape, and it is worth understanding precisely because the failure mode drives people to the reflection bug above.

```ts vulnerable title="DO NOT COPY — src/main.ts"
app.enableCors({ origin: '*', credentials: true })
```

The server sends exactly what you asked for:

```text
Access-Control-Allow-Origin: *
Access-Control-Allow-Credentials: true
```

Your *server* is fine. The **browser** refuses the response: the Fetch specification forbids the wildcard when the request's credentials mode is `include`. There is no server-side error, nothing in your logs, and nothing in your test suite if the test uses `curl` or supertest — both of which are not browsers and will happily read the body. The only symptom is a console message in the front-end developer's tab.

The correct response to that message is to name the origins. The common response is `origin: true`, which makes the message disappear by trusting every site on the internet.

Note also that `origin: '*'` is the one configuration where `cors@2.8.6` does **not** emit `Vary: Origin` — it does not need to, because the header does not depend on the request. Every other form does emit it.

## The fix in code

An explicit allow-list, compared with `Set.has` on the full origin string, expressed as a function so the list can come from configuration.

```ts good title="src/main.ts"
import { NestFactory } from '@nestjs/core'
import { ConfigService } from '@nestjs/config'
import { AppModule } from './app.module.js'

const app = await NestFactory.create(AppModule)
const config = app.get(ConfigService)

// Exact, fully-qualified origins. No suffix matching, no wildcards, no null.
const ALLOWED_ORIGINS = new Set(
  config.getOrThrow<string>('CORS_ORIGINS').split(',').map((value) => value.trim()),
)

app.enableCors({
  origin(requestOrigin, callback) {
    // Same-origin and non-browser callers send no Origin header at all. They are
    // not subject to CORS, so answering `false` costs them nothing.
    if (!requestOrigin) return callback(null, false)

    // Exact string equality against a fixed set. Never endsWith, never a regex.
    callback(null, ALLOWED_ORIGINS.has(requestOrigin) ? requestOrigin : false)
  },
  credentials: true,
  methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token', 'X-Requested-With'],
  exposedHeaders: ['X-Request-Id', 'X-RateLimit-Remaining', 'X-RateLimit-Reset', 'Retry-After'],
  maxAge: 600,
  optionsSuccessStatus: 204,
})

await app.listen(3000)
```

```env title=".env.production"
CORS_ORIGINS=https://app.example.com,https://admin.example.com
```

Why each option is there:

| Option | Why |
| --- | --- |
| `origin` as a function returning the **string** | Echoing back the matched origin, not `true`, keeps the reflection decision explicit and greppable. |
| `credentials: true` | Only if your front end sends cookies. If it sends a bearer token in a header, leave it off — a CORS slip then leaks much less. |
| `methods` | The default is `GET,HEAD,PUT,PATCH,POST,DELETE`. List what you serve; a method you never implement should not be advertised. |
| `allowedHeaders` | Without it, the package echoes `Access-Control-Request-Headers`, which permits any header the caller asks for. |
| `exposedHeaders` | The browser hides every response header except a short safelist. If the client reads `X-Request-Id` or the rate-limit headers, they must be listed here or they are simply absent in JavaScript. |
| `maxAge` | Caches the preflight for 600 seconds, removing one round trip per request. Browsers cap it (Chromium at 7200 seconds); a larger number is not an error, it is just ignored. |
| `optionsSuccessStatus` | 204 is the default and is correct; some legacy clients need 200. |

:::warning `callback(null, false)`, never `callback(new Error(…))`
Both "reject" the origin, and they behave completely differently. Returning `false` makes the package call `next()` with no CORS headers, which is exactly the same-origin default you want. Passing an `Error` calls `next(err)`, which reaches your exception filters and becomes a **500** — a server error, on every preflight from every unknown origin, in your error budget and your alerting. It also tells a prober that their origin was specifically rejected rather than simply not allowed.
:::

### What a rejected preflight actually looks like

An honest consequence of the function form: when the callback answers `false`, the CORS middleware calls `next()`, so the `OPTIONS` request continues into the router. Nest has no handler for it, so the response is the framework's **404**, not a 204.

That is fine — the browser's decision is driven entirely by the absence of `Access-Control-Allow-Origin` — but it means your pass condition is a header check, not a status check. It also means disallowed preflights show up as 404s in your access logs, which is worth knowing before someone opens a ticket about it.

If you prefer a 204 for every preflight regardless, use the array form: `origin: ['https://app.example.com', 'https://admin.example.com']`. The package compares array members with `===`, so it is exactly as strict as the `Set`, and on a non-member it answers the preflight with a 204 carrying `Vary: Origin` and no allow-origin header. Use the function when the list is dynamic or comes from configuration; use the array when it is static.

### Same config, set at creation

`enableCors()` and the `cors` application option are the same thing; pick one place and keep it there.

```ts good title="src/main.ts"
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module.js'
import { corsOptions } from './cors.options.js'

const app = await NestFactory.create(AppModule, { cors: corsOptions })
await app.listen(3000)
```

:::note
`cors: true` in that options object is **not** a shorthand for "sensible defaults". It is the package's default, which is `Access-Control-Allow-Origin: *`. Always pass an options object.
:::

## Per-controller CORS, and what the preflight can see

A common request is "the public catalogue should be readable from anywhere, the rest of the API should not". Nest applies `enableCors()` globally; there is no `@Cors()` decorator. The supported way to differentiate is a delegate, which receives the request and returns options per request:

```ts good title="src/cors.options.ts"
import type { CorsOptions, CorsOptionsCallback } from '@nestjs/common/interfaces/external/cors-options.interface'
import type { Request } from 'express'

const ALLOWED_ORIGINS = new Set(['https://app.example.com', 'https://admin.example.com'])

const PRIVATE: CorsOptions = {
  origin(requestOrigin, callback) {
    if (!requestOrigin) return callback(null, false)
    callback(null, ALLOWED_ORIGINS.has(requestOrigin) ? requestOrigin : false)
  },
  credentials: true,
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  maxAge: 600,
}

// Public, cacheable, and explicitly WITHOUT credentials.
const PUBLIC_READ: CorsOptions = {
  origin: '*',
  credentials: false,
  methods: ['GET', 'OPTIONS'],
  maxAge: 3600,
}

export function corsDelegate(request: Request, callback: CorsOptionsCallback) {
  // The delegate sees the URL and method. It does not see the handler,
  // the guard result, or anything the DI container knows.
  callback(null, request.path.startsWith('/public/') ? PUBLIC_READ : PRIVATE)
}
```

```ts good title="src/main.ts"
const app = await NestFactory.create(AppModule)
app.enableCors(corsDelegate)
await app.listen(3000)
```

Two structural limits to keep in mind, and they are the reason CORS is not an access control:

- **A preflight carries no credentials.** `OPTIONS` is sent without cookies and without `Authorization`, so a guard cannot meaningfully run on it and the delegate cannot branch on who the caller is. Route them by path and method, or not at all.
- **CORS governs reads, not writes.** A cross-origin `POST` with `Content-Type: application/x-www-form-urlencoded` is a "simple request": it is *sent* with no preflight, and your handler runs. The browser only withholds the *response* from the attacker's script. That is CSRF, and CORS is not its defense. See [CSRF](csrf.md).

## How to verify the fix

Three `curl` calls. The pass condition is the presence or absence of `Access-Control-Allow-Origin`.

An **allowed** origin is echoed:

```bash
curl -i -X OPTIONS localhost:3000/api/me \
  -H 'Origin: https://app.example.com' \
  -H 'Access-Control-Request-Method: GET' \
  -H 'Access-Control-Request-Headers: authorization'
```

```text
HTTP/1.1 204 No Content
Access-Control-Allow-Origin: https://app.example.com
Access-Control-Allow-Credentials: true
Access-Control-Allow-Methods: GET,POST,PATCH,PUT,DELETE,OPTIONS
Access-Control-Allow-Headers: Content-Type,Authorization,X-CSRF-Token,X-Requested-With
Access-Control-Expose-Headers: X-Request-Id,X-RateLimit-Remaining,X-RateLimit-Reset,Retry-After
Access-Control-Max-Age: 600
Vary: Origin
```

A **disallowed** origin gets nothing — note the 404, which is the router answering because the CORS layer declined:

```bash
curl -i -X OPTIONS localhost:3000/api/me \
  -H 'Origin: https://evil.example' -H 'Access-Control-Request-Method: GET'
```

```text
HTTP/1.1 404 Not Found
Content-Type: application/json; charset=utf-8

{"message":"Cannot OPTIONS /api/me","error":"Not Found","statusCode":404}
```

And the look-alikes, which must behave identically to `evil.example`:

```bash
for origin in https://evil-example.com https://example.com.evil.net null https://app.example.com.evil.net; do
  printf '%-38s ' "$origin"
  curl -s -o /dev/null -D- -X OPTIONS localhost:3000/api/me \
    -H "Origin: $origin" -H 'Access-Control-Request-Method: GET' \
    | grep -i '^access-control-allow-origin' || echo '(none)'
done
```

```text
https://evil-example.com               (none)
https://example.com.evil.net           (none)
null                                   (none)
https://app.example.com.evil.net       (none)
```

`Origin: null` is on that list deliberately: sandboxed iframes, `data:` URLs and some redirect chains send it, so an allow-list containing the literal string `null` is reachable from an attacker-controlled iframe.

Then make it a test, because the allow-list is a string in a config file that somebody will edit:

```ts title="test/cors.e2e-spec.ts"
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { AppModule } from '../src/app.module.js'
import { corsOptions } from '../src/cors.options.js'

describe('CORS policy', () => {
  let app: import('@nestjs/common').INestApplication

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = moduleRef.createNestApplication()
    // enableCors lives in main.ts, which tests never run — apply it here too,
    // from the same exported options object, or the suite proves nothing.
    app.enableCors(corsOptions)
    await app.init()
  })

  afterAll(() => app.close())

  const lookAlikes = [
    'https://evil.example',
    'https://evil-example.com',
    'https://example.com.evil.net',
    'https://app.example.com.evil.net',
    'null',
  ]

  it.each(lookAlikes)('does not echo %s', async (origin) => {
    const response = await request(app.getHttpServer())
      .options('/api/me')
      .set('Origin', origin)
      .set('Access-Control-Request-Method', 'GET')

    expect(response.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('echoes an allow-listed origin with credentials and Vary', async () => {
    const response = await request(app.getHttpServer())
      .options('/api/me')
      .set('Origin', 'https://app.example.com')
      .set('Access-Control-Request-Method', 'GET')
      .expect(204)

    expect(response.headers['access-control-allow-origin']).toBe('https://app.example.com')
    expect(response.headers['access-control-allow-credentials']).toBe('true')
    expect(response.headers['vary']).toMatch(/Origin/)
  })
})
```

The comment in `beforeAll` is the important part. `enableCors()` is called in `main.ts`, and `Test.createTestingModule` never executes `main.ts` — so a CORS suite that forgets to apply the options tests the framework default, which is `*`, and reports a failure you then "fix" by loosening the assertion. Export the options object from its own module and use it in both places.

## Production considerations

- **`Vary: Origin` must reach your CDN.** The package sets it for every non-wildcard form, but a proxy configured to strip or override `Vary` turns a per-origin allow header into a cached response served to everyone. Check it at the edge, not just at the origin server.
- **Prefer bearer tokens to cookies for cross-origin APIs.** Without `credentials: true` the worst a CORS slip exposes is what an unauthenticated caller could already fetch.
- **Preview deployments need a rule, not an exception.** `https://pr-1234.preview.example.dev` in the production allow-list is a permanent hole. Give preview builds a separate API deployment with its own list.
- **Do not add `Origin` to `allowedHeaders`.** It is a forbidden header name that the browser sets; listing it signals confusion about which direction the header travels.
- **The `Access-Control-Allow-Private-Network` / Local Network Access work is still rolling out** and differs between browser builds. Treat it as emerging and do not design your policy around it.
- **Audit the config in CI.** A grep for `origin: true`, `origin: '*'` and `endsWith(` in the same file as `enableCors` catches the three failure modes on this page before review does.

## Common mistakes

- **`app.enableCors()` with no arguments**, or `{ cors: true }` on `NestFactory.create`. Both mean `Access-Control-Allow-Origin: *`.
- **`origin: true` with `credentials: true`.** Reflects every origin and grants credentialed reads to all of them.
- **`origin: '*'` with `credentials: true`.** The browser rejects it, your server logs nothing, and the "fix" people reach for is reflection.
- **`endsWith` / `startsWith` / `includes` origin matching.** Beaten by `evil-example.com` and `example.com.evil.net`.
- **Unanchored or under-anchored regexes.** `/example\.com/` and `/^https:\/\/example\.com/` both match attacker domains. Use exact strings.
- **`!origin` treated as allowed.** It resolves to `true` in this package, which is origin reflection.
- **Allow-listing the literal `null`.** Sandboxed iframes send `Origin: null`.
- **`callback(new Error('Not allowed by CORS'))`.** Turns every unknown-origin preflight into a 500 through your exception filters.
- **Omitting `allowedHeaders`.** The package then echoes whatever the caller asked for.
- **Forgetting `exposedHeaders`.** Your client cannot read `X-Request-Id` or the rate-limit headers and nobody can work out why.
- **Applying `enableCors()` only in `main.ts` and then testing CORS.** The test runs against the framework default.
- **Expecting a 204 from a rejected preflight when using the function form.** It is a 404; assert on the header.
- **Trying to make a guard run on a preflight.** `OPTIONS` carries no credentials.
- **Believing CORS stops cross-site writes.** It governs reads. See [CSRF](csrf.md).
- **Allow-listing `*.example.com` by regex.** Every subdomain, including a taken-over one, becomes trusted.

## Related topics

- [CORS misconfiguration](../security/cors-misconfiguration.md) — the exploit page: the attacker's script, the null-origin iframe, cache poisoning.
- [CORS](../express-libraries/cors.md) — the `cors` package options outside Nest; Nest passes yours to the same package.
- [CSRF](csrf.md) — why a strict CORS policy does not stop a forged write.
- [Security headers](security-headers.md) — the other cross-origin controls, including CORP and COOP.
- [Middleware](../nestjs-request-handling/middleware.md) — where the CORS layer sits relative to guards and pipes.
- [Guards](../nestjs-request-handling/guards.md) — and why none of them see a preflight.
- [Environment configuration](../nestjs-production/configuration.md) — keeping the origin list out of the source.
- [Secrets and config validation](secrets-and-config.md) — failing at boot when `CORS_ORIGINS` is missing.
- [End-to-end tests](../nestjs-testing/e2e-tests.md) — applying `main.ts` configuration inside the test app.
- [OWASP API Top 10 in Nest](owasp-api-top-10.md) — CORS as part of API8, Security Misconfiguration.
