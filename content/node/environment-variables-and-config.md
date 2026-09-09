---
title: Environment variables and config
description: Loading .env files with node --env-file instead of dotenv, and validating configuration with Zod 4 so a misconfigured process fails at boot.
status: current
updated: 2026-09-08
---

Configuration comes from the environment, not from files committed to the repository — that is what lets the same artifact run in development, staging and production. Node 24 can load a `.env` file itself, so the interesting work is no longer *loading* config but *validating* it, at startup, before anything can fail confusingly at 3 a.m.

## Loading a .env file without a package

```bash
node --env-file=.env src/server.js
```

`--env-file` reads the file and populates `process.env` before your code runs. Two variants matter:

| Flag | Missing file |
| --- | --- |
| `--env-file=.env` | the process **exits with an error** |
| `--env-file-if-exists=.env` | silently continues |

Use the strict form where the file is mandatory, and the tolerant form in scripts that must also work in an environment where variables come from the platform instead:

```json title="package.json"
{
  "scripts": {
    "dev": "node --watch --env-file-if-exists=.env src/server.js",
    "start": "node src/server.js",
    "test": "node --env-file=.env.test --test"
  }
}
```

Note that `start` has no `--env-file` at all. In production the orchestrator — Kubernetes, ECS, systemd, your PaaS — injects real environment variables, and there is no file to read.

You can pass the flag more than once to layer files (`--env-file=.env --env-file=.env.local`); values from the later file are applied after the earlier one.

### The file format

```env title=".env"
PORT=3000
DATABASE_URL=postgres://app:secret@localhost:5432/app
LOG_LEVEL=debug
GREETING="hello world"
PRIVATE_KEY="-----BEGIN KEY-----
multiple lines inside quotes
-----END KEY-----"
```

A line starting with `#` is a comment. Node's parser handles comments, quoted values and quoted multi-line values. It does **not** do variable expansion — `URL=${HOST}/api` stays literally `${HOST}/api`.

### Loading from inside the process

If you cannot control the command line — a bundled runtime, a serverless handler, a test harness that spawns Node for you — load it programmatically:

```js title="src/config.js"
process.loadEnvFile('.env')          // throws if the file is missing
```

`util.parseEnv(contents)` parses the same format into a plain object without touching `process.env`, which is handy when you want to inspect or merge before applying.

### When you still need `dotenv`

`dotenv` 17.4.2 is not obsolete. Keep it when:

- You need **variable expansion** (`${DATABASE_HOST}`), which Node's parser does not implement.
- You are running inside a bundler or a runtime that owns the process entry point and gives you no place to add a Node CLI flag.
- You need dotenv-specific behavior your team already depends on, such as its encrypted-vault workflow.

Otherwise drop the dependency. One fewer package in the tree is one fewer supply-chain surface, and `--env-file` runs before any of your code, so there is no "config read before dotenv loaded" ordering bug to have.

:::deprecated
You no longer need `dotenv-cli` or `cross-env` in npm scripts on Node 24. `--env-file` replaces the first; putting variables in the env file replaces the second, and it works identically on Windows.
:::

## Validate at boot, then never touch `process.env` again

Every environment variable is a string, may be missing, and may be nonsense. A service that reads `process.env.PORT` in twelve places has twelve chances to get that wrong. Parse once, at startup, into a frozen object.

```js title="src/config.js"
import { z } from 'zod'

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.url(),
  REDIS_URL: z.url().optional(),
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  UPSTREAM_TIMEOUT_MS: z.coerce.number().int().positive().default(2000),
  ENABLE_SIGNUPS: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
})

const parsed = EnvSchema.safeParse(process.env)

if (!parsed.success) {
  const problems = parsed.error.issues.map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
  console.error(`Invalid configuration:\n${problems.join('\n')}`)
  process.exit(1)
}

export const config = Object.freeze(parsed.data)
export const isProduction = config.NODE_ENV === 'production'
```

```js title="src/server.js"
import { config } from '#config'

server.listen(config.PORT, () => console.log(`listening on ${config.PORT}`))
```

What this buys you:

- **`z.coerce.number()`** turns the string `"3000"` into the number `3000`. Without coercion, `PORT` is `"3000"` and any arithmetic on it silently produces string concatenation.
- **Fail fast.** A missing `SESSION_SECRET` kills the process during deploy, when the rollback is one command, instead of at the first login attempt.
- **One shape.** `config` is a plain object with known keys and real types, so editors and `tsc` can check it.
- **Frozen.** Nothing can mutate config at runtime, so behavior cannot drift between requests.

:::best-practice
Import `config`, never `process.env`, everywhere except that one file. Enforce it with an ESLint rule if you can — the first time someone adds `process.env.FEATURE_X` deep in a service, you lose the boot-time guarantee for that variable.
:::

:::warning
Do not give secrets a `.default()`. A default `SESSION_SECRET` means a misconfigured production deploy boots happily with a signing key that is also in your public repository. Required means required.
:::

### `NODE_ENV`

`NODE_ENV` is a plain environment variable, but a lot of code reads it. Express uses it to decide whether to cache views and whether the default error handler includes a stack trace, and many libraries switch off development-only checks when it is `production`.

Keep it to exactly three values — `development`, `test`, `production` — and use separate variables for deployment stages. `NODE_ENV=staging` disables production optimizations in libraries that only compare against the literal string; model staging as `NODE_ENV=production` plus `APP_ENV=staging`.

## Security considerations

:::danger
**Never commit `.env`.** A repository with a live `DATABASE_URL` or API key in its history is compromised from the moment it is pushed, and deleting the file later does not remove it from the git history. Secret scanners crawl public repositories within minutes.
:::

```text title=".gitignore"
.env
.env.*
!.env.example
```

Commit a `.env.example` with the **keys and no values**, so a new developer knows what to fill in:

```env title=".env.example"
PORT=3000
DATABASE_URL=
SESSION_SECRET=
LOG_LEVEL=debug
```

Other rules that matter:

- **Do not log the config object.** `console.log(config)` at boot prints your database password into the log aggregator, where it is retained and searchable. Log a redacted subset, or just the keys.
- **Do not put secrets in the Docker image.** A `.env` copied in at build time lives in a layer that anyone who can pull the image can read. Inject at runtime.
- **Do not pass secrets as command-line arguments.** Any user on the host can read them from `ps`.
- **Environment variables are visible to child processes** and appear in crash dumps and `/proc/<pid>/environ`. They are the right default for a service, not a strong secret store — for high-value key material, fetch from a secrets manager at boot and keep it in memory.

Full treatment in [Secrets management](../security/secrets-management.md).

## Common patterns

### Config that is not a secret

Feature flags, timeouts and limits are fine as ordinary environment variables. Put them through the same schema so they get types and defaults, and so a typo in a flag name is caught at boot rather than being read as `undefined` — which is falsy, so the feature just silently stays off.

### Per-environment files

```text
.env.example      committed, keys only
.env              local development, ignored
.env.test         committed only if it contains no secrets
```

Point tests at their own file so a test run can never talk to the development database:

```bash
node --env-file=.env.test --test
```

### Checking config in CI

Because the schema lives in code, you can validate a deployment's environment before rolling it out:

```bash
node --env-file=.env.staging -e "import('./src/config.js')"
```

A non-zero exit means the environment is incomplete. That check takes a second and turns a failed deploy into a failed pipeline step.

## Common mistakes

- **Committing `.env`.** Assume any secret pushed to a repository is burned; rotate it.
- **Reading `process.env` throughout the codebase.** Every read is an unvalidated `string | undefined`.
- **Forgetting that env vars are strings.** `process.env.PORT + 1` gives `"30001"`. Coerce in the schema.
- **Defaulting a secret.** A production deploy that boots with a placeholder signing key is worse than one that crashes.
- **`NODE_ENV=staging`.** Libraries compare against `'production'` literally; you lose the optimizations you wanted.
- **Installing `dotenv` reflexively.** `--env-file` is built in; keep the package only for expansion or bundled runtimes.
- **Shipping `--env-file=.env` in the production start command.** Production has no file — the process exits at startup. Use real environment variables there.
- **Logging the config object at boot.** Passwords into the log pipeline, permanently.
- **Baking `.env` into a Docker image.** It stays in the layer, readable by anyone with the image.

## Related topics

- [package.json and npm scripts](./package-json-and-npm-scripts.md) — where the `--env-file` flags live.
- [Error handling](./error-handling.md) — failing fast and exiting with a useful code.
- [Native TypeScript support](./native-typescript-support.md) — typing the config object without a build step.
- [Secrets management](../security/secrets-management.md) — rotation, secret managers, and what to do after a leak.
- [Configuration](../production/configuration.md) — the deployment side of the same problem.
- [Validation](../express-libraries/validation.md) — the same Zod 4 schemas applied to request input.
- [Dockerfile](../production/dockerfile.md) — injecting configuration at runtime rather than build time.
