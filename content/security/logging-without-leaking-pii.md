---
title: Logging without leaking PII
description: What must never reach a log line, how to configure pino redaction so it actually matches, and why an immutable log store makes an erasure request unanswerable.
status: current
updated: 2026-09-09
---

Your log platform is a second copy of a large fraction of your data, replicated across indices, shipped to a vendor, backed up, and readable by everyone with an on-call login. Every credential and every personal field that reaches it is now stored in a system with weaker access control than your database and no deletion story.

The failures here are not exotic. A default `pino-http` configuration logs request headers wholesale, which means `Authorization` and `Cookie` in plaintext. An error object from an HTTP client carries the bearer token it was called with. A password-reset URL lands in an access log. None of these look like bugs in review.

## What must never appear in a log line

| Category | Examples | Why it is absolute |
| --- | --- | --- |
| Credentials | passwords, `Authorization` values, session cookies, API keys, refresh tokens, OTP codes, reset tokens, MFA secrets, private keys | A logged credential is a live credential. Log retention is now credential lifetime. |
| Payment data | full card number, CVV, full magnetic-stripe or chip data | Card schemes require the PAN to be masked wherever it is displayed or stored, and forbid retaining the CVV after authorization at all. |
| Government identifiers | national ID, passport, tax ID, driver's licence | Not rotatable. A leak is permanent for the person affected. |
| Special-category data | health, biometrics, religion, sexual orientation, trade-union membership | Higher legal bar, and no operational reason to have it in a log. |
| Whole request bodies on auth and payment routes | `POST /auth/login`, `/auth/register`, `/auth/reset`, `/checkout` | These bodies are made of the two rows above. |
| Whole response bodies | any | Whatever the endpoint returns, it is now in the log too — including the fields your serializer was carefully hiding. |

Below that line there is a judgement call. Email addresses, IP addresses, user agents and account IDs are personal data under GDPR, and they are also the fields that make an incident investigable. The workable position is: log them deliberately, in named fields, with a retention period you can state — and log a pseudonymous internal ID rather than an email wherever the ID is enough.

## The leak, and the same line redacted

Here is a real default. `pino-http` serializes `req.headers`, and the handler logs the parsed body because "we needed to debug signups":

:::danger
```js vulnerable title="DO NOT COPY — src/routes/auth.js"
app.post('/auth/login', express.json(), async (req, res) => {
  req.log.info({ body: req.body, user: await lookup(req.body.email) }, 'login attempt')
  // …
})
```
:::

One line of output, wrapped here for readability:

```json
{"level":"info","time":1788000000000,"service":"api",
 "req":{"id":8,"method":"POST","url":"/auth/login?next=%2Fbilling",
   "headers":{"host":"api.example.com","user-agent":"Mozilla/5.0",
     "authorization":"Bearer eyJhbGciOiJSUzI1NiIsImtpZCI6IjIifQ.eyJzdWIiOiIxMDQyIn0.Qk7x9",
     "cookie":"sid=8f2a1c94b7e0d3; ab_bucket=2",
     "x-api-key":"sk_live_9f3ad2c1"}},
 "body":{"email":"ann@example.com","password":"hunter2","otp":"418922"},
 "user":{"id":1042,"ssn":"123-45-6789","dateOfBirth":"1988-04-02"},
 "msg":"login attempt"}
```

That single line contains a valid session cookie, a valid bearer token, a live API key, a plaintext password, a one-time code, and a national ID. It is now in an index, in a snapshot of that index, and in whatever your platform ships to cold storage.

With the redaction configuration below, the same call produces:

```json
{"level":"info","time":1788000000000,"service":"api",
 "req":{"id":8,"method":"POST","url":"/auth/login?next=%2Fbilling",
   "headers":{"host":"api.example.com","user-agent":"Mozilla/5.0",
     "authorization":"[Redacted]","cookie":"[Redacted]","x-api-key":"[Redacted]"}},
 "body":{"email":"ann@example.com","password":"[Redacted]","otp":"[Redacted]"},
 "user":{"id":1042,"ssn":"[Redacted]","dateOfBirth":"[Redacted]"},
 "msg":"login attempt"}
```

Useful for debugging, and no longer a breach. Note what redaction did *not* fix: the whole body is still being logged, so the next field someone adds to the signup form is leaked until somebody remembers to add a path. Redaction is the safety net. Logging named fields is the control.

## Redaction with pino

`redact` takes an array of paths into the object you are logging, a `censor`, and a `remove` flag. pino 10.3.1:

```js good title="src/logger.js"
import pino from 'pino'

export const redact = {
  paths: [
    // --- request and response credentials, where pino-http puts them ---
    'req.headers.authorization',
    'req.headers.cookie',
    'req.headers["x-api-key"]',
    'req.headers["proxy-authorization"]',
    'res.headers["set-cookie"]',

    // --- secret-shaped fields, at the top level and one level down ---
    'password',
    '*.password',
    'newPassword',
    '*.newPassword',
    'token',
    '*.token',
    'refreshToken',
    '*.refreshToken',
    'otp',
    '*.otp',
    'secret',
    '*.secret',

    // --- named personal fields, nested ---
    'user.ssn',
    'user.dateOfBirth',
    'customer.taxId',
    'body.password',
    'body.otp',

    // --- every element of an array ---
    'items[*].cardNumber',
    'items[*].cvv',
    'paymentMethods[*].number',

    // --- credentials that ride along inside an error object ---
    'err.config.headers.authorization',
    'err.config.headers.Authorization',
    'err.request.headers.authorization',
    'err.response.config.headers.authorization',
  ],
  censor: '[Redacted]',
}

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: process.env.SERVICE_NAME ?? 'api', env: process.env.NODE_ENV },
  redact,
  formatters: { level: (label) => ({ level: label }) },
})
```

### Path syntax that actually matches

Most redaction failures are paths that never match anything. pino gives you no error for a path that matches nothing, so a typo is silent.

| Pattern | Matches | Does not match |
| --- | --- | --- |
| `user.ssn` | `{ user: { ssn } }` | `{ customer: { ssn } }`, `{ user: { profile: { ssn } } }` |
| `*.password` | `{ user: { password } }`, `{ body: { password } }` | `{ password }` at the top level, `{ a: { b: { password } } }` |
| `password` | `{ password }` at the top level only | anything nested |
| `items[*].cardNumber` | every element of the `items` array | `payment.items[*].cardNumber` |
| `req.headers["x-api-key"]` | the hyphenated key | — |
| `req.headers.x-api-key` | **nothing** — the hyphen is parsed as an operator | the key you meant |

Four rules that follow from that table:

- **`*` matches exactly one level.** It is not a recursive wildcard. Cover both `password` and `*.password`, and add a deeper path when your objects are deeper.
- **Bracket notation is required for any key that is not a plain identifier** — hyphens especially, which covers most HTTP headers.
- **Paths are case-sensitive.** Node lowercases *incoming* request headers, so `req.headers.authorization` is right. An outbound HTTP client's config object keeps whatever case your code wrote, so `err.config.headers.Authorization` needs the capital. List both spellings; a path that matches nothing costs nothing.
- **Paths apply to the object as it is logged, after serializers have run.** If a serializer reshapes `req`, your `req.headers.*` paths no longer point at anything.

### `censor` and `remove`

`censor` defaults to the string `'[Redacted]'`. A function gives you partial masking, which is what card data needs — the last four digits are usually permitted, the rest are not:

```js good title="src/logger.js"
export const redact = {
  paths: ['items[*].cardNumber', 'paymentMethods[*].number'],
  censor: (value) => {
    if (typeof value === 'string' && /^\d{13,19}$/.test(value)) {
      return `**** **** **** ${value.slice(-4)}`
    }
    return '[Redacted]'
  },
}
```

`remove: true` drops the key entirely instead of replacing its value:

```js good
export const redact = {
  paths: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-api-key"]'],
  remove: true,
}
```

Prefer `remove` for credentials you never want indexed under any circumstances. `"authorization":"[Redacted]"` still creates a field in your log platform's schema, still tells anyone with log access that the request was authenticated, and is one misconfigured pipeline away from being populated. `remove` applies to every path in that configuration, so it is an all-or-nothing choice per logger — split the concern by removing the worst fields in a serializer and censoring the rest.

:::danger
Redaction only catches what you named. The same password inside a free-text `message`, inside a stringified object, inside an unnamed nested field, or inside an error's `stack` is untouched. Deny-lists lose to the next field someone adds. Log an allow-list of named fields and treat `redact` as the net under it, not the plan.
:::

## Errors carry credentials

This is the leak that survives a careful redaction configuration, because nobody thinks of an `Error` as a container for secrets.

**The threat.** pino's standard error serializer emits `type`, `message`, `stack`, **and every enumerable own property** on the error. HTTP client wrappers routinely attach the request they made — headers included.

:::danger
```js vulnerable title="DO NOT COPY — src/lib/billing.js"
export async function callBilling(path, userToken) {
  const config = {
    url: `https://billing.internal${path}`,
    headers: {
      Authorization: `Bearer ${userToken}`,
      'x-api-key': process.env.BILLING_API_KEY,
    },
  }

  const res = await fetch(config.url, { headers: config.headers })
  if (!res.ok) {
    const err = new Error(`billing ${res.status}`)
    err.config = config          // the entire request, credentials and all
    throw err
  }
  return res.json()
}
```
:::

The handler does the correct thing and logs the error object:

```js
req.log.error({ err }, 'billing call failed')
```

**The exploit is an upstream 502.** No attacker required:

```json
{"level":"error","time":1788000000000,"service":"api",
 "err":{"type":"Error","message":"billing 502",
   "stack":"Error: billing 502\n    at callBilling (/app/src/lib/billing.js:14:17)",
   "config":{"url":"https://billing.internal/invoices",
     "headers":{"Authorization":"Bearer eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMDQyIn0.Qk7x9",
                "x-api-key":"sk_live_9f3ad2c1"}}},
 "msg":"billing call failed"}
```

A user's live bearer token and your service's API key, in an error line that fires on every upstream hiccup — which is to say, in bulk, during exactly the incident when the most people are reading the logs.

**Fix 1: do not put the request on the error.** Attach what you need to debug, and nothing else. This is the fix that keeps working when someone adds a new header.

```js good title="src/lib/billing.js"
export async function callBilling(path, userToken) {
  const url = `https://billing.internal${path}`

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${userToken}`,
      'x-api-key': process.env.BILLING_API_KEY,
    },
  })

  if (!res.ok) {
    const err = new Error(`billing ${res.status}`)
    err.upstream = {
      url,                                          // no query string, no credentials
      status: res.status,
      requestId: res.headers.get('x-request-id'),
    }
    throw err
  }
  return res.json()
}
```

**Fix 2: an error serializer that strips the known carriers**, for the errors thrown by code you did not write.

```js good title="src/logger.js"
import pino from 'pino'

// Properties that HTTP clients and drivers attach, which routinely carry
// credentials. Dropped before the error is ever serialized.
const DROPPED_ERROR_PROPS = ['config', 'request', 'response', 'options', 'headers', 'agent']

export function errSerializer(err) {
  const serialized = pino.stdSerializers.err(err)
  for (const prop of DROPPED_ERROR_PROPS) delete serialized[prop]
  return serialized
}
```

Wire the serializer and the redaction paths in together — they defend different failures, and neither is complete on its own. The full `serializers` object is assembled in the next section.

:::warning
An error's `message` and `stack` are strings, so no path-based redaction reaches inside them. A driver that formats a connection URI into its error message puts a database password into `msg`, and a validation library that echoes the invalid value puts the rejected password there. Check what your dependencies put in `message` before you decide the error path is clean.
:::

## URLs carry tokens

**The threat.** A secret in a query string is written to more places than any other kind of secret you handle: your application logs, your proxy's access logs, your CDN's logs, the browser's history, and the `Referer` header sent to every third party the page loads.

**The exploit.** Nobody has to attack anything. A password-reset link is opened; the page includes an analytics script; the analytics vendor receives:

```text
GET /collect?v=2 HTTP/1.1
Host: analytics.example.net
Referer: https://app.example.com/reset?token=8f2a1c94b7e0d3
```

Meanwhile your own edge wrote:

```text
203.0.113.44 - - [09/Sep/2026:11:22:41 +0000] "GET /reset?token=8f2a1c94b7e0d3 HTTP/2" 200 4210
```

The reset token is valid for the next fifteen minutes and now exists in at least four systems, two of which you do not own.

**Fix 1: do not put secrets in URLs.** A reset token belongs in a POST body, or — if the link must be clickable — in the URL fragment, which browsers never send to the server and never place in `Referer`. Set `Referrer-Policy` as a second line of defense; see [Security headers](security-headers.md).

**Fix 2: log the path, allow-list the query.** `pino-http`'s default `req` serializer logs `req.url` including its query string. Replace it, and while you are there, stop logging headers wholesale:

```js good title="src/logger.js"
const SAFE_QUERY = new Set(['page', 'limit', 'sort', 'cursor', 'fields'])

function safeUrl(raw) {
  const [pathname, query] = raw.split('?')
  if (!query) return pathname

  const kept = new URLSearchParams()
  for (const [key, value] of new URLSearchParams(query)) {
    kept.set(key, SAFE_QUERY.has(key) ? value : '[Redacted]')
  }
  return `${pathname}?${kept}`
}

export const serializers = {
  // An allow-list: only these three fields are ever logged from a request.
  req: (req) => ({ id: req.id, method: req.method, url: safeUrl(req.url ?? '') }),
  res: (res) => ({ statusCode: res.statusCode }),
  err: errSerializer,          // from the previous section
}
```

Replacing the default `req` serializer means headers are no longer logged at all — no `Authorization`, no `Cookie`, and no field you have not thought about. That is the allow-list working, and it makes the `req.headers.*` redaction paths above pure insurance.

**Verify it:**

```bash
$ curl -s 'https://api.example.com/reset?token=abc123&page=2' -o /dev/null
$ # in the log stream:
{"level":"info","req":{"id":11,"method":"GET","url":"/reset?token=%5BRedacted%5D&page=2"},"msg":"request completed"}
```

The route is still queryable, the pagination is still visible, and the token is gone. Do the same at your proxy — nginx and most load balancers can strip or mask query strings in their own access-log format, and their logs are the ones you will forget about.

## Structured fields, not interpolated strings

**You cannot redact a field you have already concatenated into a message.** By the time `msg` exists it is one opaque string, and every path in your `redact` configuration points at object keys that no longer exist.

:::danger
```js vulnerable title="DO NOT COPY"
req.log.warn(`login failed for ${email} from ${req.ip}, password was ${password}`)
```
:::

```json
{"level":"warn","time":1788000000000,"msg":"login failed for ann@example.com from 203.0.113.44, password was hunter2"}
```

No redaction configuration touches that line. There is no `password` key to match — there is a substring inside `msg`.

```js good
req.log.warn({ email, outcome: 'bad_password', attempt: attempts + 1 }, 'login failed')
```

```json
{"level":"warn","time":1788000000000,"email":"ann@example.com","outcome":"bad_password","attempt":3,"msg":"login failed"}
```

Now `email` is a field you can redact, hash, or drop with one configuration change, and `msg` is a stable string you can alert on. The structured form is also the one your log platform can aggregate — "count `outcome: bad_password` grouped by `email`" is a query; the interpolated version is a regular expression somebody maintains.

The same rule applies to templating a whole object into a message. `req.log.info(\`payload: ${JSON.stringify(req.body)}\`)` produces a string, and strings are not redactable.

## Correlation IDs instead of identities

The temptation is to attach the user's email — or name, or phone number — to a child logger so every line is traceable to a person. That decision makes your entire log store a personal-data system: every line, in every index, in every snapshot, for the full retention period.

Attach a request ID and a pseudonymous internal user ID instead. Both answer "show me everything that happened for this user's request"; neither is readable by someone who only has log access.

The `AsyncLocalStorage` mechanics are covered in [Logging](../express-libraries/logging.md). What matters here is *what you put in the store*:

```js good title="src/middleware/request-context.js"
import crypto from 'node:crypto'
import { requestContext } from '../context.js'

const SAFE_ID = /^[A-Za-z0-9_-]{8,64}$/

export function withRequestContext(req, res, next) {
  // An inbound ID lets a trace span services — but it is client input.
  // An unvalidated value can inject newlines and forge whole log entries.
  const inbound = req.get('x-request-id')
  const requestId = typeof inbound === 'string' && SAFE_ID.test(inbound) ? inbound : crypto.randomUUID()

  res.setHeader('x-request-id', requestId)
  requestContext.run({ requestId, userId: undefined }, next)
}
```

```js good title="src/middleware/authenticate.js"
import { requestContext } from '../context.js'

export function attachUserToContext(req, res, next) {
  const store = requestContext.getStore()
  // The opaque internal id. Never the email, name, or any account identifier
  // a person could recognize.
  if (store) store.userId = req.user.id
  next()
}
```

The payoff is that erasure becomes possible. Logs contain `userId: "5b0f…"` and nothing else about the person; the mapping from that ID to a human lives in one row of your database. Delete the row and the logs are de-linked without touching them.

:::note
Be honest about what that buys. Pseudonymized data is still personal data under GDPR — Recital 26 says so explicitly, because the mapping exists somewhere. Pseudonymization reduces exposure and makes erasure tractable; it does not take your logs out of scope. Only genuine anonymization does, and an ID you can still resolve is not anonymous.
:::

Echo the request ID back in a response header. A user can quote it in a support ticket, and you can find the exact request without searching by their email.

## Retention, access, and the erasure problem

**The threat is structural, not adversarial.** A user exercises their right to erasure under GDPR Article 17. You delete their row, their uploads, their sessions. Their email address is still in four million log lines, across a hot index, a warm index, three daily snapshots, a cold archive in object storage with a retention lock, and a vendor's copy.

You cannot delete one line from most of those. Immutable and write-once storage is a feature you paid for — often to satisfy a *different* compliance requirement — and it is now the reason you cannot answer the request.

There is no tool that fixes this after the fact. The program that works is preventive:

1. **Do not log identifiers that identify.** Pseudonymous IDs, as above. This is the only measure that scales, because it makes the other three cheaper.
2. **Set a real retention period, per stream.** Debug and access logs: days to weeks. Application logs: 30–90 days. Audit logs, which usually have their own legal basis and their own obligation to be retained, are a separate stream with a separate — longer — period. One global retention setting means either your audit trail is too short or your debug logs are personal data for seven years.
3. **Separate the streams by sensitivity, and control access separately.** Read access to production logs is read access to a large sample of your users' data. Treat a log-platform login as a production credential: named accounts, MFA, reviewed regularly, revoked on the same day as the database credential.
4. **Write down what fields exist in which stream.** An inventory is the only way to answer "where is this person's data" in an hour rather than a month, and it is what a regulator asks for first.

The pattern that makes 1 and 2 work together:

```sql
-- Erasure destroys the mapping. The logs, which carry only the opaque id,
-- are de-linked without anyone touching the log store.
UPDATE users
   SET email = NULL,
       display_name = NULL,
       phone = NULL,
       erased_at = now()
 WHERE id = $1;
```

If you have already logged personal data at volume and cannot delete it, the honest remediation is: stop the source, shorten retention so the existing copies age out, document the window, and tell whoever owns your privacy program. Shortening retention is often the only lever you have, and it works — slowly.

## Verifying

**Assert it in a test.** Sentinel values plus a capture stream turn redaction into something CI enforces, so the field added next quarter fails the build instead of leaking:

```js title="test/redaction.test.js"
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Writable } from 'node:stream'
import pino from 'pino'
import { redact, serializers } from '../src/logger.js'

function capture() {
  const lines = []
  const stream = new Writable({
    write(chunk, encoding, callback) {
      lines.push(chunk.toString())
      callback()
    },
  })
  return { lines, stream }
}

const SENTINELS = [
  'hunter2',                    // password
  'sk_live_9f3ad2c1',           // api key
  '8f2a1c94b7e0d3',             // session id / reset token
  '4111111111111111',           // card number
  '123-45-6789',                // national id
]

test('no sentinel value survives redaction', () => {
  const { lines, stream } = capture()
  const logger = pino({ redact, serializers }, stream)

  const err = new Error('billing 502')
  err.config = { headers: { Authorization: 'Bearer x', 'x-api-key': 'sk_live_9f3ad2c1' } }

  logger.error(
    {
      req: { headers: { authorization: 'Bearer x', cookie: 'sid=8f2a1c94b7e0d3' } },
      body: { email: 'ann@example.com', password: 'hunter2' },
      user: { id: 1042, ssn: '123-45-6789' },
      items: [{ sku: 'A1', cardNumber: '4111111111111111' }],
      err,
    },
    'checkout failed',
  )

  const output = lines.join('')
  for (const sentinel of SENTINELS) {
    assert.ok(!output.includes(sentinel), `${sentinel} reached the log stream`)
  }
})
```

Run with `node --test`. Add a sentinel every time you add a field that must never be logged.

**Prove it end to end in staging.** Send a request carrying a value nobody else could produce, then search your log platform for it:

```bash
$ CANARY="canary-$(node -e "console.log(require('node:crypto').randomUUID())")"
$ curl -s -X POST https://staging.example.com/auth/login \
    -H 'content-type: application/json' \
    -H "Authorization: Bearer $CANARY" \
    -d "{\"email\":\"probe@example.com\",\"password\":\"$CANARY\"}" -o /dev/null
$ echo "now search the log platform for: $CANARY"
```

Zero hits is the pass condition. Any hit tells you the exact field and the exact stream, which is a far shorter conversation than reading configuration.

**Check the layers you do not control.** Your proxy's access log, your platform's ingestion pipeline, and any log-forwarding sidecar each have their own idea of what to record. Run the same canary through the real edge, not against the app directly.

## Security considerations

- **A logged credential is a live credential.** Its lifetime is now your retention period, and its blast radius is everyone with log access.
- **Redaction is a deny-list.** It catches what you named. Allow-list what you log, and keep `redact` as the net.
- **A path that matches nothing fails silently.** Test the paths; do not assume a plausible-looking string is doing work.
- **Errors are objects with properties.** Anything attached to an error is logged, including the request that produced it.
- **`msg` is not redactable.** Once a value is interpolated into a string, no configuration can reach it.
- **Log access is data access.** Named accounts, MFA, review, and revocation on the same schedule as database credentials.
- **Validate an inbound `X-Request-Id` before echoing it.** An unvalidated value with newlines in it forges log entries, which is how an attacker edits your evidence.
- **Log the security events you will need**: authentication success and failure, authorization denials, rate-limit rejections, password and permission changes — with the request ID and the pseudonymous user ID, never with the credential involved.

## Production considerations

- **Set retention per stream, deliberately.** Access and debug logs in days; application logs in weeks; audit logs on their own basis and their own — longer — clock.
- **Keep an inventory of fields per stream.** It is the only way to answer a data-subject request without an archaeology project.
- **Sample volume, never redaction.** Dropping routine `info` lines to control cost is fine. Turning off redaction to save CPU is not — it costs microseconds per call.
- **Run the canary check on a schedule, not once.** A dependency upgrade that changes an error's shape reopens the leak silently.
- **Mask at the edge too.** Your proxy's access log format is a second place secrets land, and it is owned by a different team.
- **Route logs with different sensitivity to different destinations.** Audit events with a longer retention and tighter access; debug output somewhere cheap and short-lived.
- **Have a procedure for the day it leaks anyway.** Which stream, which window, how to rotate the credentials that appeared, and who to tell. Writing it after the incident is the expensive version.
- **Watch the size of your log bill for a reason to care.** Volume growth is usually somebody having started logging whole objects.

## Common mistakes

- **Default `pino-http` with no `redact`.** `Authorization` and `Cookie` headers straight into the log platform, on every request.
- **Logging `req.body` on `/auth/*` or `/checkout`.** Plaintext passwords, OTPs, and card numbers.
- **`req.log.info({ user })` with the whole database row.** The `password_hash` and `mfa_secret` columns come along.
- **`redact` paths with a hyphen in dot notation.** `req.headers.x-api-key` matches nothing and produces no warning.
- **Only `*.password`, never `password`.** The top-level field is missed. Or the reverse.
- **Assuming `*` is recursive.** It matches exactly one level.
- **Getting the case wrong on an outbound header path.** `err.config.headers.authorization` does not match `Authorization`.
- **Attaching the HTTP request config to a thrown error.** The bearer token is now in every error line.
- **Interpolating values into the message.** Unredactable by construction.
- **`JSON.stringify(req.body)` into a log message.** Same, with more of it.
- **Logging full URLs on routes with tokens in the query.** Application logs, proxy logs, CDN logs, and the `Referer` header.
- **Putting the user's email in `base` or in every child logger.** Every line is now personal data, forever.
- **One retention setting for every stream.** Either your audit trail is too short or your debug logs outlive the account.
- **Treating an immutable log archive as compliance progress.** It is also the reason you cannot honor an erasure request.
- **Believing a redaction config you have never tested.** Add sentinels and a test.

## Related topics

- [Logging](../express-libraries/logging.md) — pino and `pino-http` setup, levels, transports, and the `AsyncLocalStorage` plumbing.
- [Security headers](security-headers.md) — `Referrer-Policy`, and keeping tokens out of the `Referer` header.
- [JWT pitfalls](jwt-pitfalls.md) — why a token in a log or a URL is a live credential.
- [Secrets management](secrets-management.md) — the credentials that end up in error objects, and where they should live.
- [Authentication and session security](authentication-and-session-security.md) — the security events worth logging, and what not to record about them.
- [Error handling](../express/error-handling.md) — logging the detail while returning a safe response.
- [Observability](../production/observability.md) — metrics and traces, which have the same PII problem in their labels.
- [OWASP API Top 10 in Express](owasp-api-top-10.md) — where logging failures sit among the rest of the API risks.
