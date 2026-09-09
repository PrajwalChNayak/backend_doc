---
title: Dockerfile
description: A multi-stage Dockerfile for Node 24 — pinned base image, npm ci, layer caching, non-root user, correct PID 1 signal handling, and no secrets in any layer.
status: current
updated: 2026-09-08
---

A Node Dockerfile is about six instructions long and almost everyone gets at least two of them wrong. The consequences are not cosmetic: the wrong `CMD` means `SIGTERM` never reaches your process and every deploy drops requests; a secret in a build arg is permanently readable in the image; running as root turns a container escape into a host compromise.

## The complete Dockerfile

```dockerfile title="Dockerfile"
# syntax=docker/dockerfile:1

# ---------- Stage 1: dependencies ----------
# Pin the major AND the variant. In CI, pin the digest as well.
FROM node:24-bookworm-slim AS deps
WORKDIR /app

# Copy only the manifests first, so this layer is cached until they change.
COPY package.json package-lock.json ./

# npm ci installs exactly the lockfile. --omit=dev drops devDependencies.
RUN npm ci --omit=dev

# ---------- Stage 2: build ----------
# Only needed if you have a build step (TypeScript, bundling, asset generation).
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# ---------- Stage 3: runtime ----------
FROM node:24-bookworm-slim AS runtime

# Libraries change rarely; do this before copying app code.
RUN apt-get update \
 && apt-get install -y --no-install-recommends dumb-init \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    NPM_CONFIG_UPDATE_NOTIFIER=false

WORKDIR /app

# The node images already contain an unprivileged `node` user (uid 1000).
# --chown avoids a second layer that duplicates every file.
COPY --from=deps  --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/livez').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# dumb-init is PID 1 and forwards signals. node is the direct child.
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/server.js"]
```

If you have no build step, delete stage 2 and copy `src/` in stage 3 instead of `dist/`.

## The `.dockerignore`

Write this **before** the Dockerfile. Without it, `COPY . .` sends your entire working directory to the daemon — including `node_modules` built for your laptop's architecture, your `.git` history, and your `.env`.

```text title=".dockerignore"
# Never ship a host-built node_modules: wrong platform, wrong native builds.
node_modules
**/node_modules

# Secrets. The single most important line in this file.
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

# Build output and caches
dist
build
coverage
.nyc_output
*.tsbuildinfo
.npm
.cache

# Local and editor noise
.vscode
.idea
*.log
npm-debug.log*
.DS_Store

# Not needed at runtime
test
tests
**/*.test.js
**/*.spec.js
docs
examples
README.md
Dockerfile*
docker-compose*.yml
```

:::danger
A missing `.dockerignore` is how a `.env` ends up inside a published image. `COPY . .` copies it, the layer is immutable, and `docker history` plus a filesystem extract retrieves it — deleting the file in a later `RUN` does not remove it from the earlier layer.

If a secret has ever been in a layer, it is compromised. Rotate it; do not rebuild and hope.
:::

## Pin the base image

`FROM node:latest` means your build is not reproducible and today's rebuild may run a different major of Node than yesterday's. `FROM node:24` is better but still floats across patch releases.

| Pin | Reproducible | Gets security patches | Use for |
| --- | --- | --- | --- |
| `node:latest` | No | Yes, and major upgrades you did not ask for | Never |
| `node:24` | No | Yes, on rebuild | Local experiments |
| `node:24-bookworm-slim` | No | Yes, on rebuild | Reasonable default |
| `node:24.20.0-bookworm-slim` | Mostly | Only when you bump it | Production |
| `node:24-bookworm-slim@sha256:…` | Exactly | Only when you bump it | Production with a bot that bumps it |

Digest pinning is the strongest guarantee: the same digest is byte-identical forever. Its cost is that you stop receiving base-image security patches until something updates the digest, so pair it with Dependabot or Renovate. Substitute the real digest from `docker pull` output — do not copy a placeholder.

### Alpine or Debian slim?

| | `node:24-alpine` | `node:24-bookworm-slim` |
| --- | --- | --- |
| C library | musl | glibc |
| Base size | Smallest | Larger, still small |
| Prebuilt native binaries | Often unavailable for musl | Almost always available |
| Native module builds | Frequently compile from source | Usually download a prebuild |
| DNS resolution behaviour | musl differs from glibc in some setups | Standard |
| Surprises | Occasional and hard to diagnose | Rare |

The tradeoff is **native modules**. `argon2`, `better-sqlite3`, `bcrypt` and `sharp` ship prebuilt binaries for glibc/x64 and glibc/arm64. On musl, the prebuild often does not exist, so `npm ci` falls back to compiling — which needs `python3`, `make` and `g++` in the builder stage, adds minutes to every build, and can fail on a version bump with an error message about a header file.

```dockerfile title="Alpine + native modules: the builder needs a toolchain"
FROM node:24-alpine AS deps
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
```

Because `node_modules` is copied from `deps` into the runtime stage, the toolchain stays in the builder and does not bloat the final image — but the build cost and fragility remain.

:::best-practice
Start with `node:24-bookworm-slim`. It is a few tens of megabytes larger and it removes an entire class of build failures. Move to Alpine only if image size is a measured constraint *and* you have verified every native dependency has a musl prebuild or builds cleanly.

If you do use Alpine, run your test suite **inside the image**. A native module that silently compiled against different assumptions fails at runtime, not at build time.
:::

## Layer caching

Docker caches each instruction and invalidates every layer after the first change. Copy the things that change rarely before the things that change constantly.

```dockerfile title="Do: manifests first"
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
```

```dockerfile title="Don't: everything first"
COPY . .
RUN npm ci --omit=dev
```

In the first, editing a handler leaves the install layer cached and the build takes seconds. In the second, every source change re-runs `npm ci` — a full dependency install, on every build, forever.

Two more caching wins:

- **Install OS packages before copying app code.** `apt-get install` output changes far less often than your source.
- **Use a BuildKit cache mount** for the npm cache, so even a dependency change reuses tarballs:

  ```dockerfile
  RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev
  ```

## `npm ci --omit=dev`

`npm ci` deletes `node_modules` and installs exactly what the lockfile specifies. `npm install` resolves ranges and may write a new lockfile, which means the image contains a dependency tree that was never tested and is not in your repository. In a Dockerfile that is disqualifying.

`--omit=dev` drops `devDependencies`. It is not only about size: your test framework, your linter and your build tooling are code you are not running, so every CVE in them is an alert you have to triage for no benefit. Typical saving is a few hundred megabytes and most of your vulnerability report.

The build stage still needs devDependencies — that is why stage 2 runs a plain `npm ci` and only `dist/` is copied forward.

:::warning
`--omit=dev` breaks if a runtime dependency is in the wrong section of `package.json`. The failure is a `MODULE_NOT_FOUND` at container start, not at build time. Boot the built image in CI before you push it — see [Continuous integration](ci.md).
:::

## Run as a non-root user

By default a container's process is **root**. Not "root inside a sandbox that is definitely safe" — root, with uid 0, and if it escapes the namespace, root on your node. Every container runtime has had escape CVEs.

The official Node images already include a `node` user with uid 1000. Use it:

```dockerfile
COPY --chown=node:node . .
USER node
```

Details that matter:

- **`USER node` goes after everything that needs to write.** `npm ci` as root and then dropping is fine; dropping first and then installing fails on permissions.
- **`--chown=node:node` on the `COPY`, not a separate `RUN chown -R`.** A recursive chown creates a second full-size layer containing a copy of every file.
- **Ports below 1024 need root.** Listen on 3000 and let the platform map it, rather than needing capabilities to bind 80.
- **Anything the app writes to needs to be writable by uid 1000** — an upload directory, a temp path, a SQLite file.
- **Enforce it at the platform too.** `securityContext: { runAsNonRoot: true, runAsUser: 1000, readOnlyRootFilesystem: true }` means a Dockerfile that forgets `USER` fails to schedule instead of silently running as root.

## PID 1 and signals

This is the mistake with the largest blast radius, because it makes your correct [graceful shutdown](graceful-shutdown.md) code dead weight.

PID 1 in a container is special: the kernel does not apply default signal handlers to it. A process at PID 1 with no explicit `SIGTERM` handler simply **ignores** the signal. It also inherits responsibility for reaping orphaned children, which Node does not do.

`docker stop` and every orchestrator send `SIGTERM` to **PID 1 only**. So:

```dockerfile title="Broken: shell form"
CMD npm start
```

Shell form becomes `/bin/sh -c "npm start"`. `sh` is PID 1, npm is a child, node is a grandchild. `SIGTERM` goes to `sh`, which does not forward it. Ten seconds later `SIGKILL` arrives and destroys all three. Every deploy, every request in flight, gone — and your shutdown handler never ran, so there is not even a log line.

```dockerfile title="Better: exec form, node directly"
CMD ["node", "dist/server.js"]
```

Now node is PID 1 and receives `SIGTERM`. Because your code registers a handler, it works — but node is still not reaping zombie children, which matters if you spawn subprocesses.

```dockerfile title="Correct: a real init"
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/server.js"]
```

`dumb-init` (or `tini`) sits at PID 1, forwards every signal to your process, and reaps orphans. It is a few hundred kilobytes.

| Approach | Signals forwarded | Zombies reaped | Notes |
| --- | --- | --- | --- |
| `CMD npm start` (shell form) | **No** | No | The common broken case |
| `CMD ["npm", "start"]` | Unreliable | No | npm is not a supervisor |
| `CMD ["node", "server.js"]` | Yes, if you handle them | No | Fine for a process that spawns nothing |
| `ENTRYPOINT ["dumb-init", "--"]` | Yes | Yes | Recommended |
| `docker run --init` | Yes | Yes | Same effect via the runtime; not available on every platform |

:::danger
**Never `CMD ["npm", "start"]` in production.** npm is a package manager being asked to act as a process supervisor. Signal forwarding to the child is not something to depend on, and it adds a process and a Node startup to your container for no benefit. Run `node` directly.
:::

Verify it, do not assume. Start the container, `docker stop` it, and check that your shutdown log lines appear and that it exits within a second or two rather than at the ten-second `SIGKILL`:

```bash
docker run -d --name t my-api:test
docker stop t          # if this takes ~10s, signals are not reaching node
docker logs t | tail
```

## `NODE_ENV=production`

Set it in the image, as an `ENV`, not in a script.

```dockerfile
ENV NODE_ENV=production
```

It changes behaviour in ways you want: Express caches view templates and skips verbose error output, and many libraries disable development-only checks. It is also what `npm ci --omit=dev` semantics align with.

Set it as an `ENV` rather than at `docker run` time so it cannot be forgotten. Remember that it is a *label*, not a security control — the actual protections come from your code. And per [Configuration](configuration.md), `NODE_ENV` should be read in exactly one place.

## Security considerations

- **No secrets in `ARG` or `ENV`.** Build args are stored in the image's history and readable with `docker history --no-trunc`. `ENV SECRET=…` is worse — it is visible in `docker inspect` and in the environment of every process. When a build genuinely needs a credential (a private registry token), use a BuildKit secret mount, which is never written to a layer:

  ```dockerfile
  RUN --mount=type=secret,id=npmrc,target=/root/.npmrc npm ci --omit=dev
  ```

  ```bash
  docker build --secret id=npmrc,src=$HOME/.npmrc .
  ```

- **Layers are immutable.** `COPY .env . && RUN rm .env` leaves the file in the earlier layer. Deletion does not delete.
- **Non-root, always.** `USER node`, plus `runAsNonRoot: true` at the platform so a mistake fails loudly.
- **Read-only root filesystem** where you can, with a `tmpfs` for anything that must be written. It eliminates a whole class of persistence techniques.
- **Drop capabilities.** `--cap-drop=ALL` and `--security-opt=no-new-privileges`. A web API needs none of them.
- **Scan the image** in CI — `docker scout`, Trivy or Grype. Most findings will be in the base OS, which is an argument for slim images and for rebuilding regularly.
- **Rebuild on a schedule.** A pinned digest that has not moved in a year is running a year of unpatched OS CVEs.
- **`--omit=dev` shrinks your attack surface,** not just your image.
- **Do not `COPY` the `.git` directory.** History contains every secret ever committed, including ones you removed from the working tree.
- **Verify what shipped:** `docker run --rm --entrypoint sh my-api:test -c 'ls -la /app'` and `docker history --no-trunc my-api:test`. Look for a `.env` before someone else does.

## Production considerations

- **Build once, deploy everywhere.** One image, tagged with the git SHA, promoted from staging to production unchanged. If you rebuild per environment you are not shipping what you tested.
- **Tag with the SHA, not just `latest`.** `latest` makes rollback ambiguous and makes "what is running" unanswerable.
- **`HEALTHCHECK` is not a Kubernetes probe.** Kubernetes ignores it entirely and uses its own probes. It is useful for `docker run`, Compose, and Swarm. Keep it cheap and point it at the **liveness** endpoint, never one that checks the database — the reasoning in [Health and readiness probes](health-and-readiness-probes.md) applies identically.
- **`--start-period` covers boot.** Without it, a container that takes 15 seconds to start is marked unhealthy while it is starting normally.
- **Set memory limits with Node in mind.** Node sizes its heap from what it can detect; under a container limit it may not detect it correctly. Set `--max-old-space-size` to roughly 75% of the container limit so V8 grows into headroom rather than into the OOM killer.
- **One process per container.** No supervisord, no clustering inside the container. See [Clustering](clustering.md).
- **Match the build architecture to the deploy architecture.** An image built on an arm64 laptop and deployed to amd64 either fails to start or runs under emulation. Build multi-arch, or build in CI.
- **Log to stdout.** Do not write log files inside the container; they are ephemeral and the platform already collects stdout.
- **Boot the image in CI before pushing it.** It catches a misplaced dependency and a broken `CMD` — the two failures that only appear at runtime.

### Image size

In rough order of impact:

1. **Multi-stage.** Build tooling never reaches the final image. This is most of the win.
2. **`npm ci --omit=dev`.** Frequently hundreds of megabytes.
3. **A real `.dockerignore`.** Stops `.git` and a host `node_modules` being copied.
4. **`--no-install-recommends` and clearing `apt` lists in the same `RUN`.** A separate `RUN rm` does not shrink the previous layer.
5. **Slim or Alpine base.** Real but smaller than the above, and Alpine carries the native-module cost.
6. **Distroless.** The last step, with real tradeoffs.

Size is worth chasing for pull time during a scale-up and for CVE surface, not for its own sake. A 200 MB image that builds reliably beats a 90 MB image that fails on every `argon2` bump.

### Distroless

Distroless images contain a runtime and its libraries and nothing else — no shell, no package manager, no `ls`. Google publishes Node variants per major version.

The benefits are real: nothing for an attacker to pivot with, and a vulnerability scan that reports almost nothing because there is almost nothing installed.

The costs are equally real:

- **No shell.** `docker exec … sh` does not work. Debugging is via an ephemeral debug container or by shipping a `-debug` variant, which reintroduces a shell.
- **No `HEALTHCHECK` using shell syntax** — you must exec the Node binary directly.
- **No init**, so use the `--init` runtime flag or accept node at PID 1.
- **You must confirm a tag exists for your Node major.** Do not assume; check the registry before you depend on it.

Reach for distroless when you have a security requirement that justifies losing your debugging tools, and keep a `-debug` tag available for incidents.

## Common mistakes

- **`CMD npm start`.** Shell form, `sh` at PID 1, `SIGTERM` never forwarded. Every deploy drops requests and your shutdown handler never runs.
- **No `.dockerignore`.** `.env`, `.git` and a host-built `node_modules` all copied into the image.
- **`npm install` instead of `npm ci`.** The image contains a dependency tree that is not in your lockfile.
- **`COPY . .` before `npm ci`.** Every source edit reinstalls every dependency.
- **Running as root.** A container escape becomes a host compromise, and the platform will not stop you.
- **`RUN chown -R` after copying.** A duplicate of every file in a new layer. Use `--chown` on the `COPY`.
- **A secret in `ARG` or `ENV`.** Permanently readable in the image history.
- **Expecting `RUN rm secret` to remove it.** Layers are immutable; the earlier one still has it.
- **`FROM node:latest`.** Unreproducible, and one day it is a new major.
- **Alpine without checking native modules.** `argon2` and `better-sqlite3` compile from source on musl, or fail.
- **Keeping devDependencies in the runtime image.** Hundreds of megabytes and a much larger CVE report.
- **A `HEALTHCHECK` that queries the database.** Same failure mode as a liveness probe that does: a database blip restarts everything.
- **Assuming Kubernetes uses `HEALTHCHECK`.** It does not. Configure probes.
- **No memory limit awareness.** V8 grows past the container limit and the OOM killer takes the process, with no Node-level error.
- **Building on arm64 and deploying to amd64.** Silent emulation, or a container that will not start.

## Related topics

- [Graceful shutdown](graceful-shutdown.md) — the code PID 1 has to let receive `SIGTERM`.
- [Health and readiness probes](health-and-readiness-probes.md) — what `HEALTHCHECK` should point at, and how it differs from a probe.
- [Configuration](configuration.md) — injecting environment variables without baking them in.
- [Continuous integration](ci.md) — building, scanning and smoke-testing the image.
- [Clustering](clustering.md) — why one process per container.
- [Performance](performance.md) — heap sizing under a container memory limit.
- [Secrets management](../security/secrets-management.md) — where credentials live instead of the image.
- [Dependency auditing](../security/dependency-auditing.md) — scanning what `--omit=dev` leaves behind.
- [Running the examples](../getting-started/running-the-examples.md) — `npm ci` versus `npm install`.
- [Deployment checklist](deployment-checklist.md) — the container items to verify before shipping.
