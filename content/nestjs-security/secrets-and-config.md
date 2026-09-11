---
title: Secrets and config validation
description: Keeping secrets out of git, images, logs and URLs in a NestJS 12 service — with @nestjs/config 12.0.0 failing the boot on a missing secret, Zod 4 and Joi v18 schemas, BuildKit secret mounts and rotation without downtime.
status: current
updated: 2026-09-11
---

A secret is compromised the moment it is written somewhere it can be read later. Git history, an image layer, a log line, a URL in an access log — none of these are exotic, and all of them outlive the incident that created them. Nest gives you one strong control the plain-Node stack does not: `@nestjs/config` can refuse to start the application when a required secret is missing or malformed, which turns a 3 a.m. production mystery into a failed deploy.

The framework-independent treatment — how to rotate after a leak, `--env-file` versus `dotenv`, per-environment separation — is in [Secrets management](../security/secrets-management.md). The API tour is [Configuration](../nestjs/configuration.md). This page is the security half, in a Nest 12 service.

## Never commit `.env`

### The threat

A committed secret is public from the moment it is pushed, and deleting it in a later commit changes nothing: the blob is still in the history, in every clone, in every fork, and in the GitHub API long after the repository is made private. Automated scanners find keys in public repositories within minutes of the push.

### The exploit

The attacker does not need your repository to be public — a former contractor's laptop, a leaked CI token, or an accidentally-public fork is enough.

```bash
git clone https://github.com/example/api && cd api
git log --all --full-history -- .env
```

```text
commit 8f2c1a9  2024-11-02  "wip: local setup"
commit c41e770  2025-03-18  "remove .env (oops)"
```

```bash
git show 8f2c1a9:.env
```

```text
DATABASE_URL=postgres://app:S3cur3P%40ss@db.example.test:5432/app
JWT_SECRET=production-signing-key-2024
STRIPE_SECRET_KEY=sk_live_51H...
```

The "remove .env (oops)" commit is the tell. Every secret in that file is live unless somebody rotated it, and almost nobody does.

### The fix

**Ignore it, commit an example, and never let the real one exist in a tracked path.**

```text title=".gitignore"
.env
.env.*
!.env.example
```

```env title=".env.example — committed, and doubles as documentation of the schema"
NODE_ENV=development
PORT=3000
DATABASE_URL=
JWT_PRIVATE_KEY=
JWT_PUBLIC_KEY=
SESSION_SECRET=
STRIPE_SECRET_KEY=
```

**Once it is committed, rotate first.** Rewriting history is the slower, less important half: the value is already out, and every clone taken before the rewrite still has it. Revoke the key at the provider, issue a new one, deploy, *then* clean the history.

**Catch it before the push.** A pre-commit hook is cheap and catches the accident that produces almost every one of these:

```bash title=".husky/pre-commit"
#!/bin/sh
# Refuse to stage a real .env at all.
if git diff --cached --name-only | grep -qE '(^|/)\.env($|\.)' ; then
  echo 'Refusing to commit a .env file' >&2
  exit 1
fi

# And scan the staged diff for key-shaped strings.
gitleaks protect --staged --redact --no-banner
```

`gitleaks` and `trufflehog` both scan history as well as the working tree; run one of them in CI against the full history, not just the diff, so a secret added on a branch six months ago is still found. On GitHub, turn on secret scanning and **push protection** — it rejects the push rather than reporting it afterwards.

## Fail the boot, not the first request

### The threat

An application that starts with `JWT_SECRET` undefined does not fail cleanly. It fails on the first request that needs it, in a way that depends entirely on how that code path was written — and a surprising number of them fall back to something.

### The exploit

```ts vulnerable title="DO NOT COPY — src/auth/auth.module.ts"
import { JwtModule } from '@nestjs/jwt'

JwtModule.register({
  // Two bugs in one line: `process.env` bypasses every default and every
  // coercion, and the fallback ships to production.
  secret: process.env.JWT_SECRET ?? 'dev-secret',
  signOptions: { expiresIn: '15m' },
})
```

```bash
# The variable is missing in the new region. The application starts anyway.
unset JWT_SECRET && node dist/main.js
```

```text
[Nest] LOG [NestApplication] Nest application successfully started
```

```bash
# The attacker knows the fallback: it is in your public repository.
node -e '
const jwt = require("jsonwebtoken")
console.log(jwt.sign({ sub: "u-1", role: "admin" }, "dev-secret", { expiresIn: "1h" }))
' > forged.jwt

curl -s -H "authorization: Bearer $(cat forged.jwt)" https://api.example.test/admin/users
```

```json title="200 OK"
[ { "id": "u-771", "email": "dana@example.test", "role": "admin" } ]
```

Green health checks, a successful deploy, and no authentication.

### The fix in code

A schema on `ConfigModule.forRoot()`. `@nestjs/config` **12.0.0** accepts any Standard Schema, so a Zod 4 schema goes in directly, and a validation failure throws during bootstrap.

```ts good title="src/config/env.schema.ts"
import { z } from 'zod'

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),

  DATABASE_URL: z.url(),

  // Length is a real control here: 43 base64url characters is 32 bytes, and a
  // short HS256 secret is crackable offline. See JWT pitfalls.
  SESSION_SECRET: z.string().min(43),
  CSRF_SECRET: z.string().min(43),

  JWT_PRIVATE_KEY: z.string().startsWith('-----BEGIN PRIVATE KEY-----'),
  JWT_PUBLIC_KEY: z.string().startsWith('-----BEGIN PUBLIC KEY-----'),
  JWT_ISSUER: z.url(),
  JWT_AUDIENCE: z.url(),

  STRIPE_SECRET_KEY: z.string().startsWith('sk_'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
})

export type Env = z.infer<typeof envSchema>
```

```ts good title="src/app.module.ts"
import { Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { envSchema } from './config/env.schema.js'

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validationSchema: envSchema,
      // Variables that were already in process.env when the module loaded are
      // validated too — this is the default, and it is what catches a bad
      // value injected by the orchestrator rather than written in a file.
      validatePredefined: true,
    }),
  ],
})
export class AppModule {}
```

```bash
unset JWT_PRIVATE_KEY SESSION_SECRET && node dist/main.js
```

```text
Error: Config validation error:
JWT_PRIVATE_KEY: Invalid input: expected string, received undefined
SESSION_SECRET: Invalid input: expected string, received undefined
```

Exit code non-zero, no listener opened, the orchestrator's readiness probe never passes, and the rollout stops. Every missing variable is reported at once rather than one deploy at a time.

:::note Zod strips unknown keys; `@nestjs/config` puts them back
`process.env` always holds dozens of unrelated variables — `PATH`, `HOME`, everything the container runtime injects. A Zod object schema ignores them rather than failing, and `@nestjs/config` merges the validated output back over the original config, so `config.get('PATH')` still works. You do not need `passthrough()` and you should not use `.strict()`.
:::

### With Joi v18

Joi **18.2.8** implements Standard Schema too, so it also goes straight into `validationSchema`. What moved in v12 is where its library-specific settings live:

```ts good title="src/app.module.ts"
import { Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import Joi from 'joi'

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validationSchema: Joi.object({
        NODE_ENV: Joi.string().valid('development', 'test', 'production').default('development'),
        DATABASE_URL: Joi.string().uri().required(),
        SESSION_SECRET: Joi.string().min(43).required(),
      }),
      validationOptions: {
        // Joi's own options nest here in v12. Placed directly on
        // validationOptions they are ignored.
        libraryOptions: {
          allowUnknown: true,
          abortEarly: false,
        },
      },
    }),
  ],
})
export class AppModule {}
```

The un-nested form is the pre-v12 shape. It does not error — it is silently ignored, Joi reverts to `allowUnknown: false`, and the boot then fails on the dozens of environment variables that were never yours. `@nestjs/config` 12 already applies `abortEarly: false` and `allowUnknown: true` for Joi schemas specifically, so the block above is documentation of intent as much as configuration.

### Read them the strict way

A schema that validates at boot does nothing for a code path that reads `process.env` directly afterwards.

```ts good title="src/stripe/stripe.service.ts"
import { Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import type { Env } from '../config/env.schema.js'

@Injectable()
export class StripeService {
  private readonly apiKey: string

  constructor(config: ConfigService<Env, true>) {
    // getOrThrow() cannot return undefined, and the second type parameter
    // makes get() return T rather than T | undefined for a validated env.
    this.apiKey = config.getOrThrow('STRIPE_SECRET_KEY', { infer: true })
  }
}
```

Read secrets **once, in the constructor**. A `config.get()` inside a request handler turns a typo into an intermittent `undefined` at 2 a.m. instead of a crash at boot.

:::best-practice Grep for `process.env` in CI
Outside `main.ts` and the config module there should be no hits. Every one of them bypasses the schema, the defaults, the coercion, and every test that overrides `ConfigService`.
:::

## Secrets in Docker build args and image layers

### The threat

`ARG` values are recorded in the image metadata. A file written in one layer and deleted in a later one is still in the earlier layer. Anybody who can pull the image — which, for a shared registry, is a much larger group than you think — can read both.

### The exploit

:::danger A secret passed as a build argument
```dockerfile vulnerable title="DO NOT COPY — Dockerfile"
FROM node:24-alpine
ARG NPM_TOKEN
RUN echo "//registry.npmjs.org/:_authToken=${NPM_TOKEN}" > .npmrc \
 && npm ci \
 && rm .npmrc
COPY . .
CMD ["node", "dist/main.js"]
```
:::

```bash
docker history --no-trunc api:latest | grep -i token
```

```text
|1 NPM_TOKEN=npm_9fV2...  /bin/sh -c echo "//registry.npmjs.org/:_authToken=..." > .npmrc && npm ci && rm .npmrc
```

The `rm` did nothing useful — and the same trick recovers the file itself:

```bash
docker save api:latest -o api.tar && mkdir -p x && tar -xf api.tar -C x
grep -rl '_authToken' x/blobs 2>/dev/null | head -1
```

```text
x/blobs/sha256/3b1f9c...
```

### The fix in code

BuildKit secret mounts. The file exists only for the duration of that `RUN` and is never written to a layer.

```dockerfile title="Dockerfile"
# syntax=docker/dockerfile:1.7
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./

# The secret is mounted at /run/secrets/npmrc for this command only.
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc \
    npm ci --omit=dev --ignore-scripts

FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Only the artifacts. No source, no .npmrc, no .env, no build tooling.
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
USER node
CMD ["node", "dist/main.js"]
```

```bash
DOCKER_BUILDKIT=1 docker build --secret id=npmrc,src=$HOME/.npmrc -t api:latest .
```

And a `.dockerignore` that makes the accident impossible rather than unlikely:

```text title=".dockerignore"
.env
.env.*
.git
node_modules
*.pem
*.key
```

`.git` matters as much as `.env` — copying the repository into an image ships the entire history, including the secrets somebody removed in a later commit.

:::warning `ENV` is not better than `ARG`
`ENV SECRET=...` bakes the value into the image *and* leaks it to every process in the container, including any dependency that dumps `process.env` on a crash. Secrets reach a container at **run** time, from the orchestrator, never from the Dockerfile.
:::

Verify before you push:

```bash
docker history --no-trunc api:latest | grep -iE 'secret|token|password|key' || echo 'clean'
```

```text
clean
```

## Secrets in logs and URLs

Two leaks that need no attacker at all.

**The startup dump.** The single most common way a production secret reaches a log aggregator that half the company can read:

:::danger Logging the resolved configuration
```ts vulnerable title="DO NOT COPY — src/main.ts"
const config = app.get(ConfigService)
// Every secret, in your log aggregator, retained for ninety days.
logger.log({ config: process.env }, 'starting with configuration')
```
:::

Log the **names**, not the values, when you want a boot-time record of what was configured:

```ts good title="src/config/config-report.ts"
const SECRET_PATTERN = /(secret|token|password|key|credential|dsn|connection)/i

/**
 * A boot log that proves which variables were present without printing any of
 * them. Useful for "is this the config I think it is" without being a leak.
 */
export function describeEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  const report: Record<string, string> = {}
  for (const [name, value] of Object.entries(env)) {
    report[name] = SECRET_PATTERN.test(name) ? `[set, ${value?.length ?? 0} chars]` : String(value)
  }
  return report
}
```

**The connection string.** `DATABASE_URL` contains a password, and it is exactly the value that ends up in an error message:

```text
Error: connect ECONNREFUSED — postgres://app:S3cur3P%40ss@db.example.test:5432/app
```

Redact it before it is logged, and never put a credential in a query string at all:

```ts good title="src/config/redact-url.ts"
/**
 * URLs in logs keep the host and the path and lose everything else. Query
 * strings and userinfo are where credentials hide.
 */
export function redactUrl(raw: string): string {
  try {
    const url = new URL(raw)
    if (url.password) url.password = '***'
    if (url.username) url.username = '***'
    for (const key of [...url.searchParams.keys()]) url.searchParams.set(key, '***')
    return url.toString()
  } catch {
    return '[unparseable url]'
  }
}
```

A token in a URL is worse than a token in a header for reasons that have nothing to do with encryption: the URL reaches your access logs, your proxy's access logs, the browser history, and the `Referer` header sent to every third-party resource on the page. Full treatment in [Safe logging](safe-logging.md).

## Rotation without downtime

A secret you cannot rotate is a secret you will not rotate. Design for two valid values at once.

| Secret | How two-at-a-time works |
| --- | --- |
| `SESSION_SECRET` | `express-session` accepts an array: signs with the first, verifies against any |
| `CSRF_SECRET` | `csrf-csrf`'s `getSecret` may return an array with the same semantics |
| JWT signing key | sign with the new key, publish both public keys, keyed by `kid`; retire the old after the longest TTL |
| Database password | create a second role, deploy with it, drop the first |
| Third-party API key | most providers allow two live keys; deploy, then revoke |

```ts good title="src/main.ts"
import session from 'express-session'

/**
 * SESSION_SECRETS is a comma-separated list, newest first. During a rotation
 * it holds two values; afterwards it holds one. Existing cookies stay valid
 * because verification tries every entry.
 */
const secrets = config
  .getOrThrow<string>('SESSION_SECRETS')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean)

if (secrets.length === 0) throw new Error('SESSION_SECRETS must contain at least one value')

app.use(session({ secret: secrets, name: 'sid', resave: false, saveUninitialized: false }))
```

The rotation is then three deploys with no logouts: add the new value at the front, wait out the session lifetime, remove the old value. Validate the list shape in the schema so a deploy with an empty string cannot start.

:::best-practice Rotate on a schedule, not only after an incident
A rotation you have never performed does not work. Rotating quarterly is how you find out that the staging cron job was using the production key.
:::

## A secrets manager, injecting at runtime

Environment variables are the interface; where they come from is the question.

| Source | Read by | Suitable for |
| --- | --- | --- |
| A `.env` file in the image | anybody who can pull the image | nothing |
| A `.env` file on the host | anybody with host access | single-server deployments you own |
| Orchestrator secrets (Kubernetes `Secret`, ECS, Fly) | anybody with `get secrets` in the namespace | most teams |
| A secrets manager injected at start (Vault, AWS/GCP Secrets Manager) | an audited, revocable identity | regulated or multi-team environments |

The pattern that keeps the application simple is **inject and exec**: a wrapper fetches the secrets, puts them in the environment, and replaces itself with the Node process. The application never learns a manager exists, and your tests keep using plain variables.

```dockerfile title="Dockerfile — runtime stage"
# The entrypoint fetches secrets and then `exec`s node, so PID 1 is still node
# and signal handling for graceful shutdown is unaffected.
ENTRYPOINT ["/usr/local/bin/secrets-exec", "--"]
CMD ["node", "dist/main.js"]
```

Two properties to insist on whatever you pick:

- **The application's identity, not a bootstrap password.** A workload identity that the platform attests, so there is no first secret to protect.
- **Audited reads.** "Who read the Stripe key, and when" is the question you will need answered during an incident, and it is only answerable if the manager logs it.

Nest's own hook for this is `ConfigModule.forRoot({ load: [...] })`, which accepts async factories — so a manager can be read at bootstrap instead:

```ts good title="src/config/secrets.loader.ts"
import { registerAs } from '@nestjs/config'
import { fetchSecret } from './secrets-client.js'

/**
 * Async config factories are awaited before the module is resolved, so a
 * manager outage becomes a failed boot rather than a half-configured app.
 */
export const stripeConfig = registerAs('stripe', async () => ({
  secretKey: await fetchSecret('stripe/secret-key'),
}))
```

Whichever you choose, the schema still applies: a secrets manager that returns an empty string should fail the boot exactly like a missing variable.

## How to verify

```bash
# 1 — no secret-shaped file is tracked, anywhere in history
git log --all --full-history --name-only --pretty=format: \
  | sort -u | grep -E '(^|/)\.env($|\.)|\.pem$|\.key$' || echo 'clean'
```

```text
clean
```

```bash
# 2 — the application refuses to start without a required secret
unset SESSION_SECRET && node dist/main.js; echo "exit=$?"
```

```text
Error: Config validation error:
SESSION_SECRET: Too small: expected string to have >=43 characters
exit=1
```

```bash
# 3 — nothing secret-shaped is in the image
docker history --no-trunc api:latest | grep -iE 'secret|token|password' || echo 'clean'
docker run --rm --entrypoint sh api:latest -c 'ls -a /app | grep -c "^\.env$" || true'
```

```text
clean
0
```

```ts title="test/config.e2e-spec.ts"
import { Test } from '@nestjs/testing'
import { ConfigModule } from '@nestjs/config'
import { envSchema } from '../src/config/env.schema.js'

describe('environment validation', () => {
  const original = process.env

  afterEach(() => {
    process.env = original
  })

  it('refuses to build the module without a required secret', async () => {
    process.env = { ...original, NODE_ENV: 'test', SESSION_SECRET: undefined } as NodeJS.ProcessEnv

    await expect(
      Test.createTestingModule({
        imports: [ConfigModule.forRoot({ validationSchema: envSchema, ignoreEnvFile: true })],
      }).compile(),
    ).rejects.toThrow(/SESSION_SECRET/)
  })

  it('refuses a session secret that is too short', async () => {
    process.env = { ...original, NODE_ENV: 'test', SESSION_SECRET: 'short' } as NodeJS.ProcessEnv

    await expect(
      Test.createTestingModule({
        imports: [ConfigModule.forRoot({ validationSchema: envSchema, ignoreEnvFile: true })],
      }).compile(),
    ).rejects.toThrow(/SESSION_SECRET/)
  })

  it('reports every missing variable at once', async () => {
    process.env = { NODE_ENV: 'test' } as NodeJS.ProcessEnv

    await expect(
      Test.createTestingModule({
        imports: [ConfigModule.forRoot({ validationSchema: envSchema, ignoreEnvFile: true })],
      }).compile(),
    ).rejects.toThrow(/DATABASE_URL[\s\S]*SESSION_SECRET/)
  })
})
```

`ignoreEnvFile: true` is what makes these tests deterministic — without it the developer's own `.env` satisfies the schema and every assertion passes locally and fails in CI.

## Production considerations

- **Run a history scan in CI, not just a diff scan.** `gitleaks detect` over the full history catches the secret that was added on a branch and removed in the merge.
- **Turn on push protection.** Rejecting the push is the only control that prevents the leak rather than reporting it.
- **Keep the schema and `.env.example` in sync.** A new required variable with no example entry is a deploy that fails for everybody else.
- **Separate secrets per environment, with no overlap.** A staging key that also works in production means every staging compromise is a production compromise.
- **Give the application the narrowest credential that works.** The runtime database role does DML and no DDL; see [SQL injection](sql-injection.md). The same reasoning applies to every API key you hold.
- **Set an expiry on everything that supports one.** A key that expires is a key that gets rotated.
- **Do not put secrets in `ConfigService` and then serialize the object anywhere.** A health endpoint that echoes configuration, a debug route, `@nestjs/devtools-integration` exposed publicly — each is the same leak with different packaging.
- **Assume a leaked secret was used.** Rotate, then look for what it touched. Revoking without reviewing the audit log tells you nothing about what already happened.

## Common mistakes

- **Committing `.env`, then deleting it in a later commit.** The blob stays in the history; rotate instead.
- **Rewriting history before rotating.** Every clone taken beforehand still has the value.
- **`process.env.X ?? 'fallback'`.** The fallback is in your repository and it ships.
- **Reading `process.env` outside the config module.** Bypasses the schema, the defaults and every test override.
- **No `validationSchema` at all.** The application starts with an undefined secret and fails somewhere else entirely.
- **Placing Joi options directly on `validationOptions`.** Ignored in v12; nest them under `libraryOptions`.
- **A Zod schema with `.strict()`.** `process.env` always has unrelated keys, so the boot fails on `PATH`.
- **`config.get()` inside a request handler.** A typo becomes an intermittent `undefined` rather than a boot failure.
- **A secret as a Docker `ARG`.** Recorded in `docker history` forever.
- **`RUN ... && rm secret`.** The earlier layer still contains the file.
- **`ENV SECRET=` in a Dockerfile.** Baked into the image and visible to every process in the container.
- **No `.dockerignore`, or one that omits `.git`.** The image ships your entire history.
- **Logging `process.env` or the resolved config at startup.** The fastest path from a secret to a log aggregator.
- **A password in `DATABASE_URL` printed in a connection error.** Redact URLs before they reach the logger.
- **A token in a query string.** Access logs, browser history and the `Referer` header.
- **A single-valued secret with no rotation path.** You will not rotate what causes an outage to rotate.
- **A `.env` file baked into the production image.** It shadows the real injected variables and leaks with the image.

## Related topics

- [Secrets management](../security/secrets-management.md) — the framework-independent treatment, including `--env-file` and post-leak cleanup.
- [Configuration](../nestjs/configuration.md) — `ConfigModule`, `registerAs`, typing `ConfigService` and the full option list.
- [JWT pitfalls](jwt-pitfalls.md) — why the signing key's length is a schema constraint.
- [Authentication and session security](authentication-and-session-security.md) — rotating `SESSION_SECRET` without logging everyone out.
- [CSRF](csrf.md) — the `getSecret` array that makes the CSRF secret rotatable.
- [Safe logging](safe-logging.md) — redaction paths, and keeping credentials out of error objects.
- [Dependency auditing](dependency-auditing.md) — the other half of supply-chain hygiene, including `--ignore-scripts`.
- [SQL injection](sql-injection.md) — least-privilege database roles for the credential this page protects.
- [Docker](../nestjs-production/docker.md) — the full multi-stage build this page's Dockerfile is drawn from.
- [Environment configuration](../nestjs-production/configuration.md) — per-environment separation in a deploy pipeline.
- [Continuous integration](../nestjs-production/ci.md) — where the history scan and the image scan run.
