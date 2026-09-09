---
title: Authentication and session security
description: Credential stuffing, user enumeration, session fixation, express-session hardening, timeouts, MFA and password-reset token design in Express 5.
status: current
updated: 2026-09-08
---

Authentication is the one part of your API where a bug is worth money to somebody. This page covers the attacks that actually get run against login endpoints — credential stuffing, enumeration, fixation, reset-token abuse — and the Express 5 code that stops each of them. Password hashing itself lives on [Password hashing](../express-libraries/password-hashing.md); everything around it lives here.

## Credential stuffing

**The threat.** An attacker does not guess passwords. They buy 500 million real email/password pairs from previous breaches and replay them against your login route. Between 0.1% and 2% of pairs work, because people reuse passwords. Your password policy is irrelevant — these are correct passwords.

**The exploit.** Nothing clever, just volume:

```bash
# 200,000 leaked pairs, 50 at a time, against an unthrottled login route
xargs -P 50 -a creds.txt -I{} sh -c '
  echo {} | { IFS=: read -r u p; \
    curl -s -o /dev/null -w "%{http_code} $u\n" \
      -X POST https://api.example.com/login \
      -H "content-type: application/json" \
      -d "{\"email\":\"$u\",\"password\":\"$p\"}"; }'
```

Against a route with no throttle this returns a clean list of `200` lines: every account whose password was reused. Ten minutes of work.

**The fix.** Three independent controls, because each one alone is bypassable:

1. **Per-account throttle** — the attacker cannot rotate this away with proxies.
2. **Per-IP throttle** — catches the naive case cheaply.
3. **Exponential lockout with a reset on success** — turns a 200,000-attempt run into weeks.

```js good title="src/routes/auth.js"
import express from 'express'
import { rateLimit, ipKeyGenerator } from 'express-rate-limit'
import { verifyPassword } from '../lib/passwords.js'
import { attempts } from '../lib/attempts.js'

const router = express.Router()

// Per-IP: a blunt instrument, but free.
const perIp = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req) => ipKeyGenerator(req.ip, 56),
  skipSuccessfulRequests: true,
})

// Per-account: keyed by the email being attempted, not by who is attempting it.
const perAccount = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req) => `login:${String(req.body?.email ?? '').toLowerCase()}`,
  skipSuccessfulRequests: true,
})

router.post('/login', perIp, perAccount, async (req, res) => {
  const email = String(req.body?.email ?? '').toLowerCase()

  const lock = await attempts.check(email)
  if (lock.lockedUntil) {
    res.set('Retry-After', String(Math.ceil((lock.lockedUntil - Date.now()) / 1000)))
    return res.status(429).json({ error: 'too_many_attempts' })
  }

  const ok = await verifyPassword(email, req.body?.password)
  if (!ok) {
    await attempts.fail(email)                       // backoff: 1s, 2s, 4s, 8s, … capped at 15m
    return res.status(401).json({ error: 'invalid_credentials' })
  }

  await attempts.reset(email)
  await startSession(req, email)
  res.json({ ok: true })
})

export default router
```

:::warning
`keyGenerator` reads `req.body`, so the body parser must run before the limiter. In Express 5 `req.body` is `undefined` when nothing parsed it — hence `req.body?.email`, not `req.body.email`. Without the `?.` the limiter throws on a request with no body and the login route 500s.
:::

**Verify it.** The same run now stops after five attempts per account:

```bash
$ for i in $(seq 1 6); do
    curl -s -o /dev/null -w "%{http_code} " -X POST https://api.example.com/login \
      -H 'content-type: application/json' -d '{"email":"ann@example.com","password":"wrong"}'
  done
401 401 401 401 401 429
```

An honest limit does not stop a distributed attack on its own. Pair it with breached-password screening at registration and password change (reject passwords that appear in a public breach corpus), because a password that is not in the corpus cannot be stuffed.

## User enumeration

**The threat.** Before stuffing, an attacker wants to know which emails exist. A list of valid accounts makes every later attack cheaper and is itself sellable — "these 40,000 people have an account with this service" is a privacy breach even without a password.

**The exploit — different bodies.**

```bash
$ curl -s -X POST .../login -d '{"email":"ann@example.com","password":"x"}' -H 'content-type: application/json'
{"error":"invalid_password"}

$ curl -s -X POST .../login -d '{"email":"nobody@example.com","password":"x"}' -H 'content-type: application/json'
{"error":"user_not_found"}
```

The registration and password-reset routes leak the same way: `{"error":"email_already_registered"}` versus `{"ok":true}`.

**The exploit — different timings.** Even with identical bodies, this handler leaks:

:::danger
```js vulnerable title="DO NOT COPY"
app.post('/login', async (req, res) => {
  const user = await db.users.findByEmail(req.body.email)
  if (!user) return res.status(401).json({ error: 'invalid_credentials' })  // returns in ~2ms
  const ok = await argon2.verify(user.passwordHash, req.body.password)      // ~120ms
  if (!ok) return res.status(401).json({ error: 'invalid_credentials' })
  // …
})
```
:::

```bash
$ curl -s -o /dev/null -w '%{time_total}\n' -X POST .../login -d '{"email":"ann@example.com","password":"x"}' -H 'content-type: application/json'
0.128
$ curl -s -o /dev/null -w '%{time_total}\n' -X POST .../login -d '{"email":"nobody@example.com","password":"x"}' -H 'content-type: application/json'
0.004
```

A 30× difference is visible over the internet without statistics.

**The fix.** One response for both branches, and the same work in both branches. Verify against a pre-computed dummy hash when the user does not exist, so the KDF runs either way:

```js good title="src/lib/passwords.js"
import crypto from 'node:crypto'
import argon2 from 'argon2'
import { pool } from '../db.js'

// Computed once at boot with the same parameters as real hashes.
const DUMMY_HASH = await argon2.hash(crypto.randomUUID(), { type: argon2.argon2id })

export async function verifyPassword(email, password) {
  const { rows } = await pool.query(
    'SELECT id, password_hash FROM users WHERE lower(email) = lower($1)',
    [email],
  )
  const hash = rows[0]?.password_hash ?? DUMMY_HASH
  const ok = await argon2.verify(hash, String(password ?? ''))
  return ok && rows.length === 1 ? rows[0].id : null
}
```

Both branches now do one query and one Argon2 verification, and both return `401 {"error":"invalid_credentials"}`.

**Constant-time comparison for non-hashed secrets.** Anywhere you compare a token, an API key or an HMAC against a stored value, `===` short-circuits on the first differing byte and leaks the prefix. Hash both sides to a fixed length first, because `crypto.timingSafeEqual` throws when the buffers differ in length — and that throw is itself an oracle for the length:

```js good title="src/lib/compare.js"
import crypto from 'node:crypto'

export function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a ?? '')).digest()
  const hb = crypto.createHash('sha256').update(String(b ?? '')).digest()
  return crypto.timingSafeEqual(ha, hb)
}
```

:::note
Registration and password reset cannot be made non-enumerable by response shape alone if the product also says "that email is taken" in the signup form. Decide deliberately: either accept enumeration on signup and defend the login route, or move the "email taken" signal into the confirmation email ("someone tried to register with your address"). Pretending the tradeoff does not exist produces a page that leaks anyway.
:::

## Session fixation

**The threat.** The attacker fixes the session identifier *before* you log in, then reuses it after. They do not need to steal your cookie — they gave it to you.

**The exploit.** With a login handler that keeps the pre-login session:

:::danger
```js vulnerable title="DO NOT COPY"
app.post('/login', async (req, res) => {
  const userId = await verifyPassword(req.body.email, req.body.password)
  if (!userId) return res.status(401).json({ error: 'invalid_credentials' })
  req.session.userId = userId       // same session id as before login
  res.json({ ok: true })
})
```
:::

1. Attacker requests `GET /` and receives `Set-Cookie: sid=s%3AabC123…`.
2. Attacker gets the victim to use that value — a subdomain they control writing a cookie for the parent domain, a link with the id if the app ever accepts one from the URL, or an XSS on any page in scope.
3. Victim logs in normally. The server writes `userId` onto session `abC123`.
4. Attacker sends `Cookie: sid=s%3AabC123…` to `GET /me` and gets `200 {"id":1042,"email":"ann@example.com"}`.

**The fix.** Regenerate the session id on every privilege change — login, step-up MFA, role assumption, and password change:

```js good title="src/routes/auth.js"
const regenerate = (req) =>
  new Promise((resolve, reject) => req.session.regenerate((err) => (err ? reject(err) : resolve())))

const save = (req) =>
  new Promise((resolve, reject) => req.session.save((err) => (err ? reject(err) : resolve())))

router.post('/login', perIp, perAccount, async (req, res) => {
  const userId = await verifyPassword(req.body?.email, req.body?.password)
  if (!userId) return res.status(401).json({ error: 'invalid_credentials' })

  await regenerate(req)                 // old sid is destroyed in the store
  req.session.userId = userId
  req.session.createdAt = Date.now()    // for the absolute timeout
  await save(req)                       // write before responding

  res.json({ ok: true })
})
```

**Verify it.** The cookie value must change across the login:

```bash
$ curl -s -c jar -o /dev/null https://api.example.com/ && grep sid jar
api.example.com  FALSE  /  TRUE  0  sid  s%3AabC123...

$ curl -s -b jar -c jar -o /dev/null -X POST https://api.example.com/login \
    -H 'content-type: application/json' -d '{"email":"ann@example.com","password":"correct"}'
$ grep sid jar
api.example.com  FALSE  /  TRUE  0  sid  s%3AZz9Qmm...      # different — good

$ curl -s -H 'Cookie: sid=s%3AabC123...' https://api.example.com/me -w '\n%{http_code}\n'
{"error":"unauthenticated"}
401
```

The `await save(req)` matters: `express-session` writes at the end of the response, and a redirect or a client that immediately fires a second request can otherwise race the store write.

## Hardening `express-session`

`express-session` 1.19.0 ships defaults that are wrong for production. Every one of these must be set explicitly.

| Option | Default | Set it to | Why |
| --- | --- | --- | --- |
| `store` | `MemoryStore` | a real store | MemoryStore leaks memory, does not scale past one process, and drops every session on restart |
| `name` | `connect.sid` | your own | `connect.sid` announces the stack; it also collides with other apps on the same hostname |
| `resave` | `true` | `false` | re-writes unchanged sessions on every request — write amplification and a lost-update race |
| `saveUninitialized` | `true` | `false` | creates a store entry for every anonymous visitor and every bot |
| `cookie.httpOnly` | `true` | `true` (keep) | keeps the id out of `document.cookie`, so an XSS cannot read it |
| `cookie.secure` | `false` | `true` | without it the cookie is sent over plaintext HTTP |
| `cookie.sameSite` | not set | `'lax'` | blocks the cookie on cross-site `POST`, killing the simplest CSRF |
| `cookie.maxAge` | not set | an explicit ms value | otherwise it is a browser-session cookie with no server-side bound |
| `proxy` | `undefined` | inherits `trust proxy` | `secure: true` behind a proxy needs Express to know the request was HTTPS |

```js good title="src/session.js"
import session from 'express-session'
import { RedisStore } from 'connect-redis'
import { createClient } from 'redis'

const redis = createClient({ url: process.env.REDIS_URL })
await redis.connect()

export const sessions = session({
  store: new RedisStore({ client: redis, prefix: 'sess:', ttl: 60 * 60 * 12 }),
  name: '__Host-sid',
  secret: [process.env.SESSION_SECRET_CURRENT, process.env.SESSION_SECRET_PREVIOUS].filter(Boolean),
  resave: false,
  saveUninitialized: false,
  rolling: true,                       // idle timeout: each response resets maxAge
  cookie: {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 30 * 60 * 1000,            // 30-minute idle window
  },
})
```

```js title="src/app.js"
import express from 'express'
import { sessions } from './session.js'

const app = express()
app.set('trust proxy', 1)              // required for secure cookies behind a load balancer
app.use(sessions)
```

:::note
`__Host-` is a browser-enforced cookie name prefix: the browser refuses to store the cookie unless it is `Secure`, has `Path=/`, and has **no** `Domain` attribute. That last part is what kills the subdomain-writes-a-cookie step of the fixation attack above. It also means the cookie will not be stored over plain HTTP, so local development needs a different `name` — set it from the environment.
:::

`secret` accepts an array. The first element signs; every element verifies. That is how you rotate the signing key without logging everyone out: deploy `[new, old]`, wait longer than `maxAge`, then deploy `[new]`.

### Why not MemoryStore

The default store keeps sessions in the Node process's heap. Three consequences, all of which show up in production and none of which show up in development:

- **Every deploy logs out every user.** The heap goes away with the process.
- **Two instances disagree.** A user load-balanced to instance B is anonymous there.
- **It grows without bound.** Expired sessions are not reliably reaped, so memory climbs until the process is restarted — which is also why the leak is invisible on a service that redeploys daily.

Use [`connect-redis`](https://www.npmjs.com/package/connect-redis) 10.0.0 (shown above) or `connect-mongo` 6.0.0. Both peer-depend on `express-session`.

## Idle and absolute timeouts

They are different controls and you need both.

- **Idle timeout** — expire after N minutes of inactivity. Limits the window in which a stolen cookie is useful. `rolling: true` plus `cookie.maxAge` implements it, and `connect-redis` mirrors the expiry into the Redis key TTL.
- **Absolute timeout** — expire N hours after login regardless of activity. Without it, an attacker who steals a session can keep it alive forever by polling.

`express-session` has no absolute-timeout option, so enforce it yourself from the `createdAt` you set at login:

```js good title="src/middleware/session-age.js"
const ABSOLUTE_MS = 12 * 60 * 60 * 1000

export function enforceAbsoluteTimeout(req, res, next) {
  if (!req.session?.userId) return next()
  if (Date.now() - (req.session.createdAt ?? 0) > ABSOLUTE_MS) {
    return req.session.destroy(() => {
      res.clearCookie('__Host-sid', { path: '/' })
      res.status(401).json({ error: 'session_expired' })
    })
  }
  next()
}
```

## Logout that actually logs out

**The threat.** "Logout" that only clears the cookie leaves the session valid in the store. An attacker holding a copy of the cookie — from a shared machine, a proxy log, a backup — stays logged in.

:::danger
```js vulnerable title="DO NOT COPY"
app.post('/logout', (req, res) => {
  res.clearCookie('__Host-sid')      // the session row is still live in Redis
  res.json({ ok: true })
})
```
:::

**The exploit.** Replay the cookie you captured before logout:

```bash
$ curl -s -H 'Cookie: __Host-sid=s%3AZz9Qmm...' https://api.example.com/me
{"id":1042,"email":"ann@example.com"}     # still authenticated after "logout"
```

**The fix.** Destroy server-side first, clear the cookie second:

```js good
router.post('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) return res.status(500).json({ error: 'logout_failed' })
    res.clearCookie('__Host-sid', { path: '/', httpOnly: true, secure: true, sameSite: 'lax' })
    res.status(204).end()
  })
})
```

The same replay now returns `401`. Note that `res.clearCookie()` in Express 5 ignores `maxAge` and `expires` — pass the other attributes so they match the cookie you set, or the browser keeps it.

**Log out everywhere** needs a second mechanism, because you cannot enumerate one user's sessions from a session id. Store a `sessionVersion` integer on the user row, copy it into the session at login, and compare on every request; bump the column to invalidate every session for that user at once.

```js good title="src/middleware/require-auth.js"
export async function requireAuth(req, res, next) {
  if (!req.session?.userId) return res.status(401).json({ error: 'unauthenticated' })

  const { rows } = await pool.query(
    'SELECT id, email, role, session_version FROM users WHERE id = $1',
    [req.session.userId],
  )
  const user = rows[0]
  if (!user || user.session_version !== req.session.version) {
    return req.session.destroy(() => res.status(401).json({ error: 'session_revoked' }))
  }

  req.user = user
  next()
}
```

## MFA and recovery codes

Multi-factor authentication is the only control on this page that stops credential stuffing outright — a correct password is not enough.

Rules that matter more than the algorithm choice:

- **Regenerate the session after the second factor, not after the password.** Between the two steps the session is half-authenticated; give it a `mfaPending: true` flag and let no route except the MFA route accept it.
- **Rate-limit the TOTP check.** A six-digit code with a ±1-step window is one in ~300,000 per attempt. Unthrottled, that is a few hours of guessing. Five attempts per code period, then lock.
- **Store the TOTP secret encrypted at rest** with a key from your secrets manager, not in a plain column. A read-only SQL injection that dumps `users` should not also hand over the second factor.
- **Hash recovery codes like passwords.** They are passwords: a bearer secret that grants full access.
- **Make recovery codes single-use, and mark them used inside the same transaction that authenticates.** Otherwise two concurrent requests both succeed.
- **Show recovery codes once, at generation.** If you can display them again later, so can anyone with a session.

```js good title="src/lib/recovery-codes.js"
import crypto from 'node:crypto'
import argon2 from 'argon2'
import { pool } from '../db.js'

export async function issueRecoveryCodes(userId, count = 10) {
  const codes = Array.from({ length: count }, () =>
    crypto.randomBytes(10).toString('base64url'),      // ~80 bits
  )

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('DELETE FROM recovery_codes WHERE user_id = $1', [userId])
    for (const code of codes) {
      await client.query(
        'INSERT INTO recovery_codes (user_id, code_hash) VALUES ($1, $2)',
        [userId, await argon2.hash(code, { type: argon2.argon2id })],
      )
    }
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }

  return codes            // returned to the caller exactly once, never stored in plaintext
}
```

## Password reset tokens

A reset token is a password with a short life. Design it as one.

| Property | Why |
| --- | --- |
| ≥128 bits from `crypto.randomBytes` | `Math.random()` is not a CSPRNG; a 6-digit code is brute-forceable |
| Hashed at rest (SHA-256 is enough — high entropy, no KDF needed) | a database read must not yield usable reset links |
| Single use, consumed inside a transaction | otherwise the link in the mailbox works forever |
| TTL of 15–60 minutes | limits the window if the mailbox is later compromised |
| Bound to the user id, and re-checked on consumption | prevents swapping the id in the URL |
| Invalidates every existing session on success | a reset is usually a response to a compromise |
| Delivered in the path or a POST body, never in a query string | query strings land in access logs and `Referer` headers |

```js good title="src/routes/password-reset.js"
import crypto from 'node:crypto'
import express from 'express'
import argon2 from 'argon2'
import { pool } from '../db.js'

const router = express.Router()
const TTL_MS = 30 * 60 * 1000
const sha256 = (v) => crypto.createHash('sha256').update(v).digest('hex')

router.post('/password-reset/request', async (req, res) => {
  const email = String(req.body?.email ?? '').toLowerCase()
  const { rows } = await pool.query('SELECT id FROM users WHERE lower(email) = $1', [email])

  if (rows[0]) {
    const token = crypto.randomBytes(32).toString('base64url')
    await pool.query(
      `INSERT INTO password_resets (user_id, token_hash, expires_at)
       VALUES ($1, $2, now() + interval '30 minutes')`,
      [rows[0].id, sha256(token)],
    )
    // Path segment, not ?token= — query strings end up in logs and Referer headers.
    await sendResetEmail(email, `https://app.example.com/reset/${token}`)
  }

  // Identical response whether or not the account exists.
  res.status(202).json({ ok: true })
})

router.post('/password-reset/confirm', async (req, res) => {
  const token = String(req.body?.token ?? '')
  const password = String(req.body?.password ?? '')
  if (password.length < 12) return res.status(400).json({ error: 'password_too_short' })

  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    // DELETE … RETURNING makes consumption atomic: two concurrent requests, one winner.
    const { rows } = await client.query(
      `DELETE FROM password_resets
        WHERE token_hash = $1 AND expires_at > now()
        RETURNING user_id`,
      [sha256(token)],
    )
    if (rows.length === 0) {
      await client.query('ROLLBACK')
      return res.status(400).json({ error: 'invalid_or_expired_token' })
    }

    await client.query(
      `UPDATE users
          SET password_hash = $2, session_version = session_version + 1
        WHERE id = $1`,
      [rows[0].user_id, await argon2.hash(password, { type: argon2.argon2id })],
    )
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }

  res.status(204).end()
})

export default router
```

`session_version + 1` is what makes the reset meaningful: every session issued before the reset now fails the check in `requireAuth`, so an attacker who was already inside is evicted.

**Verify it.** Consume the token twice:

```bash
$ curl -s -o /dev/null -w '%{http_code}\n' -X POST .../password-reset/confirm \
    -H 'content-type: application/json' -d '{"token":"'"$T"'","password":"correct horse battery"}'
204
$ curl -s -X POST .../password-reset/confirm \
    -H 'content-type: application/json' -d '{"token":"'"$T"'","password":"another one"}'
{"error":"invalid_or_expired_token"}
```

And the old session is gone:

```bash
$ curl -s -H "Cookie: __Host-sid=$OLD" https://api.example.com/me
{"error":"session_revoked"}
```

## Testing it

```js title="test/auth.test.js"
import { test } from 'node:test'
import assert from 'node:assert/strict'
import request from 'supertest'
import app from '../src/app.js'

test('login regenerates the session id', async () => {
  const agent = request.agent(app)

  const anon = await agent.get('/')
  const before = anon.headers['set-cookie']?.[0]

  const login = await agent
    .post('/login')
    .send({ email: 'ann@example.com', password: 'correct horse battery' })
    .expect(200)

  const after = login.headers['set-cookie'][0]
  assert.notEqual(before, after, 'session id must change on login')
})

test('login responses are identical for unknown and wrong-password accounts', async () => {
  const unknown = await request(app).post('/login').send({ email: 'nobody@example.com', password: 'x' })
  const wrong = await request(app).post('/login').send({ email: 'ann@example.com', password: 'x' })

  assert.equal(unknown.status, wrong.status)
  assert.deepEqual(unknown.body, wrong.body)
})

test('the sixth attempt on one account is throttled', async () => {
  const attempt = () =>
    request(app).post('/login').send({ email: 'target@example.com', password: 'x' })

  for (let i = 0; i < 5; i++) assert.equal((await attempt()).status, 401)
  const blocked = await attempt()
  assert.equal(blocked.status, 429)
  assert.ok(blocked.headers['retry-after'])
})
```

Run with `node --test`.

## Security considerations

- **A rate limiter keyed on `req.ip` is only as trustworthy as `trust proxy`.** Get that wrong and an attacker sets `X-Forwarded-For` per request and never hits a limit. See [Rate limiting and abuse](rate-limiting-and-abuse.md#the-trust-proxy-trap).
- **In-memory limiter and lockout counters are per-process.** Behind two instances, five attempts becomes ten. Back both with Redis.
- **Session cookies and CSRF are one problem.** `sameSite: 'lax'` blocks cross-site `POST` from a form, but not a same-site sub-path, and not a `GET` that mutates. See [CSRF](csrf.md).
- **`httpOnly` is not an XSS fix.** It stops the attacker from *reading* the cookie; it does nothing about them issuing requests from the victim's browser with it. See [XSS](xss.md).
- **Everything here assumes the password hash is sound.** Argon2id or bcrypt with a real work factor — see [Password hashing](../express-libraries/password-hashing.md).

## Production considerations

- **Log authentication events, not credentials.** Log `event`, `userId` or a hash of the attempted email, source IP, and outcome. Never log the password field, and never log the whole request body on auth routes — see [Logging without leaking PII](logging-without-leaking-pii.md).
- **Alert on the shape of stuffing, not on single failures.** Many accounts, few attempts each, one source ASN, high 401 ratio. A per-account counter never fires on this pattern.
- **Size the session store.** At 30 minutes idle and 12 hours absolute, peak session count is roughly peak concurrent users plus the tail. Set `maxmemory-policy` on Redis to `volatile-ttl` so it evicts expiring keys rather than random ones.
- **Rotate `SESSION_SECRET` on a schedule** using the array form, and keep the previous value for at least one absolute-timeout period.
- **Make the store failure mode explicit.** If Redis is down, `express-session` surfaces the error to your error handler and the user is anonymous. Decide whether that is a 503 or a degraded read-only mode — do not discover it during an incident.

## Common mistakes

- **Setting `req.session.userId` without `regenerate()`.** That is session fixation, and it is one line to fix.
- **Leaving `saveUninitialized: true`.** Every crawler gets a store entry. On a public site that is the majority of your session table.
- **`secure: true` without `app.set('trust proxy', 1)`.** Express thinks the request is HTTP, refuses to send the cookie, and login silently never sticks.
- **Clearing the cookie and calling it logout.** The session is still valid in the store. Destroy first.
- **`res.clearCookie('sid')` with different attributes than the `Set-Cookie` used.** The browser treats it as a different cookie and keeps the original. Match `path`, and `domain` if you set one.
- **Different error messages for "no such user" and "wrong password".** Free account enumeration.
- **Returning early before the KDF runs.** Identical text, different timing, same leak.
- **Reset tokens stored in plaintext, or reusable, or delivered as `?token=`.** All three turn one leaked log line or one backup into account takeover.
- **`===` on tokens and API keys.** Use a hash-then-`timingSafeEqual` helper.
- **A six-digit numeric reset code.** A million possibilities is a few minutes of requests unless the code is also rate-limited and single-attempt.
- **Trusting `MemoryStore` because staging works.** Staging has one instance and infrequent deploys. Production has neither.

## Related topics

- [Authentication](../express-libraries/authentication.md) — Passport, sessions and token strategies, and how to wire them.
- [Password hashing](../express-libraries/password-hashing.md) — Argon2id and bcrypt parameters.
- [JWT pitfalls](jwt-pitfalls.md) — what changes when the session lives in a token instead of a store.
- [Rate limiting and abuse](rate-limiting-and-abuse.md) — the limiter internals and the `trust proxy` trap.
- [CSRF](csrf.md) — the attack cookie-based sessions are exposed to by construction.
- [XSS](xss.md) — how session cookies actually get stolen.
- [Cookies](../express-libraries/cookies.md) — attribute semantics, signing, and the `__Host-` prefix.
- [Secrets management](secrets-management.md) — where `SESSION_SECRET` should come from.
- [Logging without leaking PII](logging-without-leaking-pii.md) — logging auth events safely.
- [IDOR and broken object-level authorization](broken-object-level-authorization.md) — what to check after the user is authenticated.
