---
title: OWASP API Top 10 in Express
description: The OWASP API Security Top 10 (2023 edition) mapped onto concrete Express 5 code, with one exploit and one fix per item.
status: current
updated: 2026-09-08
---

The OWASP API Security Top 10 is a separate list from the better-known OWASP Top 10 for web applications. It exists because APIs fail differently: there is no browser to blame, the vulnerabilities are almost all authorization and resource-consumption bugs, and they live in your handlers rather than in your templates. This page maps each item onto the Express code that produces it.

## Which edition this page uses

**OWASP API Security Top 10 — 2023 edition**, verified against <https://owasp.org/API-Security/> and <https://owasp.org/www-project-api-security/> on 2026-09-08. The 2023 edition is the current one; it replaced the 2019 edition. There is no 2025 edition of the *API* list — the 2025 edition you may have seen belongs to the separate [OWASP Top 10 for web applications](https://owasp.org/Top10/).

Item IDs are written as OWASP writes them: `API1:2023` through `API10:2023`.

| ID | Name | Where it lives in an Express app |
| --- | --- | --- |
| API1:2023 | Broken Object Level Authorization | The handler loads a row by `req.params.id` without scoping to the caller |
| API2:2023 | Broken Authentication | Token verification, login throttling, session lifecycle |
| API3:2023 | Broken Object Property Level Authorization | `Object.assign(user, req.body)`, and over-broad `res.json(user)` |
| API4:2023 | Unrestricted Resource Consumption | No body limit, no pagination cap, no rate limit |
| API5:2023 | Broken Function Level Authorization | An `/admin` router guarded by `requireAuth` but not `requireRole` |
| API6:2023 | Unrestricted Access to Sensitive Business Flows | Signup, checkout, coupon redemption scripted at machine speed |
| API7:2023 | Server Side Request Forgery | A handler that `fetch`es a URL from the request body |
| API8:2023 | Security Misconfiguration | Missing headers, `cors({ origin: true })`, stack traces in 500s |
| API9:2023 | Improper Inventory Management | `v1` still routed and unpatched after `v2` shipped |
| API10:2023 | Unsafe Consumption of APIs | Trusting an upstream provider's JSON as if it were yours |

## API1:2023 — Broken Object Level Authorization

**The threat.** Any authenticated user reads or edits any other user's records — the single most-exploited API bug, because it needs no tooling beyond changing a number.

**The manifestation in Express.** A handler that authenticates the caller and then ignores them:

:::danger
```js vulnerable title="DO NOT COPY"
app.get('/orders/:id', requireAuth, async (req, res) => {
  const order = await db.orders.findById(req.params.id)   // no owner check
  res.json(order)
})
```
:::

**The exploit.** `curl -H "Authorization: Bearer <user-B-token>" https://api.example.com/orders/1042` returns user A's order, address and total.

**The fix.** Scope the query by the owner, and return 404 when nothing matches:

```js good
app.get('/orders/:id', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, total_cents, status FROM orders WHERE id = $1 AND user_id = $2',
    [req.params.id, req.user.id],
  )
  if (rows.length === 0) return res.status(404).json({ error: 'not_found' })
  res.json(rows[0])
})
```

Full treatment, including nested resources and write paths: [IDOR and broken object-level authorization](broken-object-level-authorization.md).

## API2:2023 — Broken Authentication

**The threat.** An attacker becomes another user without stealing their password — by forging a token, replaying a session, or guessing credentials at scale.

**The manifestation in Express.** Two dominate: reading claims out of a JWT without verifying it, and a login route with no throttle.

:::danger
```js vulnerable title="DO NOT COPY"
const claims = jwt.decode(req.get('authorization').slice(7))
req.user = { id: claims.sub, role: claims.role }   // never verified
```
:::

**The exploit.** `Authorization: Bearer <base64url({"alg":"HS256"})>.<base64url({"sub":"1","role":"admin"})>.AAAA` — a token with a garbage signature — returns `200 {"sub":"1","role":"admin"}`.

**The fix.** `jwt.verify(token, key, { algorithms: ['RS256'], issuer, audience })`, plus a per-account and per-IP limiter on `POST /login`.

Deeper: [JWT pitfalls](jwt-pitfalls.md) and [Authentication and session security](authentication-and-session-security.md).

## API3:2023 — Broken Object Property Level Authorization

**The threat.** The caller writes a property they should not control (privilege escalation), or reads one they should not see (data exposure). The 2023 edition merged the old "mass assignment" and "excessive data exposure" items into this one because they are the same missing check on opposite sides of the handler.

**The manifestation in Express.**

:::danger
```js vulnerable title="DO NOT COPY"
app.patch('/users/me', requireAuth, async (req, res) => {
  const user = await db.users.findById(req.user.id)
  Object.assign(user, req.body)         // writes any property the client sends
  await user.save()
  res.json(user)                        // returns password_hash, mfa_secret, …
})
```
:::

**The exploit.** `curl -X PATCH -H 'content-type: application/json' -d '{"displayName":"Ann","role":"admin"}' .../users/me` returns `200` with `"role":"admin"`.

**The fix.** Parse the body with a strict schema and serialize the response through an explicit shape:

```js good
import { z } from 'zod'

const ProfileUpdate = z.strictObject({
  displayName: z.string().min(1).max(80).optional(),
  email: z.email().optional(),
})

const publicUser = (u) => ({ id: u.id, email: u.email, displayName: u.displayName })
```

Deeper: [Mass assignment](mass-assignment.md).

## API4:2023 — Unrestricted Resource Consumption

**The threat.** One client burns your CPU, memory, database connections or third-party billing quota. This is a denial-of-service item, but it also covers the SMS and email bills an attacker can run up on your account.

**The manifestation in Express.** `express.json()` with no `limit`, a `?limit=` that is passed straight to the database, and no rate limiter.

:::danger
```js vulnerable title="DO NOT COPY"
app.use(express.json())                                  // default 100kb, but…
app.get('/products', async (req, res) => {
  const rows = await db.products.findMany({ take: Number(req.query.limit) })
  res.json(rows)
})
```
:::

**The exploit.** `curl 'https://api.example.com/products?limit=10000000'` — `Number('10000000')` is happily passed through, and the process holds the whole result set in memory while serializing it.

**The fix.** Cap everything that is a number from the client, and set an explicit body limit:

```js good
app.use(express.json({ limit: '100kb' }))

app.get('/products', async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 20, 100)
  const rows = await db.products.findMany({ take: limit })
  res.json({ data: rows, limit })
})
```

Deeper: [Rate limiting and abuse](rate-limiting-and-abuse.md).

## API5:2023 — Broken Function Level Authorization

**The threat.** A regular user calls an administrative operation. The route is not linked from the UI, which is exactly why nobody wrote a check for it.

**The manifestation in Express.** A router mounted with the authentication middleware and nothing else:

:::danger
```js vulnerable title="DO NOT COPY"
app.use('/admin', requireAuth, adminRouter)   // authenticated ≠ authorized
```
:::

**The exploit.** `curl -X DELETE -H "Authorization: Bearer <any-valid-user-token>" https://api.example.com/admin/users/7` returns `204`.

**The fix.** Authorization is a separate middleware, and it is applied at the mount point so a new route inside the router cannot be added without it:

```js good
const requireRole = (...roles) => (req, res, next) => {
  if (!roles.includes(req.user.role)) return res.status(404).json({ error: 'not_found' })
  next()
}

app.use('/admin', requireAuth, requireRole('admin'), adminRouter)
```

Deeper: [IDOR and broken object-level authorization](broken-object-level-authorization.md) covers function-level authorization too.

## API6:2023 — Unrestricted Access to Sensitive Business Flows

**The threat.** The endpoint works exactly as designed; the harm comes from the *rate* and *automation*. Scalping every ticket, farming referral bonuses, brute-forcing discount codes, mass-creating accounts to poison your data.

**The manifestation in Express.** A correct, authorized, validated handler with no automation control:

:::danger
```js vulnerable title="DO NOT COPY"
app.post('/coupons/redeem', requireAuth, async (req, res) => {
  const coupon = await db.coupons.findByCode(req.body.code)
  if (!coupon) return res.status(404).json({ error: 'not_found' })
  res.json(await redeem(coupon, req.user.id))
})
```
:::

**The exploit.** A 40-line script POSTs 200,000 candidate codes in an hour and finds the live ones; every response distinguishes hit from miss.

**The fix.** Treat the *flow* as the resource. Rate-limit per account and per IP, add a cost to repetition, and cap total attempts per user per day:

```js good
import { rateLimit } from 'express-rate-limit'

const redeemLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req) => `redeem:${req.user.id}`,
})

app.post('/coupons/redeem', requireAuth, redeemLimiter, redeemCoupon)
```

Deeper: [Rate limiting and abuse](rate-limiting-and-abuse.md).

## API7:2023 — Server Side Request Forgery

**The threat.** Your server makes an HTTP request to an address the attacker chooses. Because that request originates inside your network, it reaches things the internet cannot: cloud metadata services, internal admin panels, databases bound to a private interface.

**The manifestation in Express.** Any handler that fetches a client-supplied URL — webhook testing, "import from URL", link previews, avatar-by-URL.

:::danger
```js vulnerable title="DO NOT COPY"
app.post('/webhooks/test', requireAuth, async (req, res) => {
  const upstream = await fetch(req.body.url)          // attacker picks the host
  res.json({ status: upstream.status, body: await upstream.text() })
})
```
:::

**The exploit.** `curl -X POST -d '{"url":"http://169.254.169.254/latest/meta-data/"}' .../webhooks/test` returns the cloud instance metadata document in `body`. On an unhardened instance the credentials path under it returns temporary IAM keys.

**The fix.** Allow-list the scheme, resolve the hostname yourself, reject private and link-local addresses, and refuse redirects (a public host can redirect to `169.254.169.254`):

```js good title="src/lib/safe-fetch.js"
import dns from 'node:dns/promises'
import net from 'node:net'

function isPrivate(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number)
    return a === 10 || a === 127 || a === 0 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127)
  }
  const v6 = ip.toLowerCase()
  return v6 === '::1' || v6 === '::' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe80')
}

export async function safeFetch(rawUrl, { timeoutMs = 5000 } = {}) {
  const url = new URL(rawUrl)
  if (url.protocol !== 'https:') throw new Error('only https is allowed')

  const addresses = await dns.lookup(url.hostname, { all: true })
  if (addresses.some(({ address }) => isPrivate(address))) {
    throw new Error('destination resolves to a private address')
  }

  return fetch(url, {
    redirect: 'error',                        // a 302 to the metadata IP must not be followed
    signal: AbortSignal.timeout(timeoutMs),
  })
}
```

:::warning
The DNS lookup and the connection are two separate resolutions, so a hostile DNS server can answer once with a public address and once with `169.254.169.254` (DNS rebinding). The lookup check raises the cost but does not close the hole. Where the risk matters, send outbound traffic through an egress proxy that enforces the destination allow-list at the network layer, or block the metadata endpoint at the instance level (IMDSv2 with a hop limit of 1 on AWS).
:::

## API8:2023 — Security Misconfiguration

**The threat.** The application code is fine; the deployment leaks. Verbose errors hand an attacker your stack layout, a permissive CORS policy hands your API to any origin, missing headers hand the browser no instructions.

**The manifestation in Express.** The default error handler in production, and reflected CORS:

:::danger
```js vulnerable title="DO NOT COPY"
app.use(cors({ origin: true, credentials: true }))  // reflects ANY Origin
// no error handler at all → Express prints the stack when NODE_ENV !== 'production'
```
:::

**The exploit.** `curl -H 'Origin: https://attacker.example' -H 'Cookie: sid=…' https://api.example.com/me -i` returns `Access-Control-Allow-Origin: https://attacker.example` and `Access-Control-Allow-Credentials: true`, so a page on `attacker.example` can read the authenticated response.

**The fix.** An explicit origin allow-list, Helmet for the headers, and a terminal error handler that never serializes `err.stack`:

```js good title="src/app.js"
import helmet from 'helmet'
import cors from 'cors'

const ALLOWED = new Set(['https://app.example.com'])

app.use(helmet())
app.use(cors({
  origin: (origin, cb) => cb(null, !origin || ALLOWED.has(origin)),
  credentials: true,
}))

// …routes…

app.use((err, req, res, next) => {
  req.log.error({ err }, 'unhandled error')
  res.status(err.status ?? 500).json({ error: err.expose ? err.message : 'internal_error' })
})
```

Deeper: [Security headers](security-headers.md), [CORS misconfiguration](cors-misconfiguration.md).

## API9:2023 — Improper Inventory Management

**The threat.** You cannot patch what you do not know is running. The vulnerable surface is the old version, the staging host with production data, and the debug route nobody removed.

**The manifestation in Express.** A `v1` router still mounted next to `v2`, sharing the process but not the fixes:

:::danger
```js vulnerable title="DO NOT COPY"
app.use('/v1', v1Router)   // shipped 2023, no longer reviewed
app.use('/v2', v2Router)   // where the authorization fix landed
```
:::

**The exploit.** `curl https://api.example.com/v1/users/1042` succeeds where `/v2/users/1042` returns 404 — the fix went into `v2` only.

**The fix.** Give every version an explicit sunset and make the app announce it, then delete the router on the date rather than "soon":

```js good
app.use('/v1', (req, res, next) => {
  res.set('Deprecation', 'true')
  res.set('Sunset', 'Wed, 31 Dec 2026 23:59:59 GMT')   // RFC 8594
  next()
}, v1Router)
```

Generate the API description from the code rather than maintaining it by hand, so an undocumented route is visibly a bug — see [API documentation](../express-libraries/api-documentation.md).

## API10:2023 — Unsafe Consumption of APIs

**The threat.** You validate what your users send and trust what your integrations send. An attacker who controls or compromises the upstream — a partner API, a webhook sender, a data feed — gets the trust you extended to it.

**The manifestation in Express.** A webhook receiver with no signature check and no schema:

:::danger
```js vulnerable title="DO NOT COPY"
app.post('/webhooks/payments', async (req, res) => {
  await db.orders.markPaid(req.body.orderId, req.body.amountCents)   // unauthenticated
  res.sendStatus(204)
})
```
:::

**The exploit.** `curl -X POST -H 'content-type: application/json' -d '{"orderId":"1042","amountCents":1}' https://api.example.com/webhooks/payments` marks a €900 order as paid. The endpoint is public; nothing proves the payload came from the provider.

**The fix.** Verify the provider's signature over the *raw* body, then validate the payload with the same rigor you apply to a user request:

```js good title="src/routes/webhooks.js"
import crypto from 'node:crypto'
import express from 'express'
import { z } from 'zod'

const PaymentEvent = z.strictObject({
  orderId: z.uuid(),
  amountCents: z.int().positive(),
  currency: z.enum(['EUR', 'USD']),
})

const router = express.Router()

// express.raw() so the signature is checked over the exact bytes that were signed.
router.post('/payments', express.raw({ type: 'application/json', limit: '64kb' }), async (req, res) => {
  const signature = Buffer.from(req.get('x-provider-signature') ?? '', 'hex')
  const expected = crypto.createHmac('sha256', process.env.PROVIDER_WEBHOOK_SECRET).update(req.body).digest()

  if (signature.length !== expected.length || !crypto.timingSafeEqual(signature, expected)) {
    return res.status(401).json({ error: 'bad_signature' })
  }

  const event = PaymentEvent.parse(JSON.parse(req.body.toString('utf8')))
  await markPaid(event)
  res.sendStatus(204)
})

export default router
```

The same rule applies to responses you *fetch*: set a timeout, cap the response size, and parse the JSON through a schema before it reaches your database. See [Validation](../express-libraries/validation.md) and [Retries and timeouts](../databases/retries-and-timeouts.md).

## Security considerations

This list is a checklist, not a threat model. Three things it deliberately does not cover, which you still own:

- **Injection.** The API list folded injection into API8 because it is well understood, not because it stopped happening. See [SQL injection](sql-injection.md) and [NoSQL injection](nosql-injection.md).
- **Browser-facing risks.** If any part of your service renders HTML or is called from a cookie-authenticated browser session, [XSS](xss.md) and [CSRF](csrf.md) apply and are not on this list.
- **Supply chain.** Your own dependencies are neither "your API" nor an API you consume, so nothing here covers them. See [Dependency auditing](dependency-auditing.md).

Map each item to a test, not to a paragraph. An assertion that user B receives 404 for user A's order will still be true next year; a note in a wiki will not.

## Common mistakes

- **Reaching for the wrong list.** The web-application OWASP Top 10 and the API Security Top 10 are different projects with different item names. Say which one you mean, with its year.
- **Reading API1 as "add a check after the fetch".** Fetching the row and then comparing `row.userId` still leaks existence through timing and through error branches. Put the owner in the `WHERE` clause.
- **Treating API4 as "install a rate limiter".** The limiter is one control. Body limits, pagination caps and query timeouts are the other three, and they fail independently.
- **Assuming API5 is covered by API1.** Object-level and function-level authorization are separate checks. `requireAuth` on an admin router satisfies neither.
- **Blocking SSRF with a string check on the URL.** `http://169.254.169.254` has dozens of encodings, and a public host can redirect. Resolve the address and refuse redirects.
- **Trusting a webhook because it is on HTTPS.** TLS proves you talked to *a* server, not that the payload came from your provider. Verify the signature over the raw body.
- **Leaving `v1` mounted "until the last client migrates".** Set the sunset date at launch, emit `Deprecation`/`Sunset`, and delete the router on that date.

## Related topics

- [IDOR and broken object-level authorization](broken-object-level-authorization.md) — API1 and API5 in full.
- [Authentication and session security](authentication-and-session-security.md) — API2 for sessions.
- [JWT pitfalls](jwt-pitfalls.md) — API2 for tokens.
- [Mass assignment](mass-assignment.md) — the write half of API3.
- [Rate limiting and abuse](rate-limiting-and-abuse.md) — API4 and API6.
- [Security headers](security-headers.md) — part of API8.
- [CORS misconfiguration](cors-misconfiguration.md) — the other part of API8.
- [SQL injection](sql-injection.md) — injection, which this list assumes you already handle.
- [NoSQL injection](nosql-injection.md) — the same for document stores.
- [File upload security](file-upload-security.md) — a resource-consumption and content-type surface the list treats only in passing.
- [Dependency auditing](dependency-auditing.md) — the supply chain the list does not cover.
