---
title: Rate limiting
description: Configuring express-rate-limit 8 with a shared Redis store, correct client identification behind a proxy, and standard RateLimit headers.
status: current
updated: 2026-09-08
---

Rate limiting caps how often one client may hit an endpoint. It is the cheapest defense you have against credential stuffing, scraping, and accidental client retry storms — and the easiest to configure in a way that either does nothing or bans everyone behind a corporate NAT.

## Why it exists

Every expensive operation in your API — a password check, a database scan, an email send, an LLM call — has a per-request cost that an attacker does not pay. Without a limiter, one script can exhaust a connection pool, run up a bill, or brute-force a login at whatever rate your server can absorb.

Rate limiting turns "as fast as the server can go" into a number you chose.

## Installation

:::tabs
@tab npm
```bash
npm install express-rate-limit@8
```
@tab pnpm
```bash
pnpm add express-rate-limit@8
```
@tab yarn
```bash
yarn add express-rate-limit@8
```
:::

## Basic example

```js title="src/app.js"
import express from 'express'
import { rateLimit } from 'express-rate-limit'

const app = express()

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 300, // requests per window per client
  standardHeaders: 'draft-8',
  legacyHeaders: false,
})

app.use(limiter)

export default app
```

`windowMs` is a fixed window: the counter resets `windowMs` after the client's first request in that window, not on a rolling basis. A client can therefore send `limit` requests at the end of one window and `limit` again at the start of the next — a burst of `2 × limit`. That is acceptable for abuse control; it is not a traffic shaper.

Defaults if you omit them: `windowMs` 60000, `limit` 5, `statusCode` 429, `legacyHeaders` true, `standardHeaders` false. Always set all of them explicitly.

## The response headers

`standardHeaders` accepts `'draft-6'`, `'draft-7'` or `'draft-8'` (passing `true` means `'draft-6'`). The IETF drafts changed shape between versions, so the value you pick decides what clients see.

| Setting | Headers emitted |
| --- | --- |
| `'draft-6'` | `RateLimit-Policy: 300;w=900`, `RateLimit-Limit: 300`, `RateLimit-Remaining: 299`, `RateLimit-Reset: 900` |
| `'draft-7'` | `RateLimit-Policy: 300;w=900`, `RateLimit: limit=300, remaining=299, reset=900` |
| `'draft-8'` | `RateLimit: "default"; r=299; t=900`, `RateLimit-Policy: "default"; q=300; w=900; pk=:…:` |
| `legacyHeaders: true` | `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` (a Unix timestamp, not a duration) |

Draft-8 names each policy (the `identifier` option) so several limiters can advertise themselves on one response — a per-minute burst limit and a per-day quota, for instance, each appended as its own `RateLimit` entry.

`legacyHeaders` defaults to **`true`**, so an unconfigured limiter sends the old `X-RateLimit-*` set. Turn it off unless you have clients parsing it; sending both doubles the header bytes on every response for no benefit.

When the limit is exceeded, `Retry-After` is set to the seconds until reset. That header is the one generic HTTP clients actually understand — do not omit it.

:::warning
CORS hides these headers from browser JavaScript unless you list them. Add `RateLimit` and `RateLimit-Policy` (or the `X-RateLimit-*` names) to `exposedHeaders` — see [CORS](cors.md).
:::

## Identifying the client

The default `keyGenerator` uses `req.ip`, normalized through the exported `ipKeyGenerator` helper.

### The `trust proxy` trap

`req.ip` is the socket's remote address unless Express is told to trust a proxy. Behind a load balancer, every request appears to come from the balancer, so one shared counter throttles your entire user base at once.

The fix is `app.set('trust proxy', …)` — and the fix has its own trap.

```js vulnerable title="DO NOT COPY"
app.set('trust proxy', true)
```

With `true`, Express walks the whole `X-Forwarded-For` chain and takes the left-most address as `req.ip`. That header is client-supplied. An attacker sends `X-Forwarded-For: 1.2.3.4` and gets a fresh bucket for every value they invent — the limiter is now a no-op.

```js good title="src/app.js"
// The number is how many proxies sit between the client and you.
// One ALB / one nginx / one Cloudflare = 1. Count them; do not guess.
app.set('trust proxy', 1)
```

With a hop count, Express takes the address that many entries from the **right** of `X-Forwarded-For` — the one your own proxy wrote, which a client cannot forge. You can also pass a subnet string or a predicate function if your topology needs it.

`express-rate-limit` runs a set of startup validations and logs a warning when it detects a likely misconfiguration here (a trusted-proxy setting of `true`, an `X-Forwarded-For` that does not match, a custom `keyGenerator` that reads `req.ip` without the IPv6 helper). Do not silence them with `validate: false` until you have read what they said.

### IPv6

A single IPv6 customer is routinely handed a /64 — 18 quintillion addresses. Keying by the full address means one host can rotate through addresses forever and never hit a limit.

Version 8 handles this by hashing IPv6 addresses down to a subnet, controlled by `ipv6Subnet` (default `56`, useful range 32–64; lower is more aggressive). IPv4 addresses pass through unchanged, and IPv4-mapped IPv6 addresses like `::ffff:1.2.3.4` are reduced to the IPv4 form.

If you write your own `keyGenerator` and it touches the IP, you must route it through the helper:

```js title="src/security/rate-limit.js"
import { rateLimit, ipKeyGenerator } from 'express-rate-limit'

export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 300,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req) =>
    // Authenticated users get their own bucket; everyone else falls back to IP.
    req.user?.id ?? ipKeyGenerator(req.ip, 56),
})
```

Keying authenticated traffic by user ID is usually what you want: it survives the user changing networks, and it stops one user on a shared NAT from consuming everyone else's quota.

## Why an in-memory store breaks with more than one instance

The default `MemoryStore` keeps counters in the process heap. Run four instances behind a load balancer and each keeps its own count, so the effective limit is `4 × limit` — and it moves as you scale. Restart a process and every counter resets to zero, which is exactly the moment an attacker would like to have.

For anything beyond a single process, put the counters in Redis.

```bash
npm install rate-limit-redis@6 redis@6
```

```js title="src/security/rate-limit.js"
import { rateLimit, ipKeyGenerator } from 'express-rate-limit'
import { RedisStore } from 'rate-limit-redis'
import { createClient } from 'redis'

const redis = createClient({ url: process.env.REDIS_URL })
redis.on('error', (err) => console.error({ err }, 'redis error'))
await redis.connect()

export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 300,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  passOnStoreError: false,
  store: new RedisStore({
    prefix: 'rl:api:',
    sendCommand: (...args) => redis.sendCommand(args),
  }),
  keyGenerator: (req) => req.user?.id ?? ipKeyGenerator(req.ip, 56),
})
```

`sendCommand` is deliberately generic so the store works with any client. For `ioredis`, the signature differs:

```js
import RedisClient from 'ioredis'

const client = new RedisClient(process.env.REDIS_URL)

new RedisStore({
  sendCommand: (command, ...args) => client.call(command, ...args),
})
```

Give each limiter its own `prefix` (default `rl:`), or a strict login limiter and a loose global limiter will share counters.

`passOnStoreError` decides what happens when Redis is unreachable: `false` (the default) blocks the request, `true` lets it through. Failing closed protects the backend at the cost of a total outage when Redis blips; failing open keeps you serving but removes the limiter exactly when things are already going wrong. Pick deliberately, and alert on the error either way.

## Stricter limits on auth endpoints

A global limit tuned for normal browsing is far too loose for a login form. Layer a second, much tighter limiter on the endpoints that are worth attacking.

```js title="src/security/rate-limit.js"
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  identifier: 'auth',
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  skipSuccessfulRequests: true, // only failed attempts burn quota
  store: new RedisStore({ prefix: 'rl:auth:', sendCommand: (...a) => redis.sendCommand(a) }),
  keyGenerator: (req) => ipKeyGenerator(req.ip, 56),
})
```

```js title="src/routes/auth.js"
import { Router } from 'express'
import { authLimiter } from '../security/rate-limit.js'

const router = Router()

router.post('/login', authLimiter, async (req, res) => {
  // Async handlers need no wrapper in Express 5 — a rejection reaches
  // the error middleware on its own.
  const session = await login(req.body)
  res.status(201).json(session)
})

router.post('/password-reset', authLimiter, async (req, res) => {
  await requestPasswordReset(req.body.email)
  res.status(202).json({ ok: true })
})

export default router
```

`skipSuccessfulRequests: true` means a legitimate user who logs in successfully never consumes the budget, so you can set `limit` genuinely low. Note the mechanics: the hit is recorded on the way in and *decremented* after a 1xx/2xx/3xx response, so a slow flood still gets counted while in flight.

Also key password-reset and account-lookup limits by the **target account** as well as the IP, or an attacker with a botnet sprays one account from a thousand addresses and never trips a per-IP counter.

## A custom 429

The default handler sends `Too many requests, please try again later.` as text with a 429. For a JSON API, replace it.

```js title="src/security/rate-limit.js"
export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 300,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  handler: (req, res) => {
    const resetTime = req.rateLimit.resetTime
    const retryAfter = resetTime
      ? Math.ceil((resetTime.getTime() - Date.now()) / 1000)
      : Math.ceil(15 * 60)

    res.setHeader('Retry-After', String(retryAfter))
    res.status(429).json({
      error: 'rate_limited',
      message: 'Too many requests.',
      retryAfter,
    })
  },
})
```

Inside any handler downstream of the limiter, `req.rateLimit` holds `{ limit, used, remaining, resetTime, key }`. Rename the property with `requestPropertyName` if it collides.

Do not put the client's key or their remaining quota for *other* limiters into the error body — it is free reconnaissance.

## Where to register it

```js title="src/app.js"
import express from 'express'
import { apiLimiter } from './security/rate-limit.js'

const app = express()

app.set('trust proxy', 1)

// Health checks must not be rate limited — the load balancer polls them
// constantly and would take the instance out of service.
app.get('/healthz', (req, res) => res.json({ ok: true }))

app.use(apiLimiter)
app.use(express.json({ limit: '100kb' }))
app.use('/api', routes)
```

Register the limiter **before** body parsing. Rejecting a request before you read and parse a 100 KB body is the entire point of putting a limiter in front of it.

Use `skip` for exemptions rather than route ordering when the rule is dynamic:

```js
skip: (req) => req.path === '/healthz' || req.ip === '10.0.0.5',
```

## Security considerations

**A limiter keyed on a forgeable value is not a limiter.** `X-Forwarded-For` with `trust proxy: true`, an API key from an unauthenticated header, a `X-Client-Id` the client picks — all give the attacker unlimited buckets. Key on something your infrastructure controls or that authentication established.

**Per-IP limits punish shared networks.** A university, an office NAT, or a mobile carrier CGNAT can put thousands of users on one address. Key authenticated traffic by user ID and reserve IP keying for the unauthenticated surface.

**Rate limiting is not brute-force protection on its own.** Five attempts per 15 minutes per IP is trivially defeated by a botnet. Combine per-IP limits with per-account counters, exponential backoff on the account, and monitoring for distributed patterns. See [Rate limiting and abuse](../security/rate-limiting-and-abuse.md).

**Do not leak whether an account exists** through differential limits. If `POST /login` for a real user 429s after five tries but an unknown user gets a fast 404 forever, you have built a user enumeration oracle.

**Slow, expensive endpoints need their own budget.** A report export or a search query may cost a hundred times a normal request. A single count-based limit treats them identically; give the expensive routes their own limiter with a much lower `limit`.

**429 responses should be logged and alerted on.** A sustained spike is either an attack or a broken client, and both are worth knowing about within minutes.

## Production considerations

**Use a shared store, always, in production.** Even one instance today becomes two after the first autoscale event, and the failure is silent — the limit simply stops being the number you set.

**Redis is now on the request path.** Its latency is added to every request, its availability becomes yours (or not, depending on `passOnStoreError`), and its memory grows with your distinct-key count. Set a `maxmemory-policy` that evicts, and give the keys a prefix you can inspect.

**Prefer limiting at the edge when you have one.** A CDN or API gateway rejects abusive traffic before it reaches your process, costs you nothing, and survives your app being down. Application-level limiting is still worth having — it is the only layer that knows the authenticated user — but it is the second line, not the first.

**Get the proxy hop count right, per environment.** Local development has zero proxies; staging behind one ingress has one; production behind a CDN and a load balancer has two. A wrong count means either everyone shares a bucket or the header is forgeable.

**Watch the header cost.** `standardHeaders` plus `legacyHeaders` on every response is roughly 150 bytes per request. Pick one.

**Verify it under load, not by reading the config.** Fire more requests than the limit and confirm you see a 429 with `Retry-After`:

```bash
for i in $(seq 1 20); do
  curl -s -o /dev/null -w "%{http_code} " https://api.example.com/api/items
done; echo
```

Then repeat from a second instance's perspective to confirm the counters are shared, not per process.

## Common mistakes

- **Leaving the default `MemoryStore` in a multi-instance deployment.** The real limit becomes `instances × limit` and resets on every deploy.
- **`app.set('trust proxy', true)`.** Makes `req.ip` client-controlled. Use a hop count.
- **Forgetting `trust proxy` entirely behind a load balancer.** Every user shares one counter and the whole API 429s under normal traffic.
- **Writing a custom `keyGenerator` that returns `req.ip` directly.** IPv6 clients get a new key per address; the library warns about exactly this.
- **One global limiter and nothing tighter on `/login`.** The endpoint worth attacking gets the loosest setting you own.
- **Registering the limiter after `express.json()`.** You parse the body of every request you are about to reject.
- **Rate limiting the health-check path.** The load balancer trips the limit and removes a healthy instance from the pool.
- **Leaving `legacyHeaders` at its default `true`** and shipping two header sets forever.
- **Not exposing the headers through CORS,** then debugging a "missing" header that the server is sending correctly.
- **Suppressing the startup validation warnings with `validate: false`.** They exist because these misconfigurations are common and silent.
- **Treating the fixed window as a rolling window.** Clients can burst `2 × limit` across a boundary; size the limit knowing that.

## Related topics

- [Rate limiting and abuse](../security/rate-limiting-and-abuse.md) — distributed attacks, account lockout, and what a limiter cannot do.
- [Authentication](authentication.md) — the endpoints that need the strictest limits.
- [CORS](cors.md) — exposing `RateLimit` headers to browser clients.
- [Redis](../databases/redis.md) — running the store this page depends on.
- [Clustering](../production/clustering.md) — why one process's counters stop being the truth.
- [Logging](logging.md) — recording 429s so you can tell an attack from a broken client.
