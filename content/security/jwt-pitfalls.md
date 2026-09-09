---
title: JWT pitfalls
description: Algorithm confusion, alg none, unverified decode, missing claim checks, weak secrets, revocation, storage and JWKS handling — with working forgeries and the Express 5 fixes.
status: current
updated: 2026-09-08
---

A JWT is a bearer token whose only protection is the signature check you perform on it. Every failure on this page is a failure of that check — skipped, misconfigured, or performed against a key the attacker controls. The payload is base64url, not encryption: anyone holding the token can read every claim in it.

Two libraries appear here: `jsonwebtoken` 9.0.3 (ubiquitous, callback heritage) and `jose` 6.2.12 (modern, Web Crypto, native JWKS). Where their behavior differs, both are shown.

## The two forgeries: `alg: none` and algorithm confusion

Both attacks work by making the verifier use an algorithm the attacker chose rather than the one you intended. Both are trivially exploitable against hand-written verification code, which is exactly what "I'll just check the signature myself, it's only three lines" produces.

Here is that code. It is realistic — it handles three algorithms and it checks signatures — and it is completely broken:

:::danger
```js vulnerable title="DO NOT COPY — src/lib/verify.js"
import crypto from 'node:crypto'

export function verify(token, publicKeyPem) {
  const [h, p, s] = token.split('.')
  const header = JSON.parse(Buffer.from(h, 'base64url').toString())
  const signing = `${h}.${p}`

  if (header.alg === 'none') {
    return JSON.parse(Buffer.from(p, 'base64url').toString())          // (1)
  }
  if (header.alg === 'HS256') {
    const mac = crypto.createHmac('sha256', publicKeyPem).update(signing).digest('base64url')
    if (mac !== s) throw new Error('bad signature')                    // (2)
    return JSON.parse(Buffer.from(p, 'base64url').toString())
  }
  if (header.alg === 'RS256') {
    const ok = crypto.createVerify('RSA-SHA256').update(signing).verify(publicKeyPem, Buffer.from(s, 'base64url'))
    if (!ok) throw new Error('bad signature')
    return JSON.parse(Buffer.from(p, 'base64url').toString())
  }
  throw new Error('unsupported alg')
}
```
:::

**(1) `alg: none`.** The JWS specification has an "unsecured" mode. If the verifier honors it, no key is needed at all.

```bash
$ HDR=$(printf '{"alg":"none","typ":"JWT"}' | basenc --base64url -w0 | tr -d '=')
$ PAY=$(printf '{"sub":"9","role":"admin"}' | basenc --base64url -w0 | tr -d '=')
$ curl -s -H "Authorization: Bearer $HDR.$PAY." https://api.example.com/admin/users
[{"id":1,"email":"ann@example.com"}]
```

**(2) Algorithm confusion.** Your service signs with RS256 and verifies with the RSA **public** key — which is public. The attacker re-signs their own payload with `HS256`, using the PEM text of that public key as the HMAC secret. The verifier reaches branch (2), computes an HMAC with the same public key, and the signatures match.

```js title="forge.js — the attacker's side, needs only the public key"
import crypto from 'node:crypto'

const PUB = await fetch('https://api.example.com/.well-known/public.pem').then((r) => r.text())
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')

const signing = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: '9', role: 'admin' })}`
const sig = crypto.createHmac('sha256', PUB).update(signing).digest('base64url')

console.log(`${signing}.${sig}`)
```

```bash
$ curl -s -H "Authorization: Bearer $(node forge.js)" https://api.example.com/admin/users
[{"id":1,"email":"ann@example.com"}]
```

### The fix: name the algorithms, always

Delete the hand-rolled verifier and pin the algorithm list. `algorithms` is not optional decoration — it is the control that makes the header untrusted.

```js good title="src/lib/verify.js"
import jwt from 'jsonwebtoken'

const PUBLIC_KEY = process.env.JWT_PUBLIC_KEY

export function verify(token) {
  return jwt.verify(token, PUBLIC_KEY, {
    algorithms: ['RS256'],                      // the header cannot change this
    issuer: 'https://auth.example.com',
    audience: 'https://api.example.com',
    clockTolerance: 5,
  })
}
```

**Verify the fix.** Both forgeries are now rejected, with these exact errors from `jsonwebtoken` 9.0.3:

```text
alg:none token           → JsonWebTokenError: jwt signature is required
HS256-with-public-key    → JsonWebTokenError: invalid algorithm
```

```bash
$ curl -s -H "Authorization: Bearer $HDR.$PAY." https://api.example.com/admin/users
{"error":"invalid_token"}
```

:::note
`jsonwebtoken` 9 already defends both cases by itself: it refuses `alg: none` unless you explicitly list `'none'` in `algorithms`, and it rejects an HS256 token verified against a PEM key with `secretOrPublicKey must be a symmetric key when using HS256`. That is a safety net, not the control. It disappears the moment someone writes `algorithms: [decoded.header.alg]`, hands the key over as raw bytes rather than a PEM, or reimplements verification — which is how these bugs actually ship. Pin the list.

`jose` 6.2.12 has no `none` support at all: an `alg: none` token fails with `ERR_JOSE_NOT_SUPPORTED: alg none is not supported either by JOSE or your javascript runtime`. Passing the wrong algorithm gives `ERR_JOSE_ALG_NOT_ALLOWED`.
:::

## `jwt.decode()` is not verification

**The threat.** This is the version of the above that ships most often, because it looks like it works and there is no signature error to notice.

:::danger
```js vulnerable title="DO NOT COPY"
import jwt from 'jsonwebtoken'

app.use((req, res, next) => {
  const token = req.get('authorization')?.slice(7)
  const claims = jwt.decode(token)          // parses. does not verify. ever.
  if (claims) req.user = { id: claims.sub, role: claims.role }
  next()
})

app.get('/me', (req, res) => res.json({ sub: req.user.id, role: req.user.role }))
```
:::

**The exploit.** No key needed, no valid token needed. The signature segment can be the literal string `AAAA`:

```bash
$ HDR=$(printf '{"alg":"HS256","typ":"JWT"}' | basenc --base64url -w0 | tr -d '=')
$ PAY=$(printf '{"sub":"1","role":"admin"}' | basenc --base64url -w0 | tr -d '=')
$ curl -s -H "Authorization: Bearer $HDR.$PAY.AAAA" https://api.example.com/me
{"sub":"1","role":"admin"}
```

Confirmed against Express 5.2.1 with `jsonwebtoken` 9.0.3: `200` with the forged role.

**The fix.**

```js good title="src/middleware/authenticate.js"
import jwt from 'jsonwebtoken'

export function authenticate(req, res, next) {
  const header = req.get('authorization') ?? ''
  if (!header.startsWith('Bearer ')) return res.status(401).json({ error: 'missing_token' })

  const claims = jwt.verify(header.slice(7), process.env.JWT_PUBLIC_KEY, {
    algorithms: ['RS256'],
    issuer: 'https://auth.example.com',
    audience: 'https://api.example.com',
    clockTolerance: 5,
  })

  req.user = { id: claims.sub, tokenVersion: claims.tv }
  next()
}
```

Any `jwt.verify` failure throws. In Express 5 a throw from a synchronous handler and a rejection from an async one both reach your error middleware without a wrapper, so map the JWT error types there:

```js good title="src/middleware/errors.js"
import jwt from 'jsonwebtoken'

export function errorHandler(err, req, res, next) {
  if (err instanceof jwt.TokenExpiredError) {
    return res.status(401).json({ error: 'token_expired', expiredAt: err.expiredAt })
  }
  if (err instanceof jwt.JsonWebTokenError || err instanceof jwt.NotBeforeError) {
    return res.status(401).json({ error: 'invalid_token' })   // never echo err.message
  }
  req.log.error({ err }, 'unhandled error')
  res.status(err.status ?? 500).json({ error: 'internal_error' })
}
```

Do not return `err.message` to the client. `jwt audience invalid. expected: https://api.example.com` tells an attacker exactly which claim to fix next.

**The one legitimate use of `decode`.** Reading the `kid` from the header to pick a key *before* verification, or logging an expired token's subject after `verify` already rejected it. Nothing that reaches an `if`.

```js good
import jwt from 'jsonwebtoken'
// decode is only ever used to select the key that verify will then enforce
const { header } = jwt.decode(token, { complete: true }) ?? { header: {} }
```

## Missing `exp`, `iss` and `aud` checks

**The threat.** A signature proves the token is authentic. It does not prove it is *current*, that it came from your issuer, or that it was meant for your service.

- **No `exp`** — the token is valid forever. A token pulled from a log in 2024 still works.
- **No `iss` check** — any issuer whose key you happen to trust can mint tokens for you.
- **No `aud` check** — a token your identity provider issued for the *analytics* service is accepted by the *payments* service. This is the cross-service confused deputy, and it is the common failure in multi-service estates behind one identity provider.

**The exploit.** With a token issued for a different audience, against a verifier that only checks the signature:

```bash
$ curl -s -H "Authorization: Bearer $ANALYTICS_TOKEN" https://payments.example.com/transfers
{"transfers":[...]}     # the analytics service's token spends money
```

`jsonwebtoken` checks `exp` automatically when the claim is present, but **only checks `iss` and `aud` when you pass them**, and a token with no `exp` at all is accepted indefinitely:

```js
jwt.verify(tokenWithNoExp, secret)          // → accepted, forever
```

**The fix.** Enforce all three at verification, and add `maxAge` as a backstop against tokens minted without `exp`:

```js good
const claims = jwt.verify(token, PUBLIC_KEY, {
  algorithms: ['RS256'],
  issuer: 'https://auth.example.com',
  audience: 'https://api.example.com',
  maxAge: '15m',            // rejects on iat even when exp is absent
  clockTolerance: 5,
})
```

`maxAge: '15m'` against a token whose `iat` is an hour old gives `TokenExpiredError: maxAge exceeded`.

With `jose`, `issuer` and `audience` are enforced as *required* claims — a token missing `iss` fails with `ERR_JWT_CLAIM_VALIDATION_FAILED: missing required "iss" claim`, which is the behavior you want:

```js good
import * as jose from 'jose'

const { payload } = await jose.jwtVerify(token, key, {
  algorithms: ['RS256'],
  issuer: 'https://auth.example.com',
  audience: 'https://api.example.com',
  clockTolerance: '5s',
  maxTokenAge: '15m',
})
```

## Weak HS256 secrets

**The threat.** HS256 is symmetric: the signing secret is also the verification secret. An attacker who recovers it can mint any token they like, forever, and there is no signal in your logs — the tokens are valid.

**The exploit is offline.** One captured token is enough; no requests to your service are needed, so no rate limit applies.

```bash
# hashcat mode 16500 is JWT. One consumer GPU, one wordlist.
$ hashcat -m 16500 token.jwt rockyou.txt
eyJhbGciOiJIUzI1NiJ9...:supersecret
```

Anything a human chose — `secret`, `jwt-secret`, the project name, a passphrase — falls in minutes. Anything under about 32 random bytes is worth attacking.

**The fix.** Either use a real random secret, or stop using a symmetric algorithm.

```bash
# 32 bytes from a CSPRNG, base64url, stored in your secrets manager
$ node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

```js good title="src/config.js"
const secret = process.env.JWT_SECRET
if (!secret || Buffer.from(secret, 'base64url').length < 32) {
  throw new Error('JWT_SECRET must be at least 32 bytes of base64url-encoded entropy')
}
export const JWT_SECRET = secret
```

Prefer RS256 or EdDSA (`Ed25519`) whenever more than one service verifies the token: with an asymmetric key, a compromised verifier cannot mint tokens, because it never holds the private key. That single property is worth the extra key management.

:::warning
A weak secret is not fixable by rotating alone — every token signed with the old secret must also be invalidated. Rotate the secret *and* bump the token version claim described below.
:::

## You cannot revoke a JWT

**The threat.** This is the property people buy JWTs for and then discover they did not want. A verified token is accepted because the math checks out; nothing consults your database. So:

- A fired employee's token works until `exp`.
- A user who clicks "log out everywhere" is still logged in everywhere.
- A leaked token cannot be cancelled.
- A permission you revoked is still in the token.

"Stateless auth" means "no revocation". There are exactly three real answers, and they all reintroduce state somewhere.

| Approach | State it costs | Revocation latency | Use when |
| --- | --- | --- | --- |
| Short access TTL + refresh rotation | refresh tokens in the DB | one access-token TTL (5–15 min) | the default for user-facing APIs |
| `jti` denylist in Redis | one key per revoked token, TTL = remaining life | immediate | you need instant kill for specific tokens |
| Token version claim checked per request | one integer column, one read per request | immediate | you already read the user row anyway |

### 1. Short TTL plus refresh rotation with reuse detection

The access token lives 15 minutes and is never stored server-side. The refresh token is long-lived, stored hashed, single-use, and **rotated** on every use. Rotation is what makes theft detectable: if a refresh token is ever presented twice, one of the two presenters is an attacker and you cannot tell which — so you revoke the whole family.

```js good title="src/routes/refresh.js"
import crypto from 'node:crypto'
import express from 'express'
import jwt from 'jsonwebtoken'
import { pool } from '../db.js'

const router = express.Router()
const sha256 = (v) => crypto.createHash('sha256').update(v).digest('hex')

router.post('/refresh', async (req, res) => {
  const presented = String(req.body?.refreshToken ?? '')

  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    const { rows } = await client.query(
      `SELECT id, user_id, family_id, used_at
         FROM refresh_tokens
        WHERE token_hash = $1 AND expires_at > now()
        FOR UPDATE`,
      [sha256(presented)],
    )
    const row = rows[0]

    if (!row) {
      await client.query('ROLLBACK')
      return res.status(401).json({ error: 'invalid_refresh_token' })
    }

    // Reuse detection: this token was already spent. Burn the whole family.
    if (row.used_at) {
      await client.query('DELETE FROM refresh_tokens WHERE family_id = $1', [row.family_id])
      await client.query('UPDATE users SET token_version = token_version + 1 WHERE id = $1', [row.user_id])
      await client.query('COMMIT')
      return res.status(401).json({ error: 'refresh_token_reused' })
    }

    await client.query('UPDATE refresh_tokens SET used_at = now() WHERE id = $1', [row.id])

    const next = crypto.randomBytes(32).toString('base64url')
    await client.query(
      `INSERT INTO refresh_tokens (user_id, family_id, token_hash, expires_at)
       VALUES ($1, $2, $3, now() + interval '30 days')`,
      [row.user_id, row.family_id, sha256(next)],
    )

    const { rows: users } = await client.query(
      'SELECT id, token_version FROM users WHERE id = $1',
      [row.user_id],
    )
    await client.query('COMMIT')

    const accessToken = jwt.sign(
      { sub: String(users[0].id), tv: users[0].token_version },
      process.env.JWT_PRIVATE_KEY,
      {
        algorithm: 'RS256',
        expiresIn: '15m',
        issuer: 'https://auth.example.com',
        audience: 'https://api.example.com',
        jwtid: crypto.randomUUID(),
      },
    )

    res.json({ accessToken, refreshToken: next })
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
})

export default router
```

**Verify it.** Present the same refresh token twice:

```bash
$ curl -s -X POST .../refresh -H 'content-type: application/json' -d "{\"refreshToken\":\"$R\"}" | jq -r .refreshToken
kQ3v8Fh...
$ curl -s -X POST .../refresh -H 'content-type: application/json' -d "{\"refreshToken\":\"$R\"}"
{"error":"refresh_token_reused"}
$ curl -s -H "Authorization: Bearer $STOLEN_ACCESS" https://api.example.com/me
{"error":"token_revoked"}
```

### 2. A `jti` denylist

Sign every token with a unique `jti`, and keep revoked ones in Redis until they would have expired anyway. The memory cost is bounded by the revocation rate times the TTL, not by the number of users.

```js good title="src/middleware/denylist.js"
export function denylist(redis) {
  return async (req, res, next) => {
    if (await redis.exists(`revoked:${req.auth.jti}`)) {
      return res.status(401).json({ error: 'token_revoked' })
    }
    next()
  }
}

export async function revoke(redis, claims) {
  const ttl = claims.exp - Math.floor(Date.now() / 1000)
  if (ttl > 0) await redis.set(`revoked:${claims.jti}`, '1', { EX: ttl })
}
```

### 3. A token version claim

Cheapest when your `requireAuth` already loads the user. Put the user's `token_version` in the token as `tv`; compare it on every request; increment the column to invalidate every token that user holds.

```js good title="src/middleware/authorize.js"
export async function loadUser(req, res, next) {
  const { rows } = await pool.query(
    'SELECT id, email, role, token_version FROM users WHERE id = $1',
    [req.auth.sub],
  )
  const user = rows[0]
  if (!user) return res.status(401).json({ error: 'invalid_token' })
  if (user.token_version !== req.auth.tv) {
    return res.status(401).json({ error: 'token_revoked' })
  }
  req.user = user
  next()
}
```

:::note
Options 2 and 3 both make a database or cache call on every authenticated request — the exact thing "stateless JWT" was supposed to avoid. That is the real trade. If you were always going to load the user row for authorization anyway, option 3 is free and you should stop pretending the token is stateless. If you genuinely need zero lookups on the hot path, accept option 1's revocation latency and keep the access TTL short.
:::

## Where to put the token in a browser

There is no option without a downside. Pick knowingly.

| Storage | Readable by XSS | Sent automatically | CSRF exposure | Notes |
| --- | --- | --- | --- | --- |
| `localStorage` | **yes** | no | none | one XSS exfiltrates the token to an attacker's server; it stays valid until `exp` |
| `sessionStorage` | **yes** | no | none | same, scoped to the tab |
| JS variable in memory | only while the page runs | no | none | lost on refresh; needs a refresh flow anyway |
| `httpOnly` cookie | no | **yes** | **yes** — needs `SameSite` and/or a CSRF token | the default recommendation |

`localStorage` is not "less secure than cookies" in every respect — it is immune to CSRF because nothing sends it for you. But the failure modes are not symmetric:

- **XSS + `localStorage`** — the attacker copies the token and uses it from their own machine, at their leisure, until it expires. Silent, persistent, off-site.
- **XSS + `httpOnly` cookie** — the attacker cannot read the token; they must issue requests from inside the victim's page while it is open. Still bad, but bounded and noisier.

So: `httpOnly` cookie, and then deal with CSRF deliberately.

```js good title="src/routes/login.js"
res.cookie('__Host-token', accessToken, {
  httpOnly: true,
  secure: true,
  sameSite: 'lax',       // 'strict' if no cross-site navigation must stay logged in
  path: '/',
  maxAge: 15 * 60 * 1000,
})
```

`sameSite: 'lax'` stops cross-site form posts. It does **not** stop a same-site attacker (another app on the same registrable domain), and it does not help if any state-changing route answers `GET`. Add a real CSRF token for cookie-authenticated state changes — see [CSRF](csrf.md).

:::warning
The one thing that is never acceptable is a token in a URL: `GET /reports?token=eyJ…`. Query strings are written to access logs, proxy logs, browser history, and are leaked to third parties in the `Referer` header of any outbound link on the page. See [Logging without leaking PII](logging-without-leaking-pii.md).
:::

## What belongs in a claim

**The payload is public.** `base64url` is an encoding. Anyone with the token — the browser, an extension, a proxy, a log aggregator, whoever ends up with a copy — reads every claim:

```bash
$ echo "$TOKEN" | cut -d. -f2 | basenc -d --base64url 2>/dev/null
{"sub":"1042","email":"ann@example.com","ssn":"123-45-6789","plan":"enterprise"}
```

So: no national IDs, no dates of birth, no phone numbers, no medical or financial detail. `sub` plus what you need for routing and coarse authorization. If it would be a breach in a log file, it is a breach in a JWT.

**Authorization decisions from unvalidated claims.** A claim is only as trustworthy as the check you performed. Two distinct mistakes:

:::danger
```js vulnerable title="DO NOT COPY"
// 1. The claim was never verified — see jwt.decode above.
// 2. The claim WAS verified, but by an issuer that does not own this decision:
const claims = jwt.verify(token, GOOGLE_PUBLIC_KEY, { algorithms: ['RS256'] })
if (claims.role === 'admin') { /* … */ }     // Google never asserted a role in YOUR app
```
:::

A correctly verified identity token proves *who the user is*. It does not carry your application's roles unless your own issuer put them there. Look authorization up in your own store, or mint your own token after federated login and put the roles in that.

Where roles do live in the token, treat a permission change as a revocation event: bump `tv`, or accept that the change takes effect one TTL later — and say which, in writing, before the auditor asks.

## `kid` header injection and JWKS

`kid` ("key id") is a **header** field, which means it is attacker-controlled on every unverified token. Its only legitimate use is *selecting* a key that verification will then enforce. Using it to *construct* a key location is a directory-traversal or injection primitive.

:::danger
```js vulnerable title="DO NOT COPY"
import fs from 'node:fs'
import jwt from 'jsonwebtoken'

const { header } = jwt.decode(token, { complete: true })
const key = fs.readFileSync(`/etc/keys/${header.kid}.pem`)          // path traversal
return jwt.verify(token, key)
```
:::

**The exploit.** Point `kid` at a file whose contents the attacker knows, then sign with those contents. `/dev/null` is empty — sign with an empty HMAC key. `/proc/sys/kernel/ostype` is `Linux\n` on every Linux box:

```json
{"alg":"HS256","kid":"../../../proc/sys/kernel/ostype"}
```

The same shape appears with a database lookup, where `kid` becomes SQL:

:::danger
```js vulnerable title="DO NOT COPY"
const { rows } = await pool.query(`SELECT pem FROM jwks WHERE kid = '${header.kid}'`)
```
:::

`kid` of `x' UNION SELECT 'attacker-chosen-key` returns a key the attacker picked.

**The fix.** Never build a path or a query from `kid`. Either look it up in a fixed map, or let `jose` fetch and cache the issuer's JWKS and do the matching for you:

```js good title="src/lib/jwks.js"
import * as jose from 'jose'

// Fetches and caches the issuer's key set. Refetches on an unknown kid,
// rate-limited by cooldownDuration so an attacker cannot force a fetch per request.
const JWKS = jose.createRemoteJWKSet(new URL('https://auth.example.com/.well-known/jwks.json'), {
  cacheMaxAge: 10 * 60 * 1000,
  cooldownDuration: 30 * 1000,
  timeoutDuration: 5 * 1000,
})

export async function verify(token) {
  const { payload, protectedHeader } = await jose.jwtVerify(token, JWKS, {
    algorithms: ['RS256'],
    issuer: 'https://auth.example.com',
    audience: 'https://api.example.com',
    clockTolerance: '5s',
    maxTokenAge: '15m',
  })
  return { payload, kid: protectedHeader.kid }
}
```

An unknown `kid` now yields a JOSE error rather than a filesystem read. Keep `algorithms` pinned even with JWKS: the key set may advertise several algorithms, and you want exactly one.

:::warning
`createRemoteJWKSet` makes an outbound HTTP request from your API process. Point it only at an issuer URL that comes from your configuration — never from the token's `iss` claim. Taking the JWKS URL from the token is SSRF plus complete authentication bypass in one line: the attacker hosts a JWKS containing their own public key.
:::

## Clock skew

**The threat.** Two servers whose clocks differ by seconds will disagree about whether a token is valid. Symptoms are intermittent `401`s on freshly issued tokens (`nbf`/`iat` in the future for the verifier) or on tokens right at the boundary.

Allow a small tolerance — seconds, not minutes. Tolerance is a direct extension of the life of a revoked or expired token, so keep it tight:

```js good
jwt.verify(token, key, { algorithms: ['RS256'], clockTolerance: 5 })          // seconds
await jose.jwtVerify(token, key, { algorithms: ['RS256'], clockTolerance: '5s' })
```

The real fix is NTP on every host. A tolerance of `300` is not clock skew handling, it is a five-minute revocation delay you have chosen not to think about.

## Testing it

```js title="test/jwt.test.js"
import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import request from 'supertest'
import app from '../src/app.js'

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')

test('a token with no signature is rejected', async () => {
  const forged = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub: '9', role: 'admin' })}.`
  const res = await request(app).get('/admin/users').set('Authorization', `Bearer ${forged}`)
  assert.equal(res.status, 401)
})

test('an HS256 token signed with the public key is rejected', async () => {
  const pub = process.env.JWT_PUBLIC_KEY
  const signing = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: '9', role: 'admin' })}`
  const sig = crypto.createHmac('sha256', pub).update(signing).digest('base64url')

  const res = await request(app).get('/admin/users').set('Authorization', `Bearer ${signing}.${sig}`)
  assert.equal(res.status, 401)
})

test('a token for another audience is rejected', async () => {
  const res = await request(app).get('/me').set('Authorization', `Bearer ${analyticsToken}`)
  assert.equal(res.status, 401)
  assert.equal(res.body.error, 'invalid_token')
})
```

These three tests catch every regression on this page that a code review misses. Run them with `node --test`.

## Security considerations

- **A JWT is a bearer token.** Whoever holds it is the user. TLS everywhere, `httpOnly` cookies, never in a URL, never in a log.
- **The signature says nothing about freshness or intent.** `exp`, `iss` and `aud` are separate checks, and two of the three are opt-in.
- **Asymmetric keys shrink the blast radius.** Verifiers hold only a public key, so a compromised verifier cannot mint tokens.
- **Every revocation strategy costs state.** Choose which one, write it down, and make the latency an explicit number.
- **The error message is part of the attack surface.** Return `invalid_token`; log the detail.

## Production considerations

- **Publish a JWKS and rotate keys on a schedule.** Serve the new key in the JWKS *before* you start signing with it, and keep the old key published for at least one access-token TTL after you stop.
- **Cache the JWKS and set a timeout.** `createRemoteJWKSet` handles both; without a `timeoutDuration` your authentication path inherits your identity provider's latency.
- **Alert on verification-failure rate.** A spike in `invalid algorithm` or `invalid signature` is somebody probing. A spike in `token_expired` after a deploy is usually your clock or your TTL.
- **Keep `JWT_PRIVATE_KEY` out of the API process** if you can — sign in the auth service, verify everywhere else. See [Secrets management](secrets-management.md).
- **Never log the raw token.** Log `jti`, `sub`, `iss` and the failure reason. A token in a log is a live credential in a system that is backed up, shipped and retained.

## Common mistakes

- **`jwt.decode()` where `jwt.verify()` was meant.** Total bypass; no error to notice.
- **Omitting `algorithms`.** Works today because of library defaults, breaks the day someone passes the key as bytes or reads `alg` from the header.
- **`algorithms: [header.alg]`.** Handing the attacker the algorithm choice, in writing.
- **Assuming the payload is private.** It is base64, not encryption.
- **No `exp`, or `expiresIn` set at sign time but no `maxAge`/`exp` check at verify time.**
- **Skipping `aud` in a multi-service estate.** One provider, many services, one token that opens all of them.
- **An HS256 secret a human typed.** `hashcat -m 16500` and a wordlist.
- **Sharing one HS256 secret across services.** Every verifier can now forge tokens for every other service. Use RS256.
- **Storing the token in `localStorage` "because CSRF".** You traded a mitigatable risk for an unmitigatable one.
- **A token in a query string.** Access logs, `Referer` headers, browser history.
- **Building a key path or a SQL query from `kid`.** Path traversal and injection into the one code path that decides who you are.
- **Taking the JWKS URL from the token's `iss`.** SSRF and full authentication bypass in a single line.
- **`clockTolerance` in minutes.** That is your revocation delay, not a tolerance.
- **Returning `err.message` from `jwt.verify` to the client.** It names the exact claim that failed.

## Related topics

- [Authentication and session security](authentication-and-session-security.md) — server-side sessions, and when they are the better answer.
- [Authentication](../express-libraries/authentication.md) — wiring Passport and `passport-jwt` around this.
- [Secrets management](secrets-management.md) — where signing keys live and how they rotate.
- [CSRF](csrf.md) — the risk you take on by putting the token in a cookie.
- [XSS](xss.md) — the risk you take on by putting it in `localStorage`.
- [Security headers](security-headers.md) — `Cache-Control: no-store` on any response containing a token.
- [Logging without leaking PII](logging-without-leaking-pii.md) — keeping tokens out of your log pipeline.
- [OWASP API Top 10 in Express](owasp-api-top-10.md) — API2:2023, of which this page is the token half.
- [Cookies](../express-libraries/cookies.md) — cookie attributes and the `__Host-` prefix.
