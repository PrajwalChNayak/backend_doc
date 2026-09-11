---
title: Docker
description: A multi-stage Dockerfile for a Nest 12 app on Node 24 — pinned base image, the Alpine/musl native-module tradeoff, npm ci --omit=dev, non-root, an init at PID 1, and the package.json that ESM builds need.
status: current
updated: 2026-09-11
---

A Nest image has one more stage than an Express image, because the artifact you ship — `dist/` — has to be produced by a toolchain you must not ship. Everything else is the same set of six decisions, and the two that matter most are still PID 1 and the `.dockerignore`. The general reasoning for each is in [Dockerfile](../production/dockerfile.md); this page is the Nest-specific version of the file, plus the three ways a Nest image fails that an Express image does not.

## The Dockerfile

```dockerfile title="Dockerfile"
# syntax=docker/dockerfile:1

# ---------- Stage 1: production dependencies ----------
# Pin the major AND the variant. In CI, pin the digest as well.
FROM node:24.20.0-bookworm-slim AS deps
WORKDIR /app

# Manifests only, so this layer stays cached until they change.
COPY package.json package-lock.json ./

# Exactly the lockfile, production dependencies only. This tree is what ships.
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev

# ---------- Stage 2: build ----------
# Needs devDependencies: @nestjs/cli, @nestjs/schematics, typescript.
FROM node:24.20.0-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci

# tsconfig*.json and nest-cli.json decide what `nest build` emits and which
# non-TypeScript assets are copied into dist/. Copy them before src/.
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src

# `npm run build` is `nest build`: tsc against tsconfig.build.json -> dist/.
RUN npm run build

# ---------- Stage 3: runtime ----------
FROM node:24.20.0-bookworm-slim AS runtime

# Rarely-changing layer first.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    NPM_CONFIG_UPDATE_NOTIFIER=false

WORKDIR /app

# The official images already ship an unprivileged `node` user (uid 1000).
# --chown on the COPY avoids a second full-size layer.
COPY --from=deps  --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist        ./dist

# Not optional. See "package.json is part of the artifact" below.
COPY --chown=node:node package.json ./

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/livez').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# tini is PID 1 and forwards signals; node is its direct child.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "--enable-source-maps", "dist/main.js"]
```

`--start-period=30s` is larger than you would use for a bare Express app on purpose: `NestFactory.create()` builds the whole module graph, runs every `onModuleInit`, and opens every pool **before** anything listens. On a large application that is seconds, and a health check that starts probing immediately marks a normally-starting container unhealthy.

## The `.dockerignore`

Write it **before** the Dockerfile. Without it, `COPY` sends your entire working directory to the daemon — a `node_modules` built for your laptop's architecture, your `.git` history, and your `.env`.

```text title=".dockerignore"
# Never ship a host-built node_modules: wrong platform, wrong native builds.
node_modules
**/node_modules

# Secrets. The single most important block in this file.
.env
.env.*
!.env.example
*.pem
*.key
id_rsa*

# Version control and CI
.git
.gitignore
.github

# Build output and caches — dist/ is produced inside the image, never copied in.
dist
coverage
.nyc_output
*.tsbuildinfo
.npm
.cache
.eslintcache

# Tests: they are excluded by tsconfig.build.json anyway, and they pull
# fixtures and snapshots into the build context for no reason.
test
**/*.spec.ts
**/*.e2e-spec.ts

# Local and editor noise
.vscode
.idea
*.log
npm-debug.log*
.DS_Store

# Not needed in the image
docs
examples
README.md
Dockerfile*
docker-compose*.yml
```

:::danger
`dist` in `.dockerignore` is deliberate. If a stale `dist/` from your laptop is copied into the build context, an accidental `COPY . .` can ship a build nobody made from the committed source — different compiler version, different `tsconfig`, possibly different code. The image must compile from `src/` every time.

The `.env` lines are the ones that matter most. A missing `.dockerignore` is how a `.env` ends up inside a published image; the layer is immutable, `docker history` plus a filesystem extract retrieves it, and deleting the file in a later `RUN` does not remove it from the earlier layer. If a secret has ever been in a layer, rotate it.
:::

## Three ways a Nest image fails that an Express image does not

### 1. `package.json` is part of the artifact

Copying only `dist/` and `node_modules/` produces an image that boots — until it does not, for two separate reasons:

- **ESM projects break immediately.** `"type": "module"` lives in `package.json`. Without that file, Node treats every `.js` in `dist/` as CommonJS and the first `import` statement throws `Cannot use import statement outside a module`.
- **`imports` subpath mappings stop resolving.** If you replaced `tsconfig` path aliases with Node subpath imports — the recommendation in [ESM vs CommonJS in production](module-format-in-production.md) — the map is in `package.json` too.

Copy it. It is a few hundred bytes and it is not optional.

### 2. Assets are not compiled, so they are not copied

`tsc` emits only what it compiles. Handlebars templates, `.graphql` documents, `.proto` files, `.sql` seeds and JSON fixtures are invisible to it and will simply not be in `dist/`.

```json title="nest-cli.json"
{
  "$schema": "https://json.schemastore.org/nest-cli",
  "collection": "@nestjs/schematics",
  "sourceRoot": "src",
  "compilerOptions": {
    "deleteOutDir": true,
    "assets": [{ "include": "mail/templates/**/*.hbs" }],
    "includeLibraryAssets": true
  }
}
```

The bug is invisible in development, because `nest start` runs with the repository on disk beside it. It appears the first time that template is rendered in production. See [Build and deployment](build-and-deployment.md).

### 3. A runtime dependency filed under `devDependencies`

`npm ci --omit=dev` fails at container **start**, not at build time, with `Cannot find module '@nestjs/config'` — after the image passed every test.

Genuine runtime dependencies that people misfile in a Nest project:

| Package | Why it is runtime |
| --- | --- |
| `reflect-metadata` | DI reads the emitted decorator metadata at construction time |
| `rxjs` | interceptors, `HttpService`, microservice transports |
| `class-validator` / `class-transformer` | required by a globally registered `ValidationPipe` |
| `@nestjs/microservices`, `@nestjs/websockets` | loaded lazily by `@nestjs/core` when you use them, so a static analysis will not catch the omission |

:::warning
Boot the built image in CI before pushing it. It costs about twenty seconds and it catches all three failures above — the only three that exist purely in the artifact.

```bash
docker build -t api:test .
docker run -d --name smoke -p 3000:3000 -e DATABASE_URL=... api:test
curl -fsS localhost:3000/livez
docker stop smoke        # should return in ~1s, proving SIGTERM reaches node
```
:::

## PID 1, and why it makes your shutdown hooks dead code

This is the mistake with the largest blast radius, because it silently disables the work you did in [Graceful shutdown](graceful-shutdown.md).

PID 1 is special: the kernel does not apply default signal handlers to it, so a process at PID 1 with no explicit `SIGTERM` handler **ignores** the signal. `docker stop` and every orchestrator send `SIGTERM` to PID 1 only.

| Command | Signals reach Nest | Zombies reaped | Verdict |
| --- | --- | --- | --- |
| `CMD npm start` (shell form) | **no** — `sh` is PID 1 and does not forward | no | the common broken case |
| `CMD ["npm", "run", "start:prod"]` | unreliable | no | npm is not a supervisor |
| `CMD ["npx", "nest", "start"]` | **no** — the CLI is PID 1 and node is its child | no | also ships the CLI |
| `CMD ["node", "dist/main.js"]` | yes, because `enableShutdownHooks()` registers handlers | no | fine if you spawn nothing |
| `ENTRYPOINT ["/usr/bin/tini", "--"]` | yes | yes | recommended |
| `docker run --init` | yes | yes | same effect from the runtime; not offered by every platform |

:::danger
**Never run `nest start` in a production container.** The CLI compiles and then spawns your application as a child process — so the CLI is PID 1, `SIGTERM` goes to the CLI, and `app.close()` is never called. Your `onApplicationShutdown` hooks never run, the pool never closes cleanly, and every deploy drops its in-flight requests with no log line explaining why. It also means shipping `@nestjs/cli` and `typescript` in the runtime image.

`node dist/main.js`, behind an init. Nothing else.
:::

Verify it rather than assuming:

```bash
docker run -d --name t api:test
docker stop t          # ~10s means SIGTERM is not reaching node
docker logs t | tail   # your shutdown log lines should be here
```

Ten seconds is the tell: that is `docker stop`'s default timeout before it escalates to `SIGKILL`.

## Pin the base image

`FROM node:latest` means today's rebuild may run a different major of Node than yesterday's.

| Pin | Reproducible | Gets patches | Use for |
| --- | --- | --- | --- |
| `node:latest` | no | plus majors you did not ask for | never |
| `node:24` | no | on rebuild | local experiments |
| `node:24-bookworm-slim` | no | on rebuild | reasonable default |
| `node:24.20.0-bookworm-slim` | mostly | when you bump it | production |
| `node:24-bookworm-slim@sha256:…` | exactly | when you bump it | production with an update bot |

Node 24 is the Active LTS line and satisfies both Nest floors — running a Nest 12 app needs v20.19+/v22.12+/v26+, and the CLI needs v22.22.3+/v24.15+/v26+ because `@nestjs/schematics@12` declares `>=22.12.0`. Since the build stage runs the CLI, **the build stage is the one with the higher floor**. Both stages use the same image here, which is the simplest way to never think about it again.

Digest pinning is the strongest guarantee and its cost is that you stop receiving base-image security patches until something updates the digest — pair it with Dependabot or Renovate. Substitute a real digest from `docker pull`; never copy a placeholder.

### Alpine or Debian slim?

| | `node:24-alpine` | `node:24-bookworm-slim` |
| --- | --- | --- |
| C library | musl | glibc |
| Base size | smallest | larger, still small |
| Prebuilt native binaries | often unavailable for musl | almost always available |
| Native module builds | frequently compile from source | usually download a prebuild |
| Surprises | occasional and hard to diagnose | rare |

The tradeoff is **native modules**, and a Nest application accumulates them quickly: `argon2` 0.45.1 for password hashing, `better-sqlite3` 13.0.3 for a local database, `bcrypt` 6.0.0, `sharp` for images. Each ships prebuilt binaries for glibc on x64 and arm64. On musl the prebuild often does not exist, so `npm ci` falls back to compiling — which needs a toolchain in the builder, adds minutes to every build, and can fail on a version bump with an error about a missing header.

```dockerfile title="Alpine + native modules: the deps stage needs a toolchain"
FROM node:24-alpine AS deps
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
```

Because `node_modules` is copied out of `deps` into the runtime stage, the toolchain stays behind — but the build cost and the fragility remain.

:::best-practice
Start with `node:24-bookworm-slim`. It is a few tens of megabytes larger and it removes an entire class of build failures. Move to Alpine only if image size is a *measured* constraint and you have verified every native dependency has a musl prebuild or compiles cleanly.

If you do use Alpine, run your e2e suite **inside the image**. A native module that compiled against different assumptions fails at runtime, not at build time.
:::

## Layer caching

Docker invalidates every layer after the first change, so copy what changes rarely before what changes constantly.

```dockerfile title="Do: manifests, then config, then source"
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
RUN npm run build
```

```dockerfile title="Don't: everything at once"
COPY . .
RUN npm ci && npm run build
```

In the first, editing a controller leaves both install layers cached and the build takes seconds. In the second, every source edit re-runs a full `npm ci` — twice, since the two stages each have one.

The BuildKit cache mount in the Dockerfile above (`--mount=type=cache,target=/root/.npm`) goes further: even a dependency change reuses already-downloaded tarballs instead of refetching the tree.

## Non-root, and the platform enforcing it

By default a container's process is **root** — uid 0, and if it escapes the namespace, root on your node. Every container runtime has had escape CVEs.

```dockerfile
COPY --chown=node:node /app/dist ./dist
USER node
```

Details that matter:

- **`USER node` goes after everything that needs to write.** Installing as root then dropping is fine; dropping first fails on permissions.
- **`--chown` on the `COPY`, never a separate `RUN chown -R`.** A recursive chown creates a second layer containing a copy of every file.
- **Ports below 1024 need privileges.** Listen on 3000 and let the platform map it.
- **Enforce it at the platform too.** `securityContext: { runAsNonRoot: true, runAsUser: 1000, readOnlyRootFilesystem: true }` means a Dockerfile that forgets `USER` fails to schedule instead of silently running as root.

A read-only root filesystem works for most Nest services, because a well-behaved one writes nothing to disk — logs go to stdout, uploads go to object storage. If something does need to write, mount a `tmpfs` for that path rather than giving up the setting.

## Memory limits and the heap

Node sizes its heap from what it can detect, and under a container limit it may not detect it correctly. Set `--max-old-space-size` to roughly 75% of the container's memory limit so V8 grows into headroom and garbage-collects rather than meeting the OOM killer:

```yaml title="deployment.yaml"
resources:
  requests: { cpu: "250m", memory: "512Mi" }
  limits:   { cpu: "1",    memory: "1Gi" }
env:
  - name: NODE_OPTIONS
    value: "--max-old-space-size=768"
```

An OOM kill gives you no Node-level error and no stack trace — the process simply disappears, and the pod shows `OOMKilled`. That is the one failure mode your exception filters cannot help with.

## Security considerations

- **No secrets in `ARG` or `ENV`.** Build args are stored in the image history and readable with `docker history --no-trunc`; `ENV SECRET=…` is worse, because it is visible in `docker inspect` and in every process's environment. When a build genuinely needs a credential — a private registry token for a scoped `@nestjs`-adjacent package — use a BuildKit secret mount, which never reaches a layer:

  ```dockerfile
  RUN --mount=type=secret,id=npmrc,target=/root/.npmrc npm ci --omit=dev
  ```

  ```bash
  docker build --secret id=npmrc,src=$HOME/.npmrc .
  ```

- **Layers are immutable.** `COPY .env . && RUN rm .env` leaves the file in the earlier layer. Deletion does not delete.
- **Configuration is injected, never baked.** One image digest runs in every environment; see [Environment configuration](configuration.md).
- **Drop capabilities.** `--cap-drop=ALL` and `--security-opt=no-new-privileges`. A Nest API needs none of them.
- **Scan the image in CI** — `docker scout`, Trivy or Grype — and rebuild on a schedule. Most findings will be in the base OS, which is an argument for slim images and regular rebuilds.
- **`--omit=dev` shrinks the attack surface, not just the image.** A TypeScript compiler inside a running container is a useful primitive for anyone who gets a shell.
- **Never `COPY` the `.git` directory.** History contains every secret ever committed, including ones removed from the working tree.
- **Verify what shipped:** `docker run --rm --entrypoint sh api:test -c 'ls -la /app'` and `docker history --no-trunc api:test`. Look for a `.env` before someone else does.

## Image size

In rough order of impact:

1. **Multi-stage.** `@nestjs/cli`, `@nestjs/schematics`, `typescript` and the test runner never reach the final image. This is most of the win.
2. **`npm ci --omit=dev`.** Frequently hundreds of megabytes, and most of your vulnerability report.
3. **A real `.dockerignore`.** Stops `.git` and a host `node_modules` entering the build context at all.
4. **`--no-install-recommends` and clearing apt lists in the same `RUN`.**
5. **Slim or Alpine base.** Real, but smaller than the above, and Alpine carries the native-module cost.

Size is worth chasing for pull time during a scale-up and for CVE surface, not for its own sake. A 250 MB image that builds reliably beats a 110 MB image that fails on every `argon2` bump.

:::note
Bundling with `nest build --webpack` (or `--rspackPath`) can shrink `node_modules` dramatically by inlining only the code you import. It also introduces the failure mode described in [ESM vs CommonJS in production](module-format-in-production.md): `@nestjs/core` loads transport and platform packages lazily, and a bundler that cannot see those dynamic requires drops them. If you bundle, boot the image in CI — that check stops being optional.
:::

## Common mistakes

- **`nest start` or `npm run start:prod` as the container command.** `SIGTERM` never reaches Nest, shutdown hooks never run, and you shipped the CLI.
- **`CMD npm start` in shell form.** `sh` is PID 1 and forwards nothing.
- **Not copying `package.json` into the runtime stage.** An ESM build throws on its first `import`; subpath imports stop resolving.
- **Forgetting `compilerOptions.assets`.** Templates and `.graphql` files are absent from `dist/`. Works in dev, 500s in the image.
- **`reflect-metadata` or `rxjs` in `devDependencies`.** `--omit=dev` produces a container that cannot boot, and only at runtime.
- **No `.dockerignore`.** `.env`, `.git` and a host-built `node_modules` all enter the build context.
- **`npm install` instead of `npm ci`.** The image contains a dependency tree that is not in your lockfile.
- **`COPY . .` before `npm ci`.** Every source edit reinstalls everything, twice.
- **Running as root.** A container escape becomes a host compromise, and the platform will not stop you.
- **`RUN chown -R` after copying.** A duplicate of every file, in a new layer.
- **A secret in `ARG` or `ENV`.** Permanently readable in the image history.
- **`FROM node:latest`.** Unreproducible, and one day it is a new major that the CLI or the runtime rejects.
- **Alpine without checking native modules.** `argon2` and `better-sqlite3` compile from source on musl, or fail.
- **A `HEALTHCHECK` `--start-period` sized for an Express app.** A Nest boot is longer; the container is marked unhealthy while starting normally.
- **A `HEALTHCHECK` that queries the database.** Same failure mode as a liveness probe that does.
- **Expecting Kubernetes to use `HEALTHCHECK`.** It ignores it entirely and uses its own probes.
- **No memory-limit awareness.** V8 grows past the limit, the OOM killer takes the process, and there is no Node-level error.
- **Building on an arm64 laptop and deploying to amd64.** Silent emulation, or a container that will not start. Build multi-arch, or build in CI.

## Related topics

- [Dockerfile](../production/dockerfile.md) — the general reasoning behind each instruction, distroless, and image-size detail.
- [Build and deployment](build-and-deployment.md) — what `nest build` produces and why the CLI stays in the builder.
- [Graceful shutdown](graceful-shutdown.md) — the hooks that only run if PID 1 is right.
- [ESM vs CommonJS in production](module-format-in-production.md) — `"type": "module"` and bundled builds in an image.
- [Environment configuration](configuration.md) — injecting config instead of baking it in.
- [Continuous integration](ci.md) — building, scanning and smoke-booting the image.
- [Clustering](clustering.md) — one process per container, and CPU limits.
- [Performance](performance.md) — heap sizing under a container memory limit.
- [Health and readiness probes](health-and-readiness-probes.md) — what `HEALTHCHECK` should point at.
- [Secrets management](../security/secrets-management.md) — where credentials live instead of a layer.
- [Dependency auditing](../nestjs-security/dependency-auditing.md) — scanning what `--omit=dev` leaves behind.
- [Deployment checklist](deployment-checklist.md) — the container items to verify before shipping.
