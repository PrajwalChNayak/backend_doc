---
title: Authentication
description: JWTs with jsonwebtoken 9 and jose 6, server-side sessions with express-session and connect-redis, and an honest assessment of when Passport earns its place.
status: current
updated: 2026-09-08
---

Authentication answers one question: which principal is making this request. Everything else — permissions, ownership, tenancy — is authorization and belongs elsewhere. This page covers the two mechanisms worth using in an Express 5 API, the exact options that make each of them safe, and when to reach for Passport.

## Choosing a mechanism

| | Server-side session | JWT |
| --- | --- | --- |
| State | Session record in Redis or a database | None; the token is the state |
| Revocation | Delete the record — immediate | Hard. Requires a deny-list, which reintroduces the state |
| Transport | Cookie, usually | `Authorization: Bearer`, sometimes a cookie |
| Cross-origin | Needs `SameSite=None; Secure` + CORS credentials | Header travels anywhere |
| Size | ~32-byte ID | 300 B – 2 KB on every request |
| Best for | Browser apps you control end to end | Service-to-service, mobile, federated identity |

The default answer for a first-party web app is a **session**. Revocation-on-logout that actually works is worth more than statelessness at almost every scale. Reach for JWTs when the verifier cannot share a session store with the issuer — a different service, a different company, an OIDC provider.

You can also combine them: a short-lived access JWT plus a long-lived refresh token held in a session store, which gets you stateless verification on the hot path and real revocation on the refresh path.

## JWTs with jsonwebtoken 9

```bash
npm install jsonwebtoken@9
```

### Signing

```js title="src/auth/jwt.js"
import jwt from 'jsonwebtoken'

const SECRET = process.env.JWT_SECRET // 32+ random bytes, from the environment
const ISSUER = 'https://api.example.com'
const AUDIENCE = 'https://app.example.com'

export function signAccessToken(user) {
  return jwt.sign(
    { role: user.role },
    SECRET,
    {
      algorithm: 'HS256',
      subject: String(user.id),
      issuer: ISSUER,
      audience: AUDIENCE,
      expiresIn: '15m',
      jwtid: crypto.randomUUID(),
    },
  )
}
```

Put identity in `sub`, not in a custom `userId` claim, and keep the payload small — it is base64url, not encrypted, and every request carries it.

### Verifying

```js title="src/auth/jwt.js"
export function verifyAccessToken(token) {
  return jwt.verify(token, SECRET, {
    algorithms: ['HS256'], // NOT optional. See below.
    issuer: ISSUER,
    audience: AUDIENCE,
    clockTolerance: 5, // seconds, for clock skew between hosts
  })
}
```

:::danger
**Always pass `algorithms`.** Without it, `jwt.verify` accepts whichever algorithm the token's own header names. With an RSA setup that becomes the classic confusion attack: the attacker takes your *public* key, signs a token with `alg: HS256` using that public key as the HMAC secret, and your server — which "knows" the public key — verifies it happily. With `algorithms: ['RS256']` the token is rejected before the signature is checked.

`jsonwebtoken` 9 already refuses `alg: none` and blocks the most obvious confusion cases, but pinning the algorithm is the guarantee, not a defense-in-depth nicety.
:::

`issuer` and `audience` are equally load-bearing. Without `audience`, a token minted for your staging environment, or by a shared identity provider for a completely different application, verifies against your production API. Without `issuer`, any party holding a key you trust for anything can mint tokens for you.

`expiresIn` is not a default. Omit it and the token is valid forever, which converts a single leaked token from an incident into a permanent backdoor.

### Middleware

```js title="src/auth/middleware.js"
import { verifyAccessToken } from './jwt.js'

export function requireAuth(req, res, next) {
  const header = req.get('authorization')
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'unauthorized' })
  }

  try {
    const claims = verifyAccessToken(header.slice('Bearer '.length))
    req.user = { id: claims.sub, role: claims.role }
    next()
  } catch (err) {
    // TokenExpiredError, JsonWebTokenError, NotBeforeError.
    // Distinguish expiry so the client knows to refresh; say nothing else.
    const code = err.name === 'TokenExpiredError' ? 'token_expired' : 'invalid_token'
    res.status(401).json({ error: code })
  }
}
```

`jwt.verify` is synchronous when you do not pass a callback, so `try/catch` is correct here. Do not put the error message in the response — "invalid signature" versus "jwt malformed" tells an attacker which part of their forgery to fix.

### Asymmetric keys and JWKS with jose 6

When the party verifying the token is not the party that signed it, symmetric keys stop working: every verifier would need the signing secret, and any of them could then mint tokens. Use RS256 or ES256 and publish the public keys as a JWKS.

```bash
npm install jose@6
```

```js title="src/auth/jose.js"
import { createRemoteJWKSet, jwtVerify, SignJWT, importPKCS8 } from 'jose'

const JWKS = createRemoteJWKSet(new URL(process.env.JWKS_URL), {
  cacheMaxAge: 600_000, // 10 minutes (default)
  cooldownDuration: 30_000, // min gap between refetches for an unknown kid
  timeoutDuration: 5_000,
})

export async function verify(token) {
  const { payload, protectedHeader } = await jwtVerify(token, JWKS, {
    algorithms: ['RS256'],
    issuer: 'https://idp.example.com/',
    audience: 'https://api.example.com',
    maxTokenAge: '1h',
  })
  return { payload, protectedHeader }
}
```

`createRemoteJWKSet` fetches the key set, caches it, and refetches when a token arrives with an unknown `kid` — which is what makes provider key rotation invisible to you. The cooldown stops a flood of tokens with bogus `kid`s from turning into a flood of outbound requests.

`jose` never accepts `alg: none`, and `algorithms` restricts it further. `maxTokenAge` adds a check on `iat` that `exp` alone does not give you.

Signing, for completeness:

```js
const privateKey = await importPKCS8(process.env.JWT_PRIVATE_KEY, 'RS256')

const token = await new SignJWT({ role: 'admin' })
  .setProtectedHeader({ alg: 'RS256', kid: process.env.JWT_KID })
  .setSubject(String(user.id))
  .setIssuer('https://api.example.com')
  .setAudience('https://app.example.com')
  .setIssuedAt()
  .setExpirationTime('15m')
  .sign(privateKey)
```

`jose` is the better library for anything modern: it is ESM-first, uses the Web Crypto API, covers JWE and JWKS, and its API makes it hard to omit a claim by accident. `jsonwebtoken` remains fine for a symmetric first-party token and has a much larger install base.

### Where to put the token in a browser

`localStorage` is readable by any script on the page, so one XSS becomes token theft. An `httpOnly` cookie is not readable by script, but is sent automatically, which reintroduces CSRF. There is no third option that avoids both.

For a browser app the honest answer is usually: use a session cookie (below) with `SameSite`, and keep JWTs for the non-browser callers. If you must use a JWT in a browser, put it in an `httpOnly`, `Secure`, `SameSite` cookie and add CSRF protection — see [Cookies](cookies.md) and [CSRF](../security/csrf.md).

The full catalogue of JWT failures — `alg` confusion, missing expiry, unverifiable revocation, `kid` injection — is in [JWT pitfalls](../security/jwt-pitfalls.md).

## Sessions with express-session and Redis

```bash
npm install express-session@1 connect-redis@10 redis@6
```

```js title="src/auth/session.js"
import session from 'express-session'
import { RedisStore } from 'connect-redis'
import { createClient } from 'redis'

const redis = createClient({ url: process.env.REDIS_URL })
redis.on('error', (err) => console.error({ err }, 'redis error'))
await redis.connect()

export const sessionMiddleware = session({
  store: new RedisStore({ client: redis, prefix: 'sess:', ttl: 86_400 }),
  name: 'sid', // not the default 'connect.sid'
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  proxy: true, // trust X-Forwarded-Proto for the `secure` cookie flag
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 24 * 60 * 60 * 1000,
    path: '/',
  },
})
```

```js title="src/app.js"
app.set('trust proxy', 1)
app.use(sessionMiddleware)
```

`connect-redis` 10 exports `RedisStore` as a **named** export. The default-export form (`import RedisStore from 'connect-redis'`) was correct in v7 and earlier and breaks here.

Every option above is doing work:

| Option | Why |
| --- | --- |
| `store` | Without it you get `MemoryStore` — see the warning below |
| `name: 'sid'` | The default `connect.sid` announces your stack to every scanner |
| `resave: false` | Stops rewriting an unmodified session on every request; avoids a write race between concurrent requests |
| `saveUninitialized: false` | No session record — and no `Set-Cookie` — for anonymous visitors. Also the cookie-consent-friendly setting |
| `rolling: true` | Refreshes the cookie expiry on activity, so active users are not logged out mid-task |
| `proxy: true` | Behind TLS termination, tells express-session to trust `X-Forwarded-Proto` when deciding whether to set a `Secure` cookie |
| `cookie.httpOnly` | Keeps the session ID out of `document.cookie`, so XSS cannot read it directly |
| `cookie.secure` | The cookie is never sent over plain HTTP |
| `cookie.sameSite: 'lax'` | The browser withholds the cookie on cross-site `POST`s — a large part of CSRF, for free |
| `cookie.maxAge` | An absolute lifetime. `rolling` extends it; it does not remove it |

:::danger
The default store is `MemoryStore`. It leaks memory (nothing ever expires), it is per-process (so half your requests find no session behind a load balancer), and every session vanishes on deploy. `express-session` prints a warning about this at startup in production. It is not a warning to suppress.
:::

### Session fixation

If the session ID does not change when the user authenticates, an attacker who can plant a known ID in the victim's browser (via a subdomain, an XSS, or a URL parameter on an older stack) is holding a valid authenticated session the moment the victim logs in.

`req.session.regenerate()` issues a new ID and discards the old record:

```js title="src/routes/auth.js"
router.post('/login', authLimiter, async (req, res) => {
  const user = await verifyCredentials(req.valid.body.email, req.valid.body.password)
  if (!user) return res.status(401).json({ error: 'invalid_credentials' })

  await new Promise((resolve, reject) => {
    req.session.regenerate((err) => (err ? reject(err) : resolve()))
  })

  req.session.userId = user.id

  await new Promise((resolve, reject) => {
    req.session.save((err) => (err ? reject(err) : resolve()))
  })

  res.json({ id: user.id, email: user.email })
})
```

Two details:

- `regenerate()` wipes the session data, so set `userId` **after** it, not before.
- The explicit `save()` closes a race: `express-session` writes the store at the end of the response, and a client that immediately fires a second request can beat that write. Saving before responding removes the window.

Regenerate on privilege changes too — impersonation, an admin role grant, a step-up MFA challenge.

Logging out is `req.session.destroy()` plus clearing the cookie:

```js
router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('sid', { path: '/', httpOnly: true, sameSite: 'lax' })
    res.status(204).end()
  })
})
```

`res.clearCookie()` in Express 5 ignores `maxAge` and `expires`, and the browser only clears a cookie when `path` and `domain` match those used to set it. Pass the same options you passed to `res.cookie` (or that `express-session` used) or the cookie survives.

### Reading the session

```js title="src/auth/middleware.js"
export function requireSession(req, res, next) {
  if (!req.session?.userId) return res.status(401).json({ error: 'unauthorized' })
  req.user = { id: req.session.userId }
  next()
}
```

Store the user **ID**, not the user object. A cached role or email in the session goes stale the moment it changes and can leave a demoted user with admin rights until they log out.

## Passport 0.7

Passport is a strategy registry: one interface, several hundred community strategies, and a small amount of session plumbing.

```bash
npm install passport@0.7 passport-local@1 passport-jwt@4
```

```js title="src/auth/passport.js"
import passport from 'passport'
import { Strategy as LocalStrategy } from 'passport-local'
import { Strategy as JwtStrategy, ExtractJwt } from 'passport-jwt'
import { verifyPassword } from './password.js'

passport.use(
  new LocalStrategy({ usernameField: 'email' }, async (email, password, done) => {
    try {
      const user = await findUserByEmail(email)
      if (!user || !(await verifyPassword(user.passwordHash, password))) {
        return done(null, false, { message: 'invalid_credentials' })
      }
      return done(null, user)
    } catch (err) {
      return done(err)
    }
  }),
)

passport.use(
  new JwtStrategy(
    {
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: process.env.JWT_SECRET,
      algorithms: ['HS256'], // same rule as jwt.verify — pin it
      issuer: 'https://api.example.com',
      audience: 'https://app.example.com',
    },
    async (payload, done) => {
      try {
        const user = await findUserById(payload.sub)
        return user ? done(null, user) : done(null, false)
      } catch (err) {
        return done(err)
      }
    },
  ),
)

// Only needed for the session-backed flow.
passport.serializeUser((user, done) => done(null, user.id))
passport.deserializeUser(async (id, done) => {
  try {
    done(null, await findUserById(id))
  } catch (err) {
    done(err)
  }
})

export default passport
```

```js title="src/app.js"
app.use(sessionMiddleware)
app.use(passport.initialize())
app.use(passport.session()) // omit for a stateless JWT-only API
```

```js title="src/routes/auth.js"
router.post('/login', authLimiter, passport.authenticate('local'), (req, res) => {
  res.json({ id: req.user.id })
})

router.get('/me', passport.authenticate('jwt', { session: false }), (req, res) => {
  res.json({ id: req.user.id })
})
```

Note that `passport.authenticate('local')` calls `req.logIn()` internally, which calls `req.session.regenerate()` — so the session-fixation fix is handled for you in this path.

`req.logout()` takes a **callback** as of Passport 0.6; the zero-argument form silently did nothing.

```js
router.post('/logout', (req, res, next) => {
  req.logout((err) => {
    if (err) return next(err)
    req.session.destroy(() => {
      res.clearCookie('sid', { path: '/', httpOnly: true, sameSite: 'lax' })
      res.status(204).end()
    })
  })
})
```

### Is Passport worth it?

**Yes, when you need third-party identity providers.** Google, GitHub, SAML, OIDC — implementing OAuth 2 correctly, including PKCE and state handling, is real work, and the strategies have had years of scrutiny. This is the case that justifies Passport.

**No, for email-and-password against your own database.** The `LocalStrategy` above is fifteen lines wrapping a function you already wrote, plus a callback-based API, plus `serializeUser`/`deserializeUser` indirection, plus a middleware that stores state on `req` in ways that are awkward to test. A plain handler that calls `verifyPassword` and sets `req.session.userId` is shorter and easier to follow.

**No, for verifying your own JWTs.** `passport-jwt` is a thin wrapper over `jsonwebtoken`. The 12-line middleware earlier in this page does the same job with fewer moving parts and clearer errors.

Passport is also somewhat sleepy as a project, and the individual strategies vary a great deal in maintenance. Check the specific strategy's activity before depending on it. If you adopt Passport, adopt it for the federated flows and keep your first-party login as ordinary code.

## Security considerations

**Pin the algorithm on every verify.** `algorithms: ['HS256']` or `['RS256']`. This is the single highest-impact line on this page.

**Verify `iss` and `aud`.** A signature check alone answers "was this signed by a key I trust", not "was this meant for me".

**Set an expiry, and keep it short.** 15 minutes for an access token. Long-lived tokens cannot be revoked in any way that preserves statelessness.

**Revocation needs state.** If you must revoke JWTs, keep a deny-list of `jti` values in Redis with a TTL equal to the token lifetime, and check it on every request. At that point you have a session with extra steps — which is a reason to consider using a session.

**Regenerate the session ID on login.** Otherwise session fixation is live.

**Never put the session ID in a URL.** It leaks through `Referer`, logs, and browser history.

**Do not store roles or permissions in the token or session.** Or if you do, accept that a revoked permission stays live until expiry. Read authorization from the database on the requests where it matters.

**Return one generic error for bad credentials.** "No such user" versus "wrong password" is a user-enumeration oracle. Also keep the timing similar — hash a dummy password when the user does not exist, so the response time does not reveal the answer.

**Rate limit the auth endpoints hard.** Login, password reset, token refresh, MFA verification. See [Rate limiting](rate-limiting.md).

**Secrets come from the environment and are at least 32 random bytes.** A guessable `SESSION_SECRET` or `JWT_SECRET` makes every other control on this page irrelevant. See [Secrets management](../security/secrets-management.md).

**`SESSION_SECRET` supports rotation** — pass an array, with the new secret first; older ones still verify existing cookies.

## Production considerations

**The session store is now a hard dependency.** If Redis is down, nobody can log in and nobody's session resolves. Give it a health check, alert on it, and decide explicitly whether an unreachable store returns 503 or degrades to anonymous.

**Set the store TTL and the cookie `maxAge` consistently.** `connect-redis` derives the TTL from the cookie's expiry when there is one, and falls back to its `ttl` option (default 86400 seconds) otherwise. Mismatched values produce sessions that expire server-side while the browser still sends the cookie.

**`secure: true` behind a proxy needs `app.set('trust proxy', …)` or `proxy: true`.** Without it, Express sees an HTTP connection from the load balancer, decides the connection is insecure, and refuses to set the cookie at all. The symptom is "login works locally, does nothing in production".

**Cookies do not cross origins by default.** A frontend on `app.example.com` calling `api.example.com` needs `credentials: true` in the CORS config *and* `credentials: 'include'` in the client fetch. A frontend on a genuinely different site needs `SameSite=None; Secure`, which turns CSRF protection back off.

**Key rotation.** For JWKS, publish both keys through the rotation window and let `kid` route to the right one. For HMAC secrets, verify against an array of secrets while signing with only the newest.

**Watch the token size.** A JWT with a large payload is sent on every request; at 2 KB across a mobile connection that is noticeable, and some proxies cap header size around 8 KB.

**Log authentication events.** Success, failure, logout, and password change, with a user ID and request ID — never with the password, the token, or the session ID. See [Logging without leaking PII](../security/logging-without-leaking-pii.md).

## Common mistakes

- **Calling `jwt.verify` without `algorithms`.** Algorithm confusion, in one omitted option.
- **No `expiresIn`.** A token that never expires cannot be taken back.
- **Skipping `issuer` / `audience`.** Staging tokens work in production; another tenant's tokens work on yours.
- **Storing JWTs in `localStorage`.** One XSS and every session is exfiltrated.
- **Running `MemoryStore` in production.** Leaks memory, breaks under more than one instance, loses everything on deploy.
- **Not regenerating the session on login.** Session fixation.
- **Setting session data before `regenerate()`.** It is wiped.
- **`import RedisStore from 'connect-redis'`.** Version 10 uses a named export.
- **`resave: true` / `saveUninitialized: true`.** Write amplification, spurious cookies for anonymous visitors, and a lost-update race.
- **`res.clearCookie('sid')` with different options than `res.cookie` used.** The browser keeps the cookie.
- **`req.logout()` with no callback.** Since Passport 0.6 it is required, and the old form failed silently.
- **Different error responses for unknown user and wrong password.** User enumeration.
- **Putting roles in the token and never re-checking.** Revocation does nothing until expiry.
- **Reaching for Passport to do email-and-password against your own users table.** More indirection than the fifteen lines it replaces.

## Related topics

- [JWT pitfalls](../security/jwt-pitfalls.md) — algorithm confusion, `kid` injection, and revocation, with exploits.
- [Authentication and session security](../security/authentication-and-session-security.md) — fixation, hijacking, and the full session threat model.
- [Password hashing](password-hashing.md) — the other half of a local login.
- [Cookies](cookies.md) — attributes, prefixes, and why `SameSite` matters here.
- [CSRF](../security/csrf.md) — the attack that cookie-based auth reintroduces.
- [Rate limiting](rate-limiting.md) — stopping credential stuffing against these endpoints.
- [Secrets management](../security/secrets-management.md) — where `JWT_SECRET` and `SESSION_SECRET` come from.
- [Redis](../databases/redis.md) — operating the session store.
