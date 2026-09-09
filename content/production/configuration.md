---
title: Configuration
description: One typed config module validated with Zod 4 at boot and frozen, read from the environment, failing fast on a missing secret.
status: current
updated: 2026-09-08
---

Configuration is everything that differs between your laptop, staging and production. Get it wrong and you find out at 3am, because a missing environment variable becomes `undefined`, and `undefined` becomes a connection string of `"undefined"` twenty minutes into a deploy. The fix is to read the environment once, validate it against a schema at startup, and refuse to boot if anything is missing.

## Why it exists

Three failure modes justify the whole pattern.

**Silent `undefined`.** `process.env.STRIPE_SECRET` for a variable that was never set is `undefined`, not an error. The process starts, serves health checks, passes the readiness probe, and fails on the first payment. Nothing in JavaScript stops you.

**Type confusion.** Everything in `process.env` is a string. `process.env.PORT` is `"3000"`, `process.env.ENABLE_CACHE` is `"false"` — and `"false"` is truthy. `Number(process.env.MAX_POOL)` for an unset variable is `NaN`, which propagates silently into a pool size.

**Scattered reads.** When `process.env` is read in forty files, nobody can answer "what does this service need to run?" without grepping, and no test can override a value without mutating global state.

One module, validated once, solves all three.

## The twelve-factor rule

> Store config in the environment.

Config lives in environment variables, not in files that get committed, and not in `config/production.json` selected by `NODE_ENV`. The reasons are practical:

- The same build artifact — the same container image, the same git SHA — runs in every environment. If configuration is baked into the image, staging and production are different builds and you are not testing what you ship.
- Environment variables are language-agnostic and every platform can inject them.
- Secrets never touch the repository. A committed `config/production.json` is a leaked credential with extra steps.

What belongs in the environment: anything that varies by deployment, and anything secret. What does not: application constants like a page size default or a retry count — those are code, and putting them in the environment gives you an operational lever nobody will ever pull correctly.

## Basic example

One module. It reads `process.env`, validates it, exits on failure, and exports a frozen object.

```js title="src/config.js"
import { z } from 'zod'

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),

  DATABASE_URL: z.string().min(1),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),

  REDIS_URL: z.url().optional(),

  JWT_SECRET: z.string().min(32),
  SESSION_SECRET: z.string().min(32),

  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  CORS_ORIGINS: z.string().default(''),

  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1000).default(15_000),
})

const parsed = EnvSchema.safeParse(process.env)

if (!parsed.success) {
  const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`)
  console.error(`Invalid configuration:\n${lines.join('\n')}`)
  process.exit(1)
}

const env = parsed.data

export const config = Object.freeze({
  env: env.NODE_ENV,
  isProduction: env.NODE_ENV === 'production',
  port: env.PORT,

  db: Object.freeze({
    url: env.DATABASE_URL,
    poolMax: env.DATABASE_POOL_MAX,
  }),

  redis: Object.freeze({ url: env.REDIS_URL }),

  auth: Object.freeze({
    jwtSecret: env.JWT_SECRET,
    sessionSecret: env.SESSION_SECRET,
  }),

  log: Object.freeze({ level: env.LOG_LEVEL }),

  cors: Object.freeze({
    origins: env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
  }),

  shutdownTimeoutMs: env.SHUTDOWN_TIMEOUT_MS,
})
```

Everything else imports `config`, never `process.env`:

```js title="src/server.js"
import { config } from './config.js'
import { app } from './app.js'

app.listen(config.port, (err) => {
  if (err) throw err
  console.log(`listening on ${config.port}`)
})
```

:::best-practice
Make `process.env` illegal outside `src/config.js` with a lint rule — ESLint's `no-restricted-properties` or `no-process-env`. It is the only enforcement that survives a growing team.
:::

## Fail fast

The most valuable line in that module is `process.exit(1)`.

A process that starts without `JWT_SECRET` will happily sign tokens with `undefined` and verify them the same way, meaning every token validates. A process that starts without `DATABASE_URL` passes its liveness probe and 500s on the first real request. Both are worse than not starting.

When the config module throws at import time — before the HTTP server binds a port — your orchestrator sees a crash loop, the previous version keeps serving traffic, and the rollout halts on its own. That is exactly what you want.

```text
Invalid configuration:
  DATABASE_URL: Too small: expected string to have >=1 characters
  JWT_SECRET: Too small: expected string to have >=32 characters
exit status 1
```

Two properties make that message useful: it reports **every** problem at once rather than one per restart, and it names the variable. A deployer with that output fixes it in a minute.

:::danger
Never fall back to a default for a secret. `process.env.JWT_SECRET ?? 'dev-secret'` means a deployment that forgot the variable signs production tokens with a value that is in your git history, readable by anyone with the repository. Every attacker can then mint a valid admin token. Secrets get **no defaults** — only a required schema.
:::

Non-secrets are the opposite: give them defaults so a developer can clone and run. `PORT`, `LOG_LEVEL` and timeouts should all have sensible values.

## Freeze it

`Object.freeze` at every level stops a module from mutating shared config at runtime. Without it, some middleware "temporarily" sets `config.isProduction = false` for a test, forgets to restore it, and you spend a day on a bug that only appears when two files load in a particular order.

Freezing is shallow, so freeze nested objects too — as above. In a test that genuinely needs a different value, set the environment variable before importing, or export a factory the test can call with a fixture.

## Do not branch on `NODE_ENV` deep in the code

`NODE_ENV` has exactly three legitimate uses: choosing log format, choosing whether stack traces reach the client, and telling libraries (Express included) to enable production optimisations. Beyond that it is poison.

```js title="Don't: buried in a service, three layers down"
async function chargeCustomer(customerId, amountCents) {
  if (process.env.NODE_ENV !== 'production') {
    return { id: 'fake_charge', status: 'succeeded' }   // never charges in staging
  }
  return paymentGateway.charge({ customer: customerId, amount: amountCents })
}
```

```js title="Do: src/services/billing.js"
// The behaviour is a named capability, injected at the edge.
export function createBilling({ paymentGateway }) {
  return {
    async chargeCustomer(customerId, amountCents) {
      return paymentGateway.charge({ customer: customerId, amount: amountCents })
    },
  }
}
```

The first version is untestable — the code path that runs in production is the one path your tests never execute. It also means staging does not exercise the real integration, so the first real charge happens in production. Every `NODE_ENV` branch in business logic is a code path with no test coverage by construction.

The rule: **`NODE_ENV` may be read in `config.js` and nowhere else.** If behaviour differs per environment, express it as a named config value — `config.billing.gateway`, `config.email.transport` — and choose the implementation once, at wiring time.

That also stops the classic mistake of inventing a fourth value. `NODE_ENV=staging` breaks Express's production optimisations and every library that checks `=== 'production'`. Staging runs with `NODE_ENV=production` and a different `DATABASE_URL`; use a separate `APP_ENV` if you need to *label* the environment for logs and metrics.

## Development versus production loading

```bash title="development"
node --env-file=.env src/server.js
```

`node --env-file` is built into Node 24 — no `dotenv` dependency. Use `--env-file-if-exists=.env` when the same command must work in CI, where there is no file.

Two rules that follow from how it works:

- A **real environment variable wins** over the file. That is what lets the platform override a development default.
- The file is parsed once at startup. It is not a shell: no `$VAR` expansion, no command substitution.

In production, do not ship a `.env` file. Inject real environment variables from your platform's secret store — Kubernetes Secrets mounted as env, ECS task definition secrets from Secrets Manager or SSM, Fly.io secrets, Render environment groups. The application does not change; only the injection mechanism does. See [Secrets management](../security/secrets-management.md).

```text title=".env.example (committed)"
NODE_ENV=development
PORT=3000
DATABASE_URL=postgres://app:app@localhost:5432/app
JWT_SECRET=replace-me-with-32-plus-random-characters
SESSION_SECRET=replace-me-with-32-plus-random-characters
LOG_LEVEL=debug
CORS_ORIGINS=http://localhost:5173
```

Commit `.env.example` with placeholders. Add `.env` to `.gitignore` before the first commit. The example file is also your documentation: the schema says what is required, the example says what it looks like.

## Config that varies versus secrets

They are both environment variables, but they have different handling requirements and it is worth separating them in your head.

| | Non-secret config | Secrets |
| --- | --- | --- |
| Examples | `PORT`, `LOG_LEVEL`, `CORS_ORIGINS`, pool sizes, feature flags, external URLs | `DATABASE_URL` (contains a password), `JWT_SECRET`, API keys, signing keys |
| Defaults allowed | Yes — make it runnable out of the box | **Never** |
| Safe in a Kubernetes ConfigMap / plain task definition | Yes | No — use a Secret or a secret store reference |
| Safe to log at startup | Yes, and you should | No — redact |
| Rotation | Rarely | Regularly, and without a redeploy where possible |
| Visible in `docker inspect`, `ps`, crash dumps | Acceptable | Assume it is, and treat build args and image layers as public |

Logging the resolved non-secret config at boot is genuinely useful — it settles "which config is this pod running" instantly. Build the safe view explicitly rather than filtering by key name, because a deny-list will miss the next secret someone adds.

```js title="src/config.js — continued"
export function describeConfig() {
  return {
    env: config.env,
    port: config.port,
    logLevel: config.log.level,
    dbPoolMax: config.db.poolMax,
    corsOrigins: config.cors.origins,
    redisConfigured: Boolean(config.redis.url),
    shutdownTimeoutMs: config.shutdownTimeoutMs,
  }
}
```

An allow-list cannot leak a secret added next month. A `redactKeys` list can.

## Feature flags

A feature flag is config with a shorter lifetime. Two kinds, with different mechanisms:

**Deploy-time flags** — a boolean in the environment, flipped by a redeploy. Right for a feature that is either on or off for everyone, and for a kill switch.

```js title="src/config.js — flags"
// Parse booleans explicitly. Anything unrecognised is a config error, not a false.
const boolFromEnv = (defaultValue) =>
  z
    .enum(['true', 'false', '1', '0'])
    .default(defaultValue ? 'true' : 'false')
    .transform((v) => v === 'true' || v === '1')

const FlagSchema = z.object({
  FEATURE_NEW_CHECKOUT: boolFromEnv(false),
  FEATURE_ASYNC_EXPORTS: boolFromEnv(false),
})
```

:::warning
Parsing booleans from strings is the trap: `Boolean("false")` is `true`, and so is `Boolean("0")`. The schema above rejects anything outside the four values it knows, so `FEATURE_NEW_CHECKOUT=no` fails at boot instead of silently enabling the feature.
:::

**Runtime flags** — evaluated per request from a flag service or a database row, so you can enable a feature for 5% of users without a deploy. Worth it for gradual rollouts and A/B tests; overkill for a kill switch.

Rules for either:

- Evaluate the flag **once, at the edge**, and pass the decision down. A flag read in a repository method is the `NODE_ENV` mistake wearing a different hat.
- Default to **off**. An unset flag must not enable an unfinished feature.
- Give every flag a removal date. Flags that outlive their rollout become permanent untested branches — the number of code paths doubles with each one.
- Emit the flag state as a log field and a metric label, so you can tell which cohort a request was in when it failed.

## Security considerations

- **No secrets in the repository.** `.gitignore` `.env` before the first commit. If a secret is ever committed, rotate it — removing the file does not remove it from history, and history is what a scraper reads.
- **No secrets in build args or image layers.** `ARG SECRET` is recorded in the image's build history and readable with `docker history`. See [Dockerfile](dockerfile.md).
- **No secrets in URLs or log lines.** `DATABASE_URL` contains a password; logging the whole config object puts it in your log aggregator, where far more people have access than to the secret store. Configure pino's `redact` as a second line of defence — see [Logging without leaking PII](../security/logging-without-leaking-pii.md).
- **Minimum lengths on signing secrets.** `z.string().min(32)` will not stop a weak-but-long value, but it stops `JWT_SECRET=secret`, which is the one that actually happens.
- **Rotate on a schedule and on exposure.** Design for it: support two valid signing keys at once so rotation does not invalidate every session. See [JWT pitfalls](../security/jwt-pitfalls.md).
- **Scope credentials per environment.** Staging must never hold a credential that works against production data. The point of separate environments is destroyed by a shared password.
- **Do not echo config back over HTTP.** A `/debug/config` endpoint is a credential dump; a `/health` endpoint that reports the database URL is the same thing with better branding. See [Health and readiness probes](health-and-readiness-probes.md).

## Production considerations

- **Validate before you bind a port.** Import `config.js` at the very top of your entry point. Failing at import time means the process never becomes a target for traffic.
- **Let the crash loop stop the rollout.** With a rolling deployment, a config-invalid pod never becomes ready, the rollout stalls, and the old version keeps serving. That is the correct behaviour — do not add a retry loop around config parsing.
- **Log the safe config view once at boot,** with the git SHA and the resolved Node version. It answers "what is actually running" without an exec into the container.
- **Treat config changes as deployments.** They carry the same risk. Change one variable at a time, and be able to roll it back the same way you roll back code.
- **Keep the schema and the platform in sync.** Adding a required variable without adding it to every environment turns the next deploy into an outage. Add it as optional with a default first, deploy, set it everywhere, then tighten the schema.
- **Size pool limits against the database, not the app.** `DATABASE_POOL_MAX` is per process; with `n` replicas the database sees `n × poolMax` connections. See [Connection pooling](../databases/connection-pooling.md).
- **Restrict who can read the environment.** Anyone with `exec` into the container can run `env`. That is the same trust level as the secret store.

## Common mistakes

- **Reading `process.env` outside `config.js`.** Typos become `undefined`, tests cannot override values, and nobody can enumerate what the service needs.
- **Defaulting a secret.** `?? 'dev-secret'` in production means every attacker can forge a token, because the fallback is in your repository.
- **Trusting `Boolean(process.env.FLAG)`.** `"false"` is truthy. So is `"0"`, `"no"` and `"off"`.
- **`Number(process.env.PORT)` with no validation.** Unset gives `NaN`; a typo gives `NaN`; `NaN` as a port makes Node listen on a random one.
- **Branching on `NODE_ENV` in business logic.** The production path is the one your tests never run.
- **Inventing `NODE_ENV=staging`.** It disables production optimisations in Express and misleads every library that compares against `'production'`. Use `APP_ENV` for the label.
- **Shipping a `.env` file in the image.** It bakes a secret into a layer and makes the image environment-specific, defeating build-once-deploy-everywhere.
- **Config objects that are not frozen.** Mutation at runtime produces bugs that depend on module load order.
- **Logging the whole config at startup.** It puts `DATABASE_URL`, password and all, into your log store.
- **Validating config lazily on first use.** The point is to fail before traffic arrives, not on the first request that happens to need the value.

## Related topics

- [Environment variables and config](../node/environment-variables-and-config.md) — `--env-file` semantics in detail.
- [Secrets management](../security/secrets-management.md) — where secrets live when `.env` is not acceptable.
- [Validation](../express-libraries/validation.md) — the same Zod 4 patterns applied to request bodies.
- [Dockerfile](dockerfile.md) — keeping secrets out of build args and image layers.
- [Continuous integration](ci.md) — providing config to test jobs without committing it.
- [Graceful shutdown](graceful-shutdown.md) — consumes `config.shutdownTimeoutMs`.
- [Observability](observability.md) — logging the safe config view and flag state.
- [Connection pooling](../databases/connection-pooling.md) — why `DATABASE_POOL_MAX` is a database-side decision.
- [Logging without leaking PII](../security/logging-without-leaking-pii.md) — redaction as the second line of defence.
- [Deployment checklist](deployment-checklist.md) — the config items to verify before shipping.
