---
title: OWASP API Top 10 in Nest
description: The OWASP API Security Top 10 (2023 edition) mapped onto NestJS 12 code — the DI-layer manifestation of each item, a one-line exploit, and the framework control that closes it.
status: current
updated: 2026-09-11
---

Nest gives you guards, pipes, interceptors and filters — a place to put every control on this list. That is the good news and the trap: a framework with a designated place for a control makes it easy to believe the control is present. This page walks the OWASP API Security Top 10 and, for each item, names what it looks like in a Nest codebase, the request that proves it, and the specific piece of Nest that fixes it.

## Which edition this page uses

**OWASP API Security Top 10 — 2023 edition.** Verified on 2026-09-11 against the project's own source repository, <https://github.com/OWASP/API-Security>, whose `editions/` directory contains exactly two editions: `2019` and `2023`. The item names below are copied from `editions/2023/en/0x00-toc.md`.

There is **no 2025 edition of the API list**. The OWASP Top 10:2025 you may have seen is the separate list for web applications, at <https://owasp.org/Top10/>. They are different documents with different item IDs; do not mix them in an audit report.

Item IDs are written as OWASP writes them: `API1:2023` through `API10:2023`.

| ID | Name | Where it lives in a Nest app |
| --- | --- | --- |
| API1:2023 | Broken Object Level Authorization | A service that loads by `id` alone, with a guard "covering" it |
| API2:2023 | Broken Authentication | `JwtModule` with no `algorithms`, no login throttle, `@Public()` on the wrong route |
| API3:2023 | Broken Object Property Level Authorization | `new ValidationPipe()` with no `whitelist`, and an entity returned raw |
| API4:2023 | Unrestricted Resource Consumption | No `ThrottlerGuard`, no body limit, no multer `limits`, no pagination cap |
| API5:2023 | Broken Function Level Authorization | `APP_GUARD` authentication with a `RolesGuard` that is never registered |
| API6:2023 | Unrestricted Access to Sensitive Business Flows | Signup, checkout and coupon routes under the one global throttle |
| API7:2023 | Server Side Request Forgery | A service that `fetch`es a URL taken from a DTO |
| API8:2023 | Security Misconfiguration | No `helmet`, `origin: true` in `enableCors()`, stack traces from the default filter |
| API9:2023 | Improper Inventory Management | `VERSION_NEUTRAL` routes and a v1 controller nobody removed |
| API10:2023 | Unsafe Consumption of APIs | An upstream response deserialized straight into an entity |

Injection — SQL, NoSQL, command — does not have its own item in the 2023 list; OWASP folds it into API8. It has two full pages here anyway, because it is still the fastest total compromise on the list: [SQL injection](sql-injection.md) and [NoSQL injection](nosql-injection.md).

## API1:2023 — Broken Object Level Authorization

**The threat.** Any authenticated user reads or writes any other user's records. It is the most-exploited API bug in the world and it costs an attacker one edited integer.

**The Nest manifestation.** A controller with a guard on it, and a service that ignores the caller:

:::danger
```ts vulnerable title="DO NOT COPY — src/orders/orders.controller.ts"
@Controller('orders')
@UseGuards(AuthGuard)
export class OrdersController {
  @Get(':id')
  findOne(@Param('id') id: string) {
    // The guard proved *someone* is logged in. It did not prove it is this order's owner.
    return this.orders.findOne(id)
  }
}
```
:::

**The exploit.** One request, one number:

```bash
curl -s -H 'authorization: Bearer <user-B token>' localhost:3000/orders/1042
```

```json title="200 OK — user A's order"
{ "id": 1042, "userId": "a-11", "totalCents": 48900, "shippingAddress": "12 Rue…" }
```

**The control.** Put the owner in the `WHERE` clause, in the service, and return 404. A guard cannot do this — it runs before the row is loaded. Full treatment, including write paths and nested resources: [Authorization and IDOR](authorization-and-idor.md).

## API2:2023 — Broken Authentication

**The threat.** The attacker becomes another user without their password: a forged token, a stuffed credential, a reset link that never expires.

**The Nest manifestation.** `JwtModule.register({ secret })` with no `algorithms` array on verification, a login route with no throttle, and `@Public()` left on a route that stopped being public.

**The exploit.** Algorithm confusion against a verifier that accepts whatever the header says, or 20,000 credential pairs at the unthrottled `POST /auth/login`:

```bash
for p in $(cat top-10k-passwords.txt); do
  curl -s -o /dev/null -w '%{http_code} ' -X POST localhost:3000/auth/login \
    -H 'content-type: application/json' \
    -d "{\"email\":\"victim@example.com\",\"password\":\"$p\"}"
done
```

Every response is a 200 or a 401 and nothing slows down.

**The control.** Pin `algorithms` on `verifyAsync`, throttle the login route by email as well as IP, and audit `@Public()`. See [JWT pitfalls](jwt-pitfalls.md), [Authentication and session security](authentication-and-session-security.md) and [Rate limiting and abuse](rate-limiting.md).

## API3:2023 — Broken Object Property Level Authorization

**The threat.** Two directions, one item. Inbound: the client writes a property it should not control (mass assignment). Outbound: the response contains a property the client should not read.

**The Nest manifestation.** `new ValidationPipe()` with no options, plus a controller that returns the entity.

**The exploit.** Inbound:

```bash
curl -s -X PATCH localhost:3000/users/me \
  -H 'authorization: Bearer <normal user>' -H 'content-type: application/json' \
  -d '{"displayName":"Mallory","role":"admin"}'
```

```json title="200 OK"
{ "id": "8f1c…", "displayName": "Mallory", "role": "admin" }
```

Outbound, the same endpoint returning what the ORM gave it:

```json title="200 OK — leaking the password hash"
{ "id": "8f1c…", "email": "m@example.test", "passwordHash": "$argon2id$v=19$m=65536…" }
```

**The control.** `whitelist: true` + `forbidNonWhitelisted: true` on the global pipe for the inbound half, and an explicit response DTO for the outbound half. See [Validation as a security control](validation-as-a-control.md), [Whitelisting and unknown properties](../nestjs-validation/unknown-properties.md) and [Serialization](../nestjs-validation/serialization.md).

## API4:2023 — Unrestricted Resource Consumption

**The threat.** The attacker spends your CPU, memory, disk, bandwidth or third-party quota until the service falls over or the bill does.

**The Nest manifestation.** Four independent caps, each missing by default: no `ThrottlerGuard`, no `express.json({ limit })`, no `limits` on the file interceptor, no maximum on a `?perPage=` query.

**The exploit.** Pagination is the cheapest:

```bash
curl -s -o /dev/null -w '%{time_total}s %{size_download} bytes\n' \
  'localhost:3000/orders?perPage=1000000'
```

```text
41.882s 934217402 bytes
```

One request, forty seconds of database time and 900 MB of heap.

**The control.** `ThrottlerModule` as an `APP_GUARD`, a body limit on the adapter, multer `limits`, and a `@Max(100)` on the page-size DTO field. See [Rate limiting and abuse](rate-limiting.md) and [File upload security](file-upload-security.md).

## API5:2023 — Broken Function Level Authorization

**The threat.** A normal user calls an administrative endpoint. Distinct from API1: nothing about the *object* is wrong, the caller simply should not be able to invoke this *function*.

**The Nest manifestation.** Two `APP_GUARD` providers were intended, one was registered. Or `@Roles('admin')` sits on a handler and the `RolesGuard` that reads it was never added, so the decorator is inert metadata.

**The exploit.**

```bash
curl -s -X DELETE -H 'authorization: Bearer <normal user>' localhost:3000/admin/users/a-11
```

```json title="200 OK"
{ "deleted": true }
```

**The control.** Register the guard, and prove it with a test rather than reading the module. A `@Roles()` decorator with no guard behind it fails open and silently.

```ts good title="src/app.module.ts"
import { Module } from '@nestjs/common'
import { APP_GUARD } from '@nestjs/core'
import { AuthGuard } from './common/guards/auth.guard.js'
import { RolesGuard } from './common/guards/roles.guard.js'

@Module({
  providers: [
    // Order matters: authentication populates request.user, then roles reads it.
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}
```

See [Guards](../nestjs-request-handling/guards.md) and [Authorization and IDOR](authorization-and-idor.md).

## API6:2023 — Unrestricted Access to Sensitive Business Flows

**The threat.** No single request is malicious. The *rate* is. Scripted signups farm trial credits, scripted checkouts buy the whole inventory, scripted coupon redemptions drain the budget.

**The Nest manifestation.** A single global throttler at 100 requests per minute, which is generous for reading a product page and absurd for redeeming a coupon.

**The exploit.** Ninety-nine coupon redemptions per minute, from one IP, with a 200 each time — under the global limit the whole way.

**The control.** Per-flow named throttlers, and a business-level counter that is not a rate limit at all (one trial per payment instrument, one coupon per account). See [Rate limiting and abuse](rate-limiting.md).

## API7:2023 — Server Side Request Forgery

**The threat.** Your server makes an HTTP request to a URL the attacker chose, from inside your network, with your network's trust.

**The Nest manifestation.** An "import from URL" or "webhook test" endpoint whose DTO has `@IsUrl()` on it — which proves the string is a URL, not that it points anywhere you want to go.

:::danger
```ts vulnerable title="DO NOT COPY — src/imports/imports.service.ts"
@Injectable()
export class ImportsService {
  async importFrom(url: string) {
    // @IsUrl() passed. The DTO said nothing about *which* host.
    const response = await fetch(url)
    return response.text()
  }
}
```
:::

**The exploit.** Cloud instance metadata, reachable only from inside:

```bash
curl -s -X POST localhost:3000/imports \
  -H 'content-type: application/json' \
  -d '{"url":"http://169.254.169.254/latest/meta-data/iam/security-credentials/app-role"}'
```

```json title="200 OK"
{ "content": "{\"AccessKeyId\":\"ASIA…\",\"SecretAccessKey\":\"…\",\"Token\":\"…\"}" }
```

**The control.** An allow-list of hosts, DNS resolution followed by a check that every resolved address is public, no redirect following, and a timeout. The full implementation, which is framework-independent, is in [OWASP API Top 10 in Express](../security/owasp-api-top-10.md). Inside Nest it belongs in a provider so it is injectable and testable:

```ts good title="src/common/safe-fetch.service.ts"
import { lookup } from 'node:dns/promises'
import { BadRequestException, Injectable } from '@nestjs/common'

const ALLOWED_HOSTS = new Set(['files.partner.example', 'cdn.partner.example'])

@Injectable()
export class SafeFetchService {
  async get(rawUrl: string): Promise<Response> {
    let url: URL
    try {
      url = new URL(rawUrl)
    } catch {
      throw new BadRequestException('Malformed URL')
    }

    if (url.protocol !== 'https:') throw new BadRequestException('Only https is allowed')
    if (!ALLOWED_HOSTS.has(url.hostname)) throw new BadRequestException('Host is not allow-listed')

    // Resolve and reject private space, so a DNS record pointing at 127.0.0.1 fails.
    const { address } = await lookup(url.hostname)
    if (isPrivateAddress(address)) throw new BadRequestException('Host resolves to a private address')

    return fetch(url, {
      redirect: 'error', // a 302 to the metadata service is the whole attack
      signal: AbortSignal.timeout(5_000),
    })
  }
}
```

`redirect: 'error'` is the line people leave out. An allow-listed host that 302s to `169.254.169.254` defeats a host check that only runs once.

## API8:2023 — Security Misconfiguration

**The threat.** The framework's defaults are convenient, not safe, and nothing warns you.

**The Nest manifestation.** Four specific settings:

| Setting | Default | What it costs |
| --- | --- | --- |
| `app.enableCors()` with no arguments | `Access-Control-Allow-Origin: *` | any site can read every unauthenticated response |
| `enableCors({ origin: true })` | reflects the request `Origin` | with `credentials: true`, any site reads authenticated responses |
| no `helmet` | no CSP, no HSTS, no `nosniff` | see [Security headers](security-headers.md) |
| default exception filter on a non-`HttpException` | 500 with a generic body, full stack in the log | acceptable — but a hand-written filter that echoes `error.message` is not |

**The exploit.** One `curl` proves the CORS half:

```bash
curl -i -X OPTIONS localhost:3000/api/me \
  -H 'Origin: https://evil.example' -H 'Access-Control-Request-Method: GET'
```

```text
HTTP/1.1 204 No Content
Access-Control-Allow-Origin: https://evil.example
Access-Control-Allow-Credentials: true
```

**The control.** See [CORS](cors.md) and [Security headers](security-headers.md). Injection lives under this item too — [SQL injection](sql-injection.md), [NoSQL injection](nosql-injection.md).

## API9:2023 — Improper Inventory Management

**The threat.** You cannot patch what you do not know you are serving. The breach is usually in `v1`, which nobody has thought about since `v2` shipped.

**The Nest manifestation.** Nest makes this one easy to create: `enableVersioning()` plus a `VERSION_NEUTRAL` controller means one handler answers every version forever, and an old `@Controller({ version: '1' })` keeps serving until someone deletes the file.

**The exploit.** The new endpoint validates; the old one does not.

```bash
curl -s localhost:3000/v2/users/a-11   # 403 — v2 added the ownership check
curl -s localhost:3000/v1/users/a-11   # 200 — v1 never had it
```

**The control.** Two parts. Give every version an explicit sunset that the app itself announces, and generate the route inventory from the code rather than maintaining it by hand.

```ts good title="src/common/middleware/sunset.middleware.ts"
import { Injectable } from '@nestjs/common'
import type { NestMiddleware } from '@nestjs/common'
import type { NextFunction, Request, Response } from 'express'

@Injectable()
export class SunsetV1Middleware implements NestMiddleware {
  use(_request: Request, response: Response, next: NextFunction) {
    response.setHeader('Deprecation', 'true')
    response.setHeader('Sunset', 'Wed, 31 Dec 2026 23:59:59 GMT') // RFC 8594
    next()
  }
}
```

For the inventory, build the OpenAPI document in a script and commit the path list. It is derived from the same decorators that create the routes, so a route that exists and is not in the file is visible in the diff:

```ts good title="scripts/print-routes.ts"
import { NestFactory } from '@nestjs/core'
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger'
import { AppModule } from '../src/app.module.js'

const app = await NestFactory.create(AppModule, { logger: false })
const document = SwaggerModule.createDocument(app, new DocumentBuilder().build())

for (const [route, methods] of Object.entries(document.paths ?? {})) {
  for (const method of Object.keys(methods)) console.log(method.toUpperCase(), route)
}

await app.close()
```

A route that appears in that diff without appearing in the pull request description is the finding. See [Versioning](../nestjs-request-handling/versioning.md) and [OpenAPI with Swagger](../nestjs-libraries/swagger.md).

:::warning
Deprecating a version means **removing the routes**, not documenting that they are deprecated. An endpoint that answers is an endpoint in your attack surface, whatever the changelog says.
:::

## API10:2023 — Unsafe Consumption of APIs

**The threat.** You validate what the browser sends and trust what your payment provider, identity provider or partner sends. An attacker who can influence that upstream — or simply a provider having a bad day — writes straight into your database.

**The Nest manifestation.** A webhook controller with no DTO, or an `HttpService` response passed directly to `repo.save()`.

:::danger
```ts vulnerable title="DO NOT COPY — src/billing/billing.controller.ts"
@Controller('webhooks')
export class BillingController {
  @Post('provider')
  handle(@Body() body: any) {
    // No signature check, no schema, no allow-list of event types.
    return this.subscriptions.applyUpstreamEvent(body)
  }
}
```
:::

**The exploit.** The endpoint is on the public internet, so the "upstream" can be anyone:

```bash
curl -s -X POST localhost:3000/webhooks/provider \
  -H 'content-type: application/json' \
  -d '{"type":"subscription.updated","customer":"cus_victim","plan":"enterprise","status":"active"}'
```

```json title="200 OK"
{ "applied": true }
```

**The control.** Three things, in order: verify the signature over the **raw body** before any parsing, validate the payload against a DTO with `whitelist: true` exactly as you would a browser request, and switch on an allow-list of event types. Nest exposes the raw bytes for the signature step:

```ts good title="src/main.ts"
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module.js'

const app = await NestFactory.create(AppModule, { rawBody: true })
await app.listen(3000)
```

```ts good title="src/billing/billing.controller.ts"
import { BadRequestException, Body, Controller, Post, Req } from '@nestjs/common'
import type { RawBodyRequest } from '@nestjs/common'
import type { Request } from 'express'
import { ProviderEventDto } from './dto/provider-event.dto.js'

@Controller('webhooks')
export class BillingController {
  @Post('provider')
  handle(@Req() request: RawBodyRequest<Request>, @Body() event: ProviderEventDto) {
    // The signature covers the exact bytes received — not the re-serialized object.
    if (!this.billing.signatureIsValid(request.rawBody, request.get('x-provider-signature'))) {
      throw new BadRequestException('Bad signature')
    }
    return this.subscriptions.applyUpstreamEvent(event)
  }
}
```

`rawBody: true` on `NestFactory.create` is what makes `request.rawBody` a `Buffer`. Without it the property is `undefined` and your signature check compares against nothing — which passes or fails by accident depending on how you wrote it.

## What the Nest defaults actually give you

Worth being blunt about, because "Nest is secure by default" is repeated a lot and is not true in the ways that matter:

| Control | Nest 12 default | You must |
| --- | --- | --- |
| Validation | no global pipe | register `ValidationPipe` with `whitelist` |
| Unknown body properties | passed through | set `whitelist: true` |
| Prototype-pollution keys | **stripped** by both validation pipes | nothing — this one is genuinely default-on |
| CORS | off; `enableCors()` with no args is `*` | pass an explicit origin allow-list |
| Security headers | none | `app.use(helmet())` |
| Rate limiting | none | `ThrottlerModule` + `APP_GUARD` |
| Body size limit | Express 5's `express.json()` default of 100 kb | lower it, and cap multipart separately |
| `x-powered-by` | Express sets it | `helmet()` removes it |
| Error bodies | `HttpException` message only; non-HTTP errors become a generic 500 | keep it that way — do not echo `error.message` |

## Common mistakes

- **Auditing against the web-application Top 10:2025 and calling it an API audit.** Different list, different IDs. The API list is the 2023 edition.
- **Treating a guard as the answer to API1.** Guards run before the resource loads; they answer API5, not API1.
- **Assuming `@Roles('admin')` does something on its own.** Without a registered `RolesGuard` it is metadata nobody reads, and the route is open.
- **Reading API3 as "mass assignment".** It is both directions: what the client may write *and* what the client may read back.
- **Installing a rate limiter and considering API4 done.** Body limits, upload limits and pagination caps fail independently of the throttle.
- **`@IsUrl()` as an SSRF control.** It validates the shape of a string. Allow-list the host, resolve it, and refuse redirects.
- **Leaving `v1` routed because removing it "might break someone".** An answering endpoint is attack surface; an inventory you maintain by hand is not an inventory.
- **Trusting a webhook because it came from a provider.** The URL is public. Verify the signature over `request.rawBody`, which requires `rawBody: true`.
- **Reading `Access-Control-Allow-Origin: *` in a response and assuming it is harmless because there are no cookies.** It stops being harmless the day someone adds `credentials: true`.

## Related topics

- [Authorization and IDOR](authorization-and-idor.md) — API1 and API5 in full, with the service-layer fix.
- [Validation as a security control](validation-as-a-control.md) — API3 inbound, and why the pipe is a security boundary.
- [Rate limiting and abuse](rate-limiting.md) — API4 and API6 with `@nestjs/throttler` 6.5.0.
- [SQL injection](sql-injection.md) — injection in TypeORM, Prisma and raw `pg`.
- [NoSQL injection](nosql-injection.md) — Mongoose operator injection.
- [CORS](cors.md) and [Security headers](security-headers.md) — the two halves of API8 you configure in `main.ts`.
- [JWT pitfalls](jwt-pitfalls.md) and [Authentication and session security](authentication-and-session-security.md) — API2.
- [File upload security](file-upload-security.md) — API4 and API8 on the upload path.
- [Guards](../nestjs-request-handling/guards.md) — where function-level authorization belongs.
- [Versioning](../nestjs-request-handling/versioning.md) — the mechanism behind API9.
- [Serialization](../nestjs-validation/serialization.md) — the outbound half of API3.
- [OWASP API Top 10 in Express](../security/owasp-api-top-10.md) — the same list without the framework, including the full SSRF guard.
