---
title: Secrets management
description: Keeping API keys, database passwords and signing keys out of Git, images, logs and URLs, and rotating them without downtime.
status: current
updated: 2026-09-08
---

A secret is any value that grants access: database passwords, signing keys, third-party API tokens, webhook secrets. The failure mode is never subtle — the secret ends up somewhere it can be read, and then someone reads it. This page is about the five places it leaks (Git, images, logs, URLs, and the developer's laptop) and what to do once it has.

## The rule that costs the most to break: never commit `.env`

**The threat.** A committed secret is public to everyone with repository access, forever, including every fork, every clone, every CI cache, and every laptop that ever pulled. Public-repository secrets are harvested by automated scanners within minutes of the push.

**The exploit is a `git log`.**

```bash
$ git log --all --oneline -- .env
a91f4c2 chore: add local env
$ git show a91f4c2:.env
DATABASE_URL=postgres://app:hunter2@db.internal:5432/app
STRIPE_SECRET_KEY=sk_live_51H8xQ2...
JWT_PRIVATE_KEY=-----BEGIN PRIVATE KEY-----
```

Deleting the file in a later commit changes nothing: `git show` on the old commit still returns it.

**Prevention.**

```gitignore title=".gitignore"
.env
.env.*
!.env.example
*.pem
*.key
*.p12
```

Commit `.env.example` with the *names* and no values, so a new checkout fails loudly on a missing variable instead of silently using a default.

```env title=".env.example"
DATABASE_URL=
SESSION_SECRET=
JWT_PRIVATE_KEY=
STRIPE_SECRET_KEY=
```

### Once it is committed: rotate first, rewrite second

:::danger
Rewriting history does **not** un-leak a secret. Between the push and the rewrite the value was readable by anyone with access, it is in every clone, it is in GitHub's fork network, and it may already be in a scanner's database. Treat every committed secret as compromised.
:::

The order matters, and only the first step is mandatory:

1. **Rotate the credential at its source.** New Stripe key, new database password, new signing key. Until this is done, nothing else helps.
2. **Revoke the old one.** Rotation without revocation leaves the leaked value working.
3. **Check for use.** Search the provider's audit log for the old credential between the commit date and revocation.
4. *Then*, optionally, rewrite history with [`git filter-repo`](https://github.com/newren/git-filter-repo) — worth doing so the value stops being harvestable, not because it undoes the leak.

```bash
# Remove a path from every commit. Rewrites SHAs: everyone must re-clone.
$ pip install git-filter-repo
$ git filter-repo --path .env --invert-paths
$ git push --force --all && git push --force --tags
```

Then ask your host to expire cached views of the old commits — on GitHub, force-pushing does not immediately remove blobs reachable through the fork network, and the support team has to purge them.

### Catch it before the push

| Tool | What it is | Where it runs |
| --- | --- | --- |
| [`gitleaks`](https://github.com/gitleaks/gitleaks) | secret scanner with a rules file | pre-commit hook and CI |
| [`trufflehog`](https://github.com/trufflesecurity/trufflehog) | scanner that also *verifies* found credentials against the provider | CI, and one-off history sweeps |
| [GitHub secret scanning](https://docs.github.com/en/code-security/secret-scanning) with push protection | provider-partnered detection, blocks the push | GitHub server-side |

```bash
# Scan the whole history, not just the working tree.
$ gitleaks detect --source . --redact --verbose

# Verify which found credentials are still live.
$ trufflehog git file://. --results=verified
```

`trufflehog`'s verification step is the one that turns a 200-finding report into the three findings that matter.

## Loading secrets in Node 24: `--env-file` vs `dotenv`

Node has read `.env` files natively since 20.6, stabilised in 24. For local development that removes a dependency:

:::tabs
@tab node --env-file
```bash
node --env-file=.env src/server.js

# Do not fail when the file is absent (e.g. in CI, where the platform injects env vars)
node --env-file-if-exists=.env src/server.js
```
@tab dotenv
```js title="src/server.js"
import 'dotenv/config'          // dotenv 17.4.2
```
:::

| | `node --env-file` | `dotenv` 17.4.2 |
| --- | --- | --- |
| Dependency | none | one, plus its transitive tree |
| Runs before your code | yes — the flag is processed at startup | no — only when the import executes |
| Variable expansion (`${OTHER}`) | not supported | via `dotenv-expand` |
| Multiple files | repeat the flag | `config({ path: [...] })` |
| Programmatic access to parsed values | no | `parse()` returns the object |

Prefer the flag. The "runs before your code" row is the one that bites: with `dotenv`, any module that reads `process.env` at import time — a config module, a database client constructed at module scope — may run *before* `import 'dotenv/config'` depending on hoisting order, and silently sees `undefined`.

:::warning
`.env` files are a **development** convenience. In production the platform injects environment variables, or your process fetches them from a secrets manager at boot. Shipping a `.env` file into a container means the secret is in the image — see the next section.
:::

## Secrets in Docker build args and image layers

**The threat.** An image is a distributable artifact. Anything baked into it travels to your registry, to every host that pulls it, and to anyone who can `docker pull`.

**The exploit.** Build arguments persist in the image metadata:

:::danger
```dockerfile vulnerable title="DO NOT COPY — Dockerfile"
FROM node:24-alpine
ARG NPM_TOKEN
RUN echo "//registry.npmjs.org/:_authToken=${NPM_TOKEN}" > .npmrc && \
    npm ci && rm .npmrc
```
:::

```bash
$ docker build --build-arg NPM_TOKEN=npm_9fA2... -t app .
$ docker history --no-trunc app | grep -o 'npm_[A-Za-z0-9]*'
npm_9fA2xQ...
```

The `rm .npmrc` deleted the file from the filesystem of a later layer. The `RUN` instruction, with the token expanded into it, is still in the history. `COPY .env .` is the same bug with fewer steps.

**The fix.** BuildKit secret mounts. The secret is mounted into the build container at `/run/secrets/<id>` for the duration of one `RUN`, and is never written to a layer:

```dockerfile good title="Dockerfile"
# syntax=docker/dockerfile:1
FROM node:24-alpine
WORKDIR /app
COPY package*.json ./
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc \
    npm ci --omit=dev
COPY . .
USER node
CMD ["node", "src/server.js"]
```

```bash
$ docker build --secret id=npmrc,src=$HOME/.npmrc -t app .
$ docker history --no-trunc app | grep -c 'npm_'
0
```

**Verify any image before you push it:**

```bash
$ docker history --no-trunc app
$ docker inspect app --format '{{json .Config.Env}}'      # ENV values are plain text
$ docker save app | tar -xO | grep -aiE 'BEGIN (RSA )?PRIVATE KEY|sk_live_|AKIA[0-9A-Z]{16}'
```

Runtime secrets are injected at `docker run` / orchestrator level (`--env-file`, a Kubernetes `Secret` mounted as a file, an ECS task-definition secret referencing Secrets Manager) — never at build time.

## Secrets in logs and error messages

**The threat.** Logs are copied to an aggregator, retained for months, and readable by far more people than the production database. A secret in a log is a secret shared with your whole engineering organization and your log vendor.

**The exploit is an unhandled error.** Database drivers and HTTP clients attach the request context to the error:

:::danger
```js vulnerable title="DO NOT COPY"
try {
  await pool.query('SELECT 1')
} catch (err) {
  console.error('db failed', err, { config: pool.options })   // password in options
}

// axios-style errors carry the whole request, including Authorization headers
logger.error({ err }, 'upstream call failed')                 // err.config.headers.authorization
```
:::

```text
db failed Error: password authentication failed
  { host: 'db.internal', user: 'app', password: 'hunter2', database: 'app' }
```

**The fix.** Redact at the logger, not at each call site — a call site you forget is a leak, a logger that redacts is a floor. `pino` 10.3.1:

```js good title="src/logger.js"
import pino from 'pino'

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'res.headers["set-cookie"]',
      'err.config.headers.authorization',
      'err.config.auth',
      '*.password',
      '*.passwordHash',
      '*.token',
      '*.secret',
      'config.connectionString',
    ],
    censor: '[redacted]',
  },
})
```

Full treatment, including array paths and the cost of wildcards: [Logging without leaking PII](logging-without-leaking-pii.md).

**And never echo a secret in an HTTP error.** `res.status(500).json({ error: err.message })` will one day return a connection string to a user.

## Secrets in URLs

**The threat.** A query string is not a private channel. It is recorded in:

- your reverse proxy's access log and your application's HTTP log,
- every intermediate proxy's log,
- the browser's history and the address bar,
- the `Referer` header sent to **every third-party origin** the page loads — analytics, fonts, an embedded map.

:::danger
```text vulnerable title="DO NOT COPY"
GET /reports/export?api_key=sk_live_51H8xQ2 HTTP/1.1
GET /reset?token=9f2a...          HTTP/1.1
```
:::

```text
# nginx access.log, retained 90 days, shipped to three systems
10.0.0.7 - - [08/Sep/2026:11:02:41] "GET /reports/export?api_key=sk_live_51H8xQ2 HTTP/1.1" 200
```

**The fix.** Secrets go in headers or in a request body, never in a path or a query string:

```bash
$ curl -H "Authorization: Bearer $TOKEN" https://api.example.com/reports/export
```

For links that must carry a one-time token (password reset, email confirmation), put it in a **path segment** rather than a query parameter, set `Referrer-Policy: no-referrer` on that page, and make the token single-use with a short TTL so a leaked log line expires quickly.

```js good
// path segment, not ?token=
await sendResetEmail(email, `https://app.example.com/reset/${token}`)
```

If your framework or a partner forces a query parameter, strip it in the access log format before the line is written, and treat the token as already-leaked: single use, minutes not hours.

## A secrets manager, and injecting at runtime

Environment variables set by your platform are a reasonable baseline. A secrets manager adds three things they lack: an audit trail of every read, per-secret access policy, and rotation without a redeploy.

| Service | Node client | Notes |
| --- | --- | --- |
| AWS Secrets Manager | `@aws-sdk/client-secrets-manager` 3.1128.0 | native rotation via Lambda; IAM-scoped |
| GCP Secret Manager | `@google-cloud/secret-manager` 7.1.0 | versioned secrets, IAM-scoped |
| HashiCorp Vault | HTTP API (or `node-vault` 0.12.0) | dynamic short-lived database credentials |

Fetch at boot, cache in memory, and never write to disk:

```js good title="src/config/secrets.js"
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager'

const client = new SecretsManagerClient({})
const cache = new Map()

export async function getSecret(name, { ttlMs = 5 * 60 * 1000 } = {}) {
  const hit = cache.get(name)
  if (hit && hit.expires > Date.now()) return hit.value

  const res = await client.send(new GetSecretValueCommand({ SecretId: name }))
  const value = JSON.parse(res.SecretString)
  cache.set(name, { value, expires: Date.now() + ttlMs })
  return value
}
```

The TTL is what makes rotation take effect without a deploy: after at most five minutes, every instance has the new value.

The alternative — a sidecar or init container that writes the secret into the environment before your process starts — keeps the SDK out of your app but reintroduces the redeploy for rotation. Pick based on how often you rotate.

## Validate at boot and fail fast

**The threat.** A missing secret that surfaces as `undefined` produces a *worse* outcome than a crash: `jwt.sign(payload, undefined)` throws at the first login, a missing `SESSION_SECRET` may fall back to a default someone added "for tests", and a missing feature flag silently disables a check.

**The fix.** Parse the whole environment once, at import time, before anything else runs. A bad config becomes a startup failure, which your orchestrator will show you, rather than a 3 a.m. page.

```js good title="src/config/index.js"
import { z } from 'zod'

const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().startsWith('postgres://'),
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET needs at least 32 characters'),
  JWT_PRIVATE_KEY: z.string().startsWith('-----BEGIN'),
  STRIPE_SECRET_KEY: z.string().startsWith('sk_'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
})

const parsed = Env.safeParse(process.env)

if (!parsed.success) {
  // Names only. Never print the values — this output goes to your log pipeline.
  const missing = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`)
  console.error(`Invalid environment:\n  ${missing.join('\n  ')}`)
  process.exit(1)
}

export const config = Object.freeze(parsed.data)
```

Import `config` everywhere instead of reading `process.env` in twelve modules. That gives you one place to see every secret the app needs, and it makes `grep -r 'process.env' src/` a lint rule rather than an archaeology exercise.

**Verify it.**

```bash
$ SESSION_SECRET=short node src/server.js
Invalid environment:
  SESSION_SECRET: SESSION_SECRET needs at least 32 characters
$ echo $?
1
```

## Rotation without downtime

**The threat.** The naive rotation — change the secret, redeploy — invalidates every artifact signed with the old one at the instant of the switch. Every session dies, every in-flight webhook fails signature verification, every unexpired token 401s.

**The fix: a dual-verification window.** Sign with the new key; verify against new *and* old; retire the old only after everything signed with it has expired.

```js good title="src/lib/keys.js"
import crypto from 'node:crypto'

// KEYS_CURRENT signs. KEYS_PREVIOUS only verifies, and is removed after the window.
const CURRENT = process.env.WEBHOOK_SECRET_CURRENT
const PREVIOUS = process.env.WEBHOOK_SECRET_PREVIOUS      // may be undefined

const hmac = (secret, body) => crypto.createHmac('sha256', secret).update(body).digest()

export function sign(body) {
  return hmac(CURRENT, body).toString('hex')
}

export function verify(body, signatureHex) {
  const provided = Buffer.from(signatureHex, 'hex')
  return [CURRENT, PREVIOUS].filter(Boolean).some((secret) => {
    const expected = hmac(secret, body)
    return provided.length === expected.length && crypto.timingSafeEqual(provided, expected)
  })
}
```

The rollout is three deploys, and the middle one is the whole point:

| Step | Signs with | Also verifies | Before moving on |
| --- | --- | --- | --- |
| 0. Steady state | old | — | — |
| 1. Teach every instance the new key | old | new | wait until the deploy has reached **every** instance |
| 2. Switch signing | new | old | wait longer than the longest artifact TTL |
| 3. Drop the old key | new | — | done |

Step 1 must reach every instance before step 2 starts. Skip the wait and an instance that has not yet learned the new key will reject artifacts signed with it.

The same shape works for `express-session` (`secret` accepts an array — first signs, all verify), for JWT signing keys (publish the new key in your JWKS before signing with it), and for database passwords (create a second role, migrate connections, drop the first).

## Per-environment separation

One secret per environment, always. Shared secrets mean a staging compromise is a production compromise, and staging is where the debug endpoints live.

- **Separate accounts or projects**, not just separate values — so a staging IAM role physically cannot read the production secret.
- **Never copy production data or credentials into staging.** The most common breach path in a well-run shop is a production database restored into a development environment with weaker access control.
- **Different key material per environment**, so a token minted in staging is rejected in production. If your staging JWT verifies in production, they are the same environment wearing two names.
- **Make the environment name part of the secret path**: `/app/production/database-url`, `/app/staging/database-url`. A wrong-environment read then fails on IAM rather than silently succeeding.

## Security considerations

- **Treat every secret that has ever been in Git, a log, an image, or a URL as compromised.** Rotate it. The cleanup is secondary.
- **A secrets manager does not protect a secret your process has already logged.** Redaction and the manager are separate controls.
- **Anyone who can exec into your container can read `process.env`.** Restrict that access; it is a production credential dump.
- **`process.env` is visible to every dependency in the process.** A malicious postinstall or a compromised transitive package reads it directly. That is a supply-chain problem, not a secrets problem — see [Dependency auditing](dependency-auditing.md).
- **Core dumps and heap snapshots contain secrets in plaintext.** Disable core dumps in production, and treat any captured heap snapshot as a secret artifact.

## Production considerations

- **Rotate on a schedule, not on incidents.** A rotation you have practiced takes an hour; a rotation you have never run takes a day, during an incident.
- **Give every secret an owner and an expiry date.** Unowned credentials are never rotated and never revoked.
- **Audit reads.** A secrets manager gives you "who read `stripe-secret-key`, from where, when". Alert on reads from outside the expected roles.
- **Scope credentials down.** A read-only database role for the reporting service, a restricted Stripe key for the webhook receiver. The blast radius of a leak is exactly the permissions you granted.
- **Run `gitleaks` in CI on every pull request**, and enable push protection on the host if available so the block happens before the object exists.
- **Have a written revocation runbook per provider.** During an incident, "where do I revoke a Stripe key" should not be a search.

## Common mistakes

- **Deleting `.env` in a follow-up commit and calling it fixed.** The blob is still in history. Rotate.
- **Rewriting history but not rotating.** Backwards. Rotation is the fix; the rewrite is hygiene.
- **`ARG`/`ENV` for build-time secrets.** Visible in `docker history` and `docker inspect` forever.
- **`COPY .env .` in a Dockerfile.** The secret is now in a layer and in your registry.
- **`console.error(err)` on a database or HTTP client error.** Connection strings and `Authorization` headers ride along on the error object.
- **A secret in a query string.** Access logs, `Referer`, browser history — three copies you do not control.
- **A default value for a secret.** `process.env.SESSION_SECRET ?? 'dev-secret'` ships to production the first time someone forgets to set it.
- **Reading `process.env` at ten call sites.** No single place shows what the app needs, and no place validates it.
- **One secret shared across environments.** Staging becomes a production credential store.
- **Rotating by flipping the value in one step.** Everything signed with the old key breaks at once. Use a dual-verification window.
- **Committing `.env.example` with real values in it.** It happens constantly. The example file holds names only.

## Related topics

- [Environment variables and config](../node/environment-variables-and-config.md) — `--env-file`, config layering, and typed config objects.
- [Configuration](../production/configuration.md) — how config reaches a deployed process.
- [Dockerfile](../production/dockerfile.md) — the full production image, including the BuildKit secret mount.
- [Logging without leaking PII](logging-without-leaking-pii.md) — `pino` redaction in detail.
- [JWT pitfalls](jwt-pitfalls.md) — signing keys, key rotation and JWKS.
- [Authentication and session security](authentication-and-session-security.md) — rotating `SESSION_SECRET` with the array form.
- [Dependency auditing](dependency-auditing.md) — the dependencies that can read `process.env`.
- [Continuous integration](../production/ci.md) — where to run `gitleaks` and how CI holds its own secrets.
