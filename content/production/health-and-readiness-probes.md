---
title: Health and readiness probes
description: Liveness, readiness and startup probes — what each one should actually check, the failure mode of getting each wrong, and how readiness ties into graceful shutdown.
status: current
updated: 2026-09-08
---

Three probes, three different questions, three different answers. Conflating them is one of the few configuration mistakes that can take down a healthy fleet: a liveness probe that checks the database will restart every pod you have the moment the database has a bad ten seconds.

## The three questions

| Probe | Question | Failure action | Should it check dependencies? |
| --- | --- | --- | --- |
| **Liveness** | Is this process broken beyond recovery? | **Restart the container** | **No. Never.** |
| **Readiness** | Should this instance receive traffic right now? | Remove from the load balancer; keep it running | Yes — the ones it cannot serve without |
| **Startup** | Has it finished booting yet? | Keep waiting, then restart if it never starts | Boot progress only |

The distinction is entirely about **what the platform does when the probe fails**. Liveness failure destroys the container. Readiness failure removes traffic and leaves it alive to recover. That difference dictates what each may legitimately check.

## Liveness: is the process wedged?

A liveness probe answers one question: *would restarting this container fix it?* The only conditions that qualify are ones the process cannot recover from on its own — a deadlocked event loop, an unrecoverable internal state, a heap that is exhausted and thrashing GC.

So a liveness endpoint does almost nothing:

```js title="src/routes/health.js"
import express from 'express'

export const health = express.Router()

// Liveness: if the event loop can run this, the process is alive.
health.get('/livez', (req, res) => {
  res.status(200).json({ status: 'ok' })
})
```

That looks too simple to be useful. It is not. Reaching this handler means the event loop is turning, the HTTP server is accepting connections, and the router is intact. If the event loop were blocked, the probe would time out — which is exactly the condition a restart fixes.

:::danger
**Never check a database, a cache, or any other service from a liveness probe.** This is the single most damaging health-check mistake, and it turns a partial outage into a total one.

The failure: your database has a five-second blip — a failover, a lock storm, a network partition. Every pod's liveness probe fails at the same instant. Kubernetes kills every pod in your Deployment simultaneously. They restart, immediately re-check the still-recovering database, fail again, and enter `CrashLoopBackOff`. Now the database recovers — and there is nothing left to serve traffic. Restarts back off exponentially, so recovery takes minutes longer than the original blip.

You have converted a five-second database hiccup into a multi-minute total outage, and every restart added reconnection load to the database that was already struggling.

Restarting your process does not fix someone else's database. That is the entire argument.
:::

The same reasoning excludes disk space, downstream HTTP services, message brokers and feature-flag providers. None of them is fixed by killing your container.

If you want liveness to catch a genuinely wedged event loop, measure the loop itself rather than a dependency:

```js title="src/routes/health.js — event-loop-aware liveness"
import { monitorEventLoopDelay } from 'node:perf_hooks'

const loopDelay = monitorEventLoopDelay({ resolution: 20 })
loopDelay.enable()

health.get('/livez', (req, res) => {
  // p99 delay in milliseconds over the sampling window.
  const p99Ms = loopDelay.percentile(99) / 1e6
  if (p99Ms > 5000) {
    return res.status(503).json({ status: 'degraded' })
  }
  res.status(200).json({ status: 'ok' })
})
```

:::note
Be careful with this. A blocked event loop usually cannot answer the request at all, so the timeout already covers you, and a threshold set too low turns a slow-but-working process into a restart loop. Start with the trivial version; add this only if you have observed a real wedge that the timeout did not catch.
:::

## Readiness: should I get traffic?

Readiness is where dependency checking belongs, because failing it removes traffic without destroying anything. A pod that is not ready stays alive, keeps its connections, keeps retrying, and rejoins the pool the moment it recovers.

It should check the dependencies **this instance cannot serve a request without**, and nothing else.

```js title="src/routes/health.js — readiness"
import { pool } from '../db.js'
import { redis } from '../redis.js'

// Flipped to false by the shutdown handler. See below.
let accepting = true
export function setNotReady() { accepting = false }

const TIMEOUT_MS = 1000

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timeout`)), ms).unref(),
    ),
  ])
}

health.get('/readyz', async (req, res) => {
  if (!accepting) {
    return res.status(503).json({ status: 'shutting_down' })
  }

  const checks = await Promise.allSettled([
    withTimeout(pool.query('SELECT 1'), TIMEOUT_MS, 'postgres'),
    withTimeout(redis.ping(), TIMEOUT_MS, 'redis'),
  ])

  const [postgres, cache] = checks
  const required = postgres.status === 'fulfilled'

  res.status(required ? 200 : 503).json({
    status: required ? 'ok' : 'unavailable',
    checks: {
      postgres: postgres.status === 'fulfilled' ? 'up' : 'down',
      // Redis is a cache here — degraded, not fatal.
      redis: cache.status === 'fulfilled' ? 'up' : 'down',
    },
  })
})
```

Express 5 forwards a rejected async handler to your error middleware automatically, so no wrapper is needed — but note that this handler does not rely on that: it uses `allSettled` so one failing check cannot mask the others.

Four things that example gets right:

- **A timeout on every check.** Without one, a hung database makes the readiness probe hang, the probe times out, and you have learned nothing except more slowly.
- **`Promise.allSettled`, not `Promise.all`.** You want the status of every dependency, not the first failure.
- **Required versus optional dependencies are distinguished.** If Redis is a cache and the API still works without it — slower — then Redis being down must not remove the pod from the load balancer. Every pod would go unready at once, and you would have an outage over a cache.
- **The `accepting` flag is checked first**, before any I/O, so shutdown is instant and cheap.

:::warning
Be strict about what "required" means. Every dependency you mark required is a dependency whose outage becomes your outage, fleet-wide and simultaneously. If a request can be served — even degraded — without it, it is not required.
:::

### Keep them cheap

Probes run constantly. With `periodSeconds: 2` and 40 pods, that is 20 readiness checks per second against your database, forever, plus whatever the liveness and startup probes do.

- `SELECT 1` is the right query. It exercises the connection without touching a table. See [Health checks](../databases/health-checks.md) for what a driver-level check actually proves.
- **Cache the result for a second or two.** Two probes 200 ms apart do not need two round trips.
- **Use the pool, do not open a connection.** A probe that opens a fresh connection each time is a slow leak of database connections that manifests as `too many clients` at the worst moment.
- Never run a business query, an aggregate, a migration check or a table count.

```js title="src/routes/health.js — cached check"
let cached = { at: 0, ok: false }

async function checkPostgres() {
  if (Date.now() - cached.at < 2000) return cached.ok
  try {
    await withTimeout(pool.query('SELECT 1'), TIMEOUT_MS, 'postgres')
    cached = { at: Date.now(), ok: true }
  } catch {
    cached = { at: Date.now(), ok: false }
  }
  return cached.ok
}
```

## Startup: has it finished booting?

A startup probe exists for processes that take a while to become useful — loading a large model, warming a cache, running migrations, establishing a pool. While it is failing, liveness and readiness are suspended.

Without it you must choose between two bad options: a liveness `initialDelaySeconds` long enough for the slowest boot (so a genuinely wedged process takes that long to be noticed forever after), or one short enough to be useful (so a slow boot gets killed and restarted, repeatedly, and never starts).

```js title="src/routes/health.js — startup"
let booted = false
export function markBooted() { booted = true }

health.get('/startupz', (req, res) => {
  res.status(booted ? 200 : 503).json({ status: booted ? 'ok' : 'starting' })
})
```

```yaml title="deployment.yaml"
startupProbe:
  httpGet: { path: /startupz, port: 3000 }
  periodSeconds: 5
  failureThreshold: 60      # allow up to 5 minutes to boot
livenessProbe:
  httpGet: { path: /livez, port: 3000 }
  periodSeconds: 10
  failureThreshold: 3
readinessProbe:
  httpGet: { path: /readyz, port: 3000 }
  periodSeconds: 2
  failureThreshold: 2
```

`failureThreshold × periodSeconds` on the startup probe is your entire boot budget; on liveness it is how long a wedge persists before a restart. Liveness needs `failureThreshold` of at least 2 or 3 so a single blip — a GC pause, a noisy neighbour — does not kill a working container.

## Response shape

Keep it small, JSON, and consistent. The status code is what the platform reads; the body is for humans debugging with `curl`.

```json title="GET /readyz — 200"
{
  "status": "ok",
  "checks": { "postgres": "up", "redis": "up" }
}
```

```json title="GET /readyz — 503"
{
  "status": "unavailable",
  "checks": { "postgres": "down", "redis": "up" }
}
```

Rules that matter:

- **200 for healthy, 503 for not.** Not 500 — 503 Service Unavailable is the accurate code and some proxies treat it specially. Never return 200 with `{"status":"down"}`; the platform reads the code, not the body.
- **Set `Cache-Control: no-store`.** A cached probe response is a probe that is not probing.
- **No probe endpoint should be logged at `info`.** Twenty requests a second of `GET /readyz 200` drowns your actual logs. Exclude the paths in your HTTP logger — see [Logging](../express-libraries/logging.md).
- **Do not rate-limit them.** A rate limiter that returns 429 to the kubelet fails the probe and restarts a healthy pod.
- **Register them before authentication middleware,** or the probe gets a 401.

## Security considerations

Probe endpoints are effectively public: the kubelet cannot authenticate, and anything reachable from inside the cluster is reachable by anything else in the cluster. So the rule is **unauthenticated but uninformative**.

```json title="Don't: an internal map for anyone who asks"
{
  "status": "degraded",
  "version": "2.14.3",
  "commit": "9f3a1c2",
  "node": "24.20.0",
  "database": { "host": "prod-pg-primary.internal", "error": "password authentication failed for user \"app\"" },
  "redis": { "host": "10.0.4.17:6379", "error": "ECONNREFUSED" },
  "env": { "NODE_ENV": "production", "DATABASE_URL": "postgres://app:hunter2@prod-pg-primary.internal:5432/app" }
}
```

That body gives an attacker your internal hostnames, your topology, your exact dependency versions to match against CVEs, and — in the worst and entirely real case — a credential. Error strings from drivers routinely contain hostnames and usernames.

- **Never include exception messages, stack traces, hostnames, connection strings or versions.** `"postgres": "down"` is all an operator needs to start looking; the detail goes to your logs, which are access-controlled.
- **A `/health` that dumps config is a credential leak.** So is a `/debug` endpoint. See [Configuration](configuration.md).
- **Exclude probe paths from access logs but not from metrics.** You want the counter; you do not want the log lines.
- **Bind detailed diagnostics to a separate port** that is not exposed by the Service, if you want a rich internal endpoint at all.
- **Do not let a probe become a denial-of-service amplifier.** An unauthenticated endpoint that runs a real query lets anyone inside the network load your database for free. That is another reason to cache the result.
- **Probes and public traffic should not share a path prefix** that a WAF or auth middleware might later cover — or uncover.

## Readiness and graceful shutdown

This is where readiness earns its place, and it is why the flag exists as a variable rather than being computed fresh each time.

The first step of [graceful shutdown](graceful-shutdown.md) is flipping readiness to `false`, several seconds before the socket closes. The sequence:

1. `SIGTERM` arrives. `setNotReady()` runs. `/readyz` starts returning 503 immediately.
2. The process **keeps serving normally** — the socket is still open, in-flight requests continue, and new requests that still arrive are answered.
3. The platform observes the failing probe and removes the endpoint from the load balancer. This takes a second or more, and is not synchronous with `SIGTERM`.
4. Only then does `server.close()` run.

Skip step 1 and the load balancer is still routing to a closed socket, which is a 502 for every request in that window. That is the classic "we get errors on every deploy" symptom.

Two configuration details make it work:

- **`periodSeconds: 2` on readiness, `failureThreshold: 2`.** A probe checked every 30 seconds means the flag takes 30 seconds to be noticed, and your drain delay was five.
- **Readiness must fail *before* the socket closes, not because it closed.** A connection-refused probe result is also a failure, but by then you have already dropped requests.

The flag also has a non-shutdown use: fail readiness while the process is genuinely overloaded — event-loop delay through the roof, pool fully saturated — so the load balancer sheds traffic to healthier instances. Use it carefully. If load is uniform, every pod goes unready at once and you have taken yourself down.

## Production considerations

- **Probe timeouts must be shorter than the probe period.** Otherwise checks overlap and pile up.
- **`failureThreshold: 1` on liveness is a mistake.** One GC pause restarts a working container.
- **Watch out for behind-a-proxy paths.** If your ingress rewrites paths, the probe hits the container directly and does not go through the ingress — configure the port and path accordingly.
- **Startup probes let you keep liveness aggressive.** That is their whole value: a short liveness period is safe because it does not apply until boot completes.
- **In a clustered process, the probe answers for whichever worker handled it.** A pod can be "ready" with half its workers dead. See [Clustering](clustering.md).
- **Track probe failures as a metric.** A pod that flaps ready/unready is a pod that is dropping requests at each transition, and it is invisible unless you count it.
- **Consider a dependency-detail endpoint on an internal-only port** for operators, separate from `/readyz`.
- **Test the DB-down case.** Stop the database in a staging environment and confirm pods go unready and stay running, rather than entering `CrashLoopBackOff`. If they crash-loop, your liveness probe is checking a dependency.

## Common mistakes

- **A liveness probe that checks the database.** A brief database problem restarts every pod simultaneously and turns it into a total outage.
- **One `/health` endpoint wired to both probes.** It cannot be both — the correct dependency behaviour is opposite for each.
- **Marking a cache as a required readiness dependency.** Redis blips, every pod goes unready, you have an outage over something you could have degraded through.
- **Returning 200 with `{"status":"down"}`.** The orchestrator reads the status code and thinks you are fine.
- **Leaking internals in the body.** Hostnames, driver errors, versions, connection strings.
- **No timeout on the dependency check.** A hung database makes the probe hang, which the platform reports as a failure with no diagnostic value.
- **Opening a new connection per probe.** A steady leak that surfaces as connection exhaustion.
- **An expensive query in the probe.** `SELECT count(*)` every two seconds across forty pods is a self-inflicted load test.
- **Probe endpoints behind auth middleware.** 401 is a failed probe.
- **Rate-limiting the probe path.** 429 is a failed probe, and it restarts healthy pods.
- **Not flipping readiness on `SIGTERM`.** Every deploy drops requests.
- **`periodSeconds: 30` on readiness.** The shutdown flag is not observed until long after you needed it to be.
- **Logging every probe request.** Your logs become 95% `GET /readyz 200`.
- **Probes that are ready before the pool is.** Mark ready only after boot is genuinely complete, or the first requests fail.

## Related topics

- [Graceful shutdown](graceful-shutdown.md) — the sequence that flips readiness first, and why.
- [Health checks](../databases/health-checks.md) — what a driver-level check actually proves.
- [Observability](observability.md) — event-loop delay, and alerting on probe failures.
- [Clustering](clustering.md) — why a clustered pod's readiness signal is weaker than it looks.
- [Configuration](configuration.md) — why a health endpoint must never echo config.
- [Dockerfile](dockerfile.md) — the container-level `HEALTHCHECK`, and how it differs from a probe.
- [Logging](../express-libraries/logging.md) — excluding probe paths from access logs.
- [Rate limiting](../express-libraries/rate-limiting.md) — and why probe paths must be exempt.
- [Retries and timeouts](../databases/retries-and-timeouts.md) — the timeout wrapper used above.
- [Deployment checklist](deployment-checklist.md) — the probe items to verify before shipping.
