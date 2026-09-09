---
title: Rate limiting and abuse
description: The abuse patterns a limiter is supposed to stop, the X-Forwarded-For spoofing trap that silently disables it, and the other caps an API needs.
status: current
updated: 2026-09-08
---

A rate limiter is one control against a family of problems: credential stuffing, enumeration, scraping, expensive-endpoint denial of service, and resource exhaustion. It is also the control that most often does nothing, because it is keyed on an attacker-controlled value. This page is about the abuse and the traps; the middleware's own options live on [Rate limiting](../express-libraries/rate-limiting.md).

## What you are defending against

| Abuse | What the traffic looks like | The control that actually works |
| --- | --- | --- |
| Credential stuffing | many accounts, few attempts each, one source | per-account counter + MFA + breached-password screening |
| Enumeration | one endpoint, sequential ids or emails, uniform timing | identical responses, per-user cap, 404-not-403 |
| Scraping | high volume, valid session, full pagination sweep | pagination caps, per-user quota, cost accounting |
| Expensive-endpoint DoS | low volume, high CPU or IO per request | input caps, query timeouts, safe regexes |
| Resource exhaustion | large bodies, many uploads, slow reads | body limits, upload limits, server timeouts |

Note what a per-IP limiter does *not* stop: the first row (one attempt per account from thousands of IPs) and the fourth (ten requests can saturate every core). Rate limiting is necessary and insufficient.

## The `trust proxy` trap

**The threat.** Your limiter keys on `req.ip`. Behind a proxy, `req.ip` is derived from `X-Forwarded-For`, which is a request header — the client sends it. Configure `trust proxy` wrongly and the attacker picks their own key, so every request looks like a new client and the limiter never fires. The limiter is present, configured, tested by hand, and completely ineffective.

**The exploit.** With `app.set('trust proxy', true)`:

```bash
$ for i in $(seq 1 100); do
    curl -s -o /dev/null -w '%{http_code} ' -X POST https://api.example.com/login \
      -H "X-Forwarded-For: 10.0.0.$i" \
      -H 'content-type: application/json' \
      -d '{"email":"ann@example.com","password":"guess'"$i"'"}'
  done
401 401 401 401 401 401 401 ... 401      # never a single 429
```

Here is why, measured against Express 5.2.1 with a request carrying `X-Forwarded-For: 9.9.9.9, 203.0.113.7` (the attacker sent `9.9.9.9`; the real proxy appended `203.0.113.7`, the true client address):

| `trust proxy` | `req.ip` | Verdict |
| --- | --- | --- |
| unset | `::ffff:127.0.0.1` | every request looks like the proxy — one shared bucket for the world |
| `true` | `9.9.9.9` | **attacker-controlled** — the limiter is disabled |
| `1` | `203.0.113.7` | correct for exactly one proxy hop |
| `2` | `9.9.9.9` | attacker-controlled again — you claimed two hops and there is one |
| `'loopback'` | `203.0.113.7` | correct when the only proxy is on localhost |

:::danger
```js vulnerable title="DO NOT COPY"
app.set('trust proxy', true)          // trust every hop, including the client's forgery
app.use(rateLimit({ windowMs: 60_000, limit: 5 }))
```
:::

**The fix.** `trust proxy` is a count of proxies **you** operate, counted from the right. One load balancer is `1`. A CDN in front of a load balancer is `2`. Never `true` on a public service.

```js good title="src/app.js"
import express from 'express'

const app = express()

// Exactly the number of proxies between the internet and this process.
// ALB only → 1.  CloudFront → ALB → 2.  Direct exposure → do not set it at all.
app.set('trust proxy', Number(process.env.TRUSTED_PROXY_HOPS ?? 1))
```

If your infrastructure gives you a header the edge writes and clients cannot forge — `CF-Connecting-IP` from Cloudflare, `True-Client-IP` from some CDNs — prefer it, but only if the edge strips the client's copy. Verify that; do not assume it.

**Verify the fix.** The spoof no longer works:

```bash
$ for i in $(seq 1 8); do
    curl -s -o /dev/null -w '%{http_code} ' -X POST https://api.example.com/login \
      -H "X-Forwarded-For: 10.0.0.$i" -H 'content-type: application/json' \
      -d '{"email":"ann@example.com","password":"x"}'
  done
401 401 401 401 401 429 429 429
```

And a route that echoes what the app believes:

```js title="src/routes/debug.js — staging only"
router.get('/whoami', (req, res) => res.json({ ip: req.ip, ips: req.ips }))
```

```bash
$ curl -s -H 'X-Forwarded-For: 1.2.3.4' https://staging.example.com/whoami
{"ip":"203.0.113.7","ips":["203.0.113.7"]}     # the forgery is ignored — correct
```

:::warning
`express-rate-limit` 8.7.0 runs a startup validation check for exactly this misconfiguration and logs a warning when it detects a permissive `trust proxy` together with an `X-Forwarded-For` header. Read that warning instead of silencing it with `validate: false`. Turning the check off is not the same as fixing the setting.
:::

## Choosing the key

The key decides what the limit means. Most APIs need more than one limiter, at different scopes.

| Key | Stops | Fails against | Use for |
| --- | --- | --- | --- |
| IP | naive scripts, one noisy client | botnets, NAT'd offices share a bucket | a coarse global floor |
| Authenticated user id | one account scraping or enumerating | attacker registering many accounts | quotas on authenticated endpoints |
| Target account (the email being tried) | credential stuffing, password spraying | nothing — the attacker cannot rotate it | login, password reset, MFA verify |
| API key / tenant | one customer degrading others | — | B2B APIs, per-plan quotas |
| Route + key | one expensive endpoint | — | anything with an unusual cost |

```js good title="src/middleware/limits.js"
import { rateLimit, ipKeyGenerator } from 'express-rate-limit'

// Global floor: coarse, keyed on IP, generous enough that real users never see it.
export const globalLimiter = rateLimit({
  windowMs: 60_000,
  limit: 300,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req) => ipKeyGenerator(req.ip, 56),
})

// Authenticated quota: falls back to the IP for anonymous callers.
export const userLimiter = rateLimit({
  windowMs: 60_000,
  limit: 120,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req) => (req.user ? `u:${req.user.id}` : ipKeyGenerator(req.ip, 56)),
})

// Credential stuffing: keyed on the account under attack, not on the attacker.
export const loginLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 5,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => `login:${String(req.body?.email ?? '').toLowerCase()}`,
})
```

:::warning
A `keyGenerator` that reads `req.body` requires the body parser to have run first, and in Express 5 `req.body` is `undefined` when nothing parsed it. `String(req.body?.email ?? '')` is not defensive style — without it the limiter throws on a bodyless `POST` and turns your login route into a 500.
:::

## IPv6: never key on a single address

**The threat.** A residential IPv6 allocation is typically a `/64` — that is 18 quintillion addresses, all belonging to one customer. Keying a limiter on the full 128-bit address means an attacker rotates the low 64 bits and gets a fresh bucket every request, for free, with no proxies and no botnet.

**The exploit.** Same as the `X-Forwarded-For` spoof, but it works even when `trust proxy` is correct, because these are genuinely different source addresses:

```bash
$ for i in $(seq 1 100); do
    curl -s --interface "2001:db8:1234:5678::$i" -o /dev/null -w '%{http_code} ' \
      https://api.example.com/search?q=x
  done
200 200 200 200 ... 200
```

**The fix.** Group IPv6 by prefix. `express-rate-limit` 8.7.0 does this by default and exposes the knob:

```js good
rateLimit({
  windowMs: 60_000,
  limit: 100,
  ipv6Subnet: 56,      // 32–64, or false to disable. Lower = more aggressive grouping.
})
```

When you write your own `keyGenerator`, run the address through the exported helper rather than using `req.ip` raw — this is the single most common way a custom key generator reintroduces the bug:

```js good
import { ipKeyGenerator } from 'express-rate-limit'

keyGenerator: (req) => (req.user ? `u:${req.user.id}` : ipKeyGenerator(req.ip, 56))
```

```js
ipKeyGenerator('2001:db8:1234:5678:aaaa:bbbb:cccc:dddd', 56)  // → '2001:db8:1234:5600::/56'
ipKeyGenerator('203.0.113.7')                                 // → '203.0.113.7'
```

A `/56` groups a residential allocation without merging an entire ISP. `/64` is less aggressive, `/48` more so. There is no setting that is both precise and safe here — IPv6 makes per-address limiting meaningless, and grouping means some shared prefixes share a bucket.

## In-memory counters are meaningless behind more than one instance

**The threat.** The default store is a `Map` in one process. With N instances behind a load balancer, your limit of 5 is a limit of 5×N, and it resets on every deploy, every crash, and every autoscaling event.

**The exploit.** Nothing is even needed — round-robin load balancing does it by accident:

```bash
# limit: 5 per 15 minutes, three instances behind the load balancer
$ for i in $(seq 1 15); do
    curl -s -o /dev/null -w '%{http_code} ' -X POST https://api.example.com/login \
      -H 'content-type: application/json' -d '{"email":"ann@example.com","password":"x"}'
  done
401 401 401 401 401 401 401 401 401 401 401 401 401 401 401     # 15 attempts, no 429
```

**The fix.** A shared store. `rate-limit-redis` 6.0.1 keeps the counters in Redis, so every instance increments the same key:

```js good title="src/middleware/limits.js"
import { rateLimit, ipKeyGenerator } from 'express-rate-limit'
import { RedisStore } from 'rate-limit-redis'
import { createClient } from 'redis'

const redis = createClient({ url: process.env.REDIS_URL })
await redis.connect()

export const loginLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 5,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => `login:${String(req.body?.email ?? '').toLowerCase()}`,
  store: new RedisStore({
    sendCommand: (...args) => redis.sendCommand(args),
    prefix: 'rl:',
  }),
  // Default is false: if Redis is unreachable, block rather than let everything through.
  passOnStoreError: false,
})
```

`passOnStoreError` is the decision nobody makes deliberately until an incident. `false` (the default) fails closed: a Redis outage returns 429 to everyone. `true` fails open: a Redis outage removes every limit at once, which is precisely when an attacker is most likely to be causing the outage. Choose per limiter — fail open on a generous global floor, fail closed on login.

## Expensive endpoints

Rate limits are counted in requests. Damage is done in CPU-seconds. When one request costs a thousand times another, a limiter tuned for the cheap one lets the expensive one through.

### A regex that backtracks

**The threat.** JavaScript regexes backtrack. A pattern with nested quantifiers over overlapping character classes takes exponential time on a non-matching input, and it runs on the event loop — so one request stalls **every** concurrent request in that process.

:::danger
```js vulnerable title="DO NOT COPY"
// Looks like a harmless "words separated by spaces" check.
const NAME = /^(\w+\s?)*$/

app.post('/profile', express.json(), (req, res) => {
  if (!NAME.test(req.body.displayName)) return res.status(400).json({ error: 'bad_name' })
  res.json({ ok: true })
})
```
:::

**The exploit.** A string of `a`s followed by one character the pattern cannot match. Measured on Node with `'a'.repeat(n) + '!'`:

| Input length | `NAME.test()` blocking time |
| --- | --- |
| 26 | 0.5 s |
| 28 | 1.8 s |
| 30 | 7.2 s |
| 32 | 30 s |

```bash
$ curl -s -X POST https://api.example.com/profile \
    -H 'content-type: application/json' \
    -d '{"displayName":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!"}' \
    -w '\ntime: %{time_total}s\n'
{"error":"bad_name"}
time: 30.1s
```

Thirty-two bytes. Under any request-count limit you would ever set. Six such requests in flight and a four-core instance serves nothing at all — including its health check, so the orchestrator restarts it, and the next instance gets the same six requests.

**The fix.** Three layers, in order of how much they help:

```js good title="src/routes/profile.js"
import { z } from 'zod'

// 1. Bound the input BEFORE the pattern runs. Exponential time on 32 bytes is fine;
//    on 4096 bytes it is a permanent outage.
// 2. Use a pattern with no nested quantifier over overlapping classes.
const DisplayName = z.string().min(1).max(80).regex(/^[\p{L}\p{N}]+(?: [\p{L}\p{N}]+)*$/u)

app.post('/profile', express.json({ limit: '16kb' }), (req, res) => {
  const parsed = z.strictObject({ displayName: DisplayName }).safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: 'bad_name' })
  res.json({ ok: true })
})
```

`^[\p{L}\p{N}]+(?: [\p{L}\p{N}]+)*$` has no ambiguity: each position is matched by exactly one alternative, so there is nothing to backtrack into. The `.max(80)` runs first, which caps the worst case even if the pattern is later changed by someone who does not know this.

For patterns you did not write — a validation library, a user-supplied search pattern — do not run them on the main thread. There is no way to abort a running regex in-process; the only reliable timeout is a worker you can terminate.

### An unbounded query

**The threat.** The same shape without the regex: a filter the client controls that turns into a full table scan, a `LIKE '%…%'` on an unindexed column, or an aggregation across every row.

:::danger
```js vulnerable title="DO NOT COPY"
app.get('/search', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM documents WHERE body ILIKE $1',
    [`%${req.query.q}%`],
  )
  res.json(rows)
})
```
:::

The query is parameterized — there is no SQL injection here — and it still takes down the database. `GET /search?q=e` scans every row of a 40-million-row table and returns most of them.

**The fix.** Minimum input length, a hard `LIMIT`, a statement timeout, and a real index:

```js good title="src/routes/search.js"
app.get('/search', requireAuth, searchLimiter, async (req, res) => {
  const q = String(req.query.q ?? '').trim()
  if (q.length < 3) return res.status(400).json({ error: 'query_too_short' })

  const limit = Math.min(Number(req.query.limit) || 20, 100)

  const client = await pool.connect()
  try {
    // SET LOCAL is scoped to the transaction, so the timeout cannot leak into the
    // next request that borrows this pooled connection.
    await client.query('BEGIN')
    await client.query('SET LOCAL statement_timeout = 2000')

    const { rows } = await client.query(
      `SELECT id, title, ts_headline('english', body, query) AS snippet
         FROM documents, websearch_to_tsquery('english', $1) query
        WHERE search_vector @@ query
        ORDER BY ts_rank(search_vector, query) DESC
        LIMIT $2`,
      [q, limit],
    )

    await client.query('COMMIT')
    res.json({ data: rows, limit })
  } catch (err) {
    await client.query('ROLLBACK')
    throw err                       // Express 5 forwards this to the error handler
  } finally {
    client.release()
  }
})
```

A statement timeout is the only one of these the application cannot accidentally remove. Set it, per transaction, on anything a user can influence.

## Body size limits

**The threat.** `express.json()` buffers the entire body in memory before your handler runs. Without a limit, N concurrent clients each streaming a large body multiply straight into heap.

Express's parsers default to `100kb`, which is a reasonable floor but is applied globally — including to the upload route where you then raised it and forgot to lower it back.

```js good title="src/app.js"
// Global default: small. Individual routes opt into more.
app.use(express.json({ limit: '100kb' }))
app.use(express.urlencoded({ extended: false, limit: '100kb' }))

// One route that genuinely needs a bigger body.
app.post('/documents/import', express.json({ limit: '2mb' }), importDocuments)
```

An oversized body produces a `413` from the parser, surfaced through your error handler:

```bash
$ head -c 200000 /dev/zero | tr '\0' 'a' | \
    curl -s -X POST https://api.example.com/profile \
    -H 'content-type: application/json' --data-binary @- -w '\n%{http_code}\n'
{"error":"entity.too.large"}
413
```

```js good title="src/middleware/errors.js"
export function errorHandler(err, req, res, next) {
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'payload_too_large', limit: err.limit })
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'invalid_json' })
  }
  req.log.error({ err }, 'unhandled error')
  res.status(err.status ?? 500).json({ error: 'internal_error' })
}
```

Body limits do not cover file uploads (those stream through `multer` 2.3.0 with its own `limits`) and they do not cover a slow client holding a connection open — that needs `server.requestTimeout` and `server.headersTimeout`. See [File upload security](file-upload-security.md).

## Pagination and query complexity caps

**The threat.** Scraping does not look like an attack. It is a logged-in user calling a legal endpoint with a legal parameter, just all of them.

Three caps, all cheap:

```js good title="src/lib/pagination.js"
const MAX_LIMIT = 100
const DEFAULT_LIMIT = 20

export function pagination(query) {
  const limit = Math.min(Math.max(Number(query.limit) || DEFAULT_LIMIT, 1), MAX_LIMIT)
  // Cursor pagination, not OFFSET: OFFSET 500000 makes the database read 500,000 rows
  // to discard them, so deep pages cost more than shallow ones — a free DoS.
  const cursor = typeof query.cursor === 'string' ? query.cursor : null
  return { limit, cursor }
}
```

- **Cap `limit`.** Silently, to a maximum — do not 400, because a legitimate client asking for 1000 should get 100 and a `limit` field in the response telling it so.
- **Prefer cursor pagination.** `OFFSET` grows in cost with depth; a cursor does not. It also stops the "page 40,000" sweep from being cheaper than it should be.
- **Cap expansion.** `?include=author,comments,comments.author` multiplies queries. Allow-list the expandable relations and cap the depth at one or two.

```js good
const EXPANDABLE = new Set(['author', 'comments'])

const include = String(req.query.include ?? '')
  .split(',')
  .filter((name) => EXPANDABLE.has(name))
  .slice(0, 2)
```

Beyond a limiter, a per-user *quota* — rows returned per day, not requests per minute — is what actually distinguishes a scraper from a heavy user. Count what you serve, not just how often you are asked.

## Slow down, hard block, and escalation

A hard block is a blunt instrument: it is visible to the attacker (who backs off to just under the limit) and it hurts legitimate bursts. A graduated response works better.

| Response | Effect on an attacker | Effect on a real user | Use when |
| --- | --- | --- | --- |
| Delay (`express-slow-down` 3.1.1) | throughput collapses; still succeeds | a slow page, no error | mild overuse, scraping |
| 429 with `Retry-After` | clean signal to back off | a clear, retryable error | a real limit was reached |
| CAPTCHA challenge | needs a solving service; raises unit cost | one friction step | login and signup under attack |
| Proof of work | costs CPU per attempt | a second of client CPU | abuse without an account to gate on |
| Ban | stops that identity | locks out a shared NAT | confirmed, sustained abuse |

Escalate on evidence, not on suspicion. A reasonable ladder for a login route: unthrottled for the first three attempts per account, delayed for the next few, CAPTCHA after ten failures from one IP in ten minutes, and a temporary account lock with an email notification after twenty.

CAPTCHA and proof of work both raise the *unit cost* of an attempt rather than blocking it. That is the right frame: stuffing is profitable at $0.0001 per attempt and unprofitable at $0.01. Neither stops a determined attacker, and both cost real users something — so gate them behind evidence of abuse rather than applying them to every request.

## Return 429 correctly

A limiter that clients cannot cooperate with generates retry storms. Emit the standard signals:

```js good
import { rateLimit } from 'express-rate-limit'

export const apiLimiter = rateLimit({
  windowMs: 60_000,
  limit: 100,
  standardHeaders: 'draft-8',   // RateLimit: "100-in-1min"; r=0; t=42
  legacyHeaders: false,         // drop the old X-RateLimit-* headers
  handler: (req, res) => {
    res.status(429).json({
      error: 'rate_limited',
      retryAfter: Number(res.get('Retry-After')),
    })
  },
})
```

`express-rate-limit` sets `Retry-After` on a 429 for you. The response looks like this:

```bash
$ curl -si https://api.example.com/search | head -8
HTTP/1.1 429 Too Many Requests
RateLimit: "100-in-1min"; r=0; t=42
Retry-After: 42
Content-Type: application/json; charset=utf-8

{"error":"rate_limited","retryAfter":42}
```

- **429, not 403.** 403 means "never"; 429 means "not right now".
- **Always `Retry-After`.** Without it, clients retry immediately and turn your limit into a hot loop.
- **Never leak the counter in a way that helps enumeration.** A 429 on a *wrong* password and a 200 on a correct one still distinguishes accounts — that is why the login limiter above uses `skipSuccessfulRequests` and keys on the target account.

## Testing it

```js title="test/limits.test.js"
import { test } from 'node:test'
import assert from 'node:assert/strict'
import request from 'supertest'
import app from '../src/app.js'

test('a spoofed X-Forwarded-For does not create a new bucket', async () => {
  const attempt = (i) =>
    request(app)
      .post('/login')
      .set('X-Forwarded-For', `10.0.0.${i}`)
      .send({ email: 'target@example.com', password: 'x' })

  for (let i = 1; i <= 5; i++) assert.equal((await attempt(i)).status, 401)

  const blocked = await attempt(99)
  assert.equal(blocked.status, 429, 'rotating X-Forwarded-For must not bypass the limiter')
  assert.ok(blocked.headers['retry-after'])
})

test('limit is capped server-side', async () => {
  const res = await request(app).get('/search?q=node&limit=100000').expect(200)
  assert.equal(res.body.limit, 100)
  assert.ok(res.body.data.length <= 100)
})

test('an oversized body is rejected before the handler runs', async () => {
  const res = await request(app)
    .post('/profile')
    .set('content-type', 'application/json')
    .send(JSON.stringify({ displayName: 'a'.repeat(200_000) }))

  assert.equal(res.status, 413)
})
```

Run with `node --test`.

## Security considerations

- **A limiter keyed on a spoofable value is worse than no limiter**, because it looks like a control in a review.
- **Rate limiting does not fix credential stuffing.** It raises the cost. MFA and breached-password screening are the controls that stop it — see [Authentication and session security](authentication-and-session-security.md).
- **Do not let the limiter itself become an enumeration oracle.** Identical responses matter more than the counter.
- **The limiter runs after the body parser but before your handler.** Anything a request costs before the limiter — TLS, parsing, decompression — is still spent on blocked requests. Put the cheapest checks earliest, and put volumetric defense at the edge.
- **`passOnStoreError: true` disables every limit during a Redis outage.** That is a deliberate availability trade, not a default to leave unexamined.

## Production considerations

- **Layer edge and application limits.** A CDN or WAF absorbs volumetric floods far more cheaply than Node. Application limits exist for the per-account and per-route logic the edge cannot see.
- **Size Redis for the limiter.** One key per active bucket, each with a TTL of `windowMs`. Use a dedicated database or key prefix so a limiter flood cannot evict your cache.
- **Emit metrics per limiter.** `rate_limit_blocked_total{limiter="login"}` is your stuffing alarm. Blocked-to-allowed ratio per route tells you whether a limit is tuned or just annoying.
- **Exempt your own health checks and internal callers** with `skip`, keyed on a network range or an internal credential — never on a header a client could send.
- **Publish the limits.** Document the window and the limit in your API description so integrators back off correctly instead of hammering and filing a support ticket.
- **Test the limiter against the deployed topology, not against localhost.** The `trust proxy` value is only correct for one topology, and adding a CDN silently changes it.

## Common mistakes

- **`app.set('trust proxy', true)` on a public service.** The limiter, `req.ip`, and every IP-based log field become attacker-controlled.
- **Silencing the `express-rate-limit` proxy warning with `validate: false`.** The warning is the control working.
- **Keying on the full IPv6 address.** 2^64 free buckets per customer.
- **The default memory store in a multi-instance deployment.** Your limit is multiplied by the instance count and reset on every deploy.
- **Reading `req.body` in a `keyGenerator` without `?.`.** Express 5 gives `undefined` when nothing parsed the body, and the limiter throws.
- **One global limiter and nothing else.** Login needs a per-account limit; search needs a cost limit; neither is a request count.
- **Rate limiting instead of capping input.** A 32-byte body can burn 30 CPU-seconds. No request-per-minute figure covers that.
- **No `LIMIT` and no statement timeout on a user-driven query.** Parameterized is not the same as bounded.
- **`OFFSET`-based deep pagination.** Page 40,000 costs 40,000 rows of work before the first result.
- **403 instead of 429, or 429 without `Retry-After`.** Clients cannot back off correctly and retry immediately.
- **Applying a CAPTCHA to every request.** You have taxed your users and inconvenienced the attacker.

## Related topics

- [Rate limiting](../express-libraries/rate-limiting.md) — `express-rate-limit` options, stores and header drafts in full.
- [Authentication and session security](authentication-and-session-security.md) — credential stuffing, lockout and enumeration.
- [IDOR and broken object-level authorization](broken-object-level-authorization.md) — what enumeration finds once it is not throttled.
- [File upload security](file-upload-security.md) — size and type limits for multipart bodies.
- [HTTPS and TLS](https-and-tls.md) — `trust proxy` and `req.secure` at the proxy boundary.
- [Performance](../production/performance.md) — event-loop blocking, of which ReDoS is the malicious case.
- [Retries and timeouts](../databases/retries-and-timeouts.md) — statement timeouts and connection limits.
- [Validation](../express-libraries/validation.md) — the input caps that make cost limits enforceable.
- [OWASP API Top 10 in Express](owasp-api-top-10.md) — API4:2023 and API6:2023.
