---
title: The http module
description: Building a server with node:http, why Express sits on top of it, and the timeout settings that decide whether your proxy returns 502s.
status: current
updated: 2026-09-08
---

Express is a thin layer over `node:http`. Every `req` and `res` you handle in an Express route is a Node `IncomingMessage` and `ServerResponse`, and every timeout that matters in production is configured on the Node `Server` object, not by Express. Knowing this layer is what lets you fix the problems Express cannot see.

## Basic example

```js title="src/server.js"
import http from 'node:http'

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`)

  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify({ status: 'ok' }))
  }

  res.writeHead(404, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: 'not_found' }))
})

server.listen(3000, () => console.log('listening on http://localhost:3000'))
```

A few things are already visible:

- `req.url` is only the **path and query** (`/users?page=2`), never the scheme or host. Build a `URL` with a base when you need to parse it.
- `req.headers` keys are **lowercased** by Node. `req.headers.Host` is always `undefined`.
- Nothing routes, parses a body, or handles an error. That is the whole reason Express exists.

## Why Express exists

`node:http` gives you a socket and a callback. Everything else, you write:

| Need | `node:http` | Express 5 |
| --- | --- | --- |
| Routing | `if`/`switch` on method and pathname | `app.get('/users/:id', …)` |
| Path parameters | manual parsing | `req.params` |
| Query parsing | `new URL(...).searchParams` | `req.query` |
| JSON body | read the stream, size-limit it, parse, handle bad JSON | `express.json()` |
| Composable cross-cutting logic | wrapper functions | middleware chain |
| Error handling | try/catch in every branch | error middleware; rejected promises forwarded automatically |
| 404s, `Content-Type`, ETags | manual | built in |

Use `node:http` directly for a single-purpose endpoint — a health probe sidecar, a webhook receiver, a metrics scrape target — where a framework is more surface than the job needs. Use Express for anything with more than a handful of routes. See [Setup and project structure](../express/setup-and-project-structure.md).

## How it works

### `req` and `res` are streams

`req` is a `Readable` of the request body; `res` is a `Writable` for the response. That is why every stream technique applies directly:

```js title="src/echo.js"
import { pipeline } from 'node:stream/promises'

// stream the request body straight back out, constant memory
await pipeline(req, res)
```

Reading a JSON body by hand means enforcing a limit yourself — otherwise a client streams gigabytes into your heap:

```js title="src/read-json.js"
export async function readJson(req, limitBytes = 1_000_000) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limitBytes) {
      const err = new Error('payload too large')
      err.status = 413
      throw err
    }
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}
```

`express.json({ limit: '1mb' })` is this, plus content-type checking, charset handling, and gzip/deflate/Brotli decoding.

:::warning
If you do not consume the request body, the socket may not be reusable and the client can stall waiting for you to drain it. When you reject a request early — say, 401 before reading — either respond and let Node destroy the socket, or explicitly `req.resume()` to discard the body.
:::

### Writing a response

```js
res.statusCode = 201
res.setHeader('Content-Type', 'application/json')
res.setHeader('Location', `/users/${id}`)
res.end(JSON.stringify(user))
```

`res.writeHead(status, headers)` does the same in one call but sends the headers immediately. After headers are sent, `setHeader` throws `ERR_HTTP_HEADERS_SENT` — which is the real cause of most "Cannot set headers after they are sent" reports: two code paths both ended the response.

`res.flushHeaders()` sends the head early, which is what you want for server-sent events or a long-running response where the client needs to see the status before the body exists.

### Streaming a large response

```js title="src/download.js"
import { createReadStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'

res.writeHead(200, { 'Content-Type': 'application/octet-stream' })
await pipeline(createReadStream(filePath), res)
```

`pipeline` destroys the file stream when the client disconnects. With a bare `.pipe()`, every aborted download leaks a file descriptor. Full detail in [Streams and buffers](./streams-and-buffers.md).

### Client IP behind a proxy

`req.socket.remoteAddress` is the address of whatever connected to you — behind a load balancer, that is the load balancer. The real client is in `X-Forwarded-For`, which is a client-supplied header and therefore forgeable unless your proxy overwrites it.

In Express, `app.set('trust proxy', …)` makes `req.ip` read that header — configure it to match your actual hop count, never `true` on a service reachable from the internet without a proxy in front. Getting this wrong lets an attacker bypass rate limiting by sending a random `X-Forwarded-For` on each request. See [Rate limiting](../express-libraries/rate-limiting.md).

## Production considerations

### The four timeouts

These live on the `Server` object and Express does not set them for you.

| Property | Default | What it bounds |
| --- | --- | --- |
| `server.keepAliveTimeout` | 5000 ms | how long an **idle** keep-alive connection is held open after a response |
| `server.headersTimeout` | 60000 ms | time allowed to receive the complete request **headers** |
| `server.requestTimeout` | 300000 ms | total time allowed to receive the entire request, headers and body |
| `server.timeout` | 0 (off) | inactivity timeout on the socket |

```js title="src/server.js"
const server = http.createServer(app)

server.keepAliveTimeout = 65_000
server.headersTimeout = 66_000
server.requestTimeout = 30_000

server.listen(3000)
```

`headersTimeout` and `requestTimeout` exist to defend against slow-header attacks (Slowloris), where a client opens many connections and dribbles bytes to hold your sockets forever. Leaving `requestTimeout` at five minutes is generous; tighten it to what your slowest legitimate upload actually needs.

### The reverse-proxy 502

:::danger
**`keepAliveTimeout` must be longer than the idle timeout of whatever proxies to you.** If Node closes an idle keep-alive connection at the same moment the proxy dispatches a request onto it, the request is lost. The proxy cannot know whether it was processed, so it does not retry — it returns **502 Bad Gateway**. The symptom is a small, constant percentage of 502s with no corresponding error in your application logs.
:::

The fix is to make Node the *slower* side:

| Proxy | Typical idle timeout | Set `keepAliveTimeout` to |
| --- | --- | --- |
| AWS Application Load Balancer | 60 s (default) | 65 s |
| nginx (`keepalive_timeout` upstream) | 60 s | 65 s |

Then set `headersTimeout` slightly **above** `keepAliveTimeout` — otherwise the headers timer can fire on a connection that was merely idle between requests, closing it for the wrong reason.

If you cannot change the application, the alternative is to lower the proxy's idle timeout below Node's 5 s default. Changing Node is almost always easier.

### Shutting down without dropping requests

`server.close()` stops accepting new connections and waits for in-flight requests to finish — but it does **not** touch idle keep-alive connections, so a process with idle clients hangs until they time out.

```js title="src/shutdown.js"
export function shutdown(server, { graceMs = 10_000 } = {}) {
  server.close(() => process.exit(0))   // stop accepting; wait for in-flight
  server.closeIdleConnections()          // drop connections not currently serving a request

  setTimeout(() => {
    server.closeAllConnections()         // force the stragglers
    process.exit(1)
  }, graceMs).unref()
}

process.on('SIGTERM', () => shutdown(server))
```

The order matters: `closeIdleConnections()` releases the connections that are merely parked, while requests still being served run to completion. `closeAllConnections()` is the hard stop for anything left after the grace period — use it as a deadline, not as the first move.

Before any of this, flip your readiness probe to failing and wait a few seconds, so the load balancer stops routing new traffic to a process that is about to disappear. Full sequence in [Graceful shutdown](../production/graceful-shutdown.md).

### Making outbound requests

Use the global `fetch` — it is built in on Node 24, backed by undici, and has a standard API:

```js title="src/upstream.js"
const res = await fetch('https://api.example.com/v1/rates', {
  headers: { accept: 'application/json' },
  signal: AbortSignal.timeout(2000),
})
if (!res.ok) throw new Error(`upstream ${res.status}`)
const rates = await res.json()
```

`http.request()` is still there and still correct, but it is a callback API with manual body handling. Reach for it only when you need something `fetch` does not expose, such as fine-grained agent or socket control; otherwise use `fetch`, or `undici` directly when you want connection-pool tuning.

:::best-practice
`fetch` has **no default timeout**. Every outbound call needs `AbortSignal.timeout()`, or one slow upstream will hold your handlers, database connections and memory open until the process dies.
:::

## Common mistakes

- **Reading `req.url` as a full URL.** It is path + query only. Build a `URL` with a base.
- **Looking up headers with the original casing.** Node lowercases every key.
- **Buffering a request body with no size limit.** A trivial memory-exhaustion DoS.
- **Ending a response twice.** `ERR_HTTP_HEADERS_SENT`; usually a missing `return` in front of an early `res.end()`.
- **Leaving `keepAliveTimeout` at 5 s behind a 60 s proxy.** Intermittent 502s that never appear in application logs.
- **Setting `headersTimeout` below `keepAliveTimeout`.** Connections get closed for the wrong reason.
- **Calling `server.close()` and expecting a fast exit.** Idle keep-alive connections hold the process open; call `closeIdleConnections()`.
- **Trusting `X-Forwarded-For` without a proxy that overwrites it.** Anyone can forge their apparent IP and bypass rate limits.
- **`fetch` without an `AbortSignal`.** No timeout means an unbounded hang.
- **Not draining the request body on an early rejection.** Leaves the socket unusable and the client waiting.

## Related topics

- [Streams and buffers](./streams-and-buffers.md) — `req`/`res` as streams, backpressure and `pipeline`.
- [Async/await and promises](./async-await-and-promises.md) — `AbortSignal` and timeouts for outbound calls.
- [Runtime and the event loop](./runtime-and-event-loop.md) — why network I/O does not use the threadpool.
- [Setup and project structure](../express/setup-and-project-structure.md) — the Express app that plugs into `createServer`.
- [Request and response](../express/request-and-response.md) — what Express adds on top of `IncomingMessage`/`ServerResponse`.
- [Graceful shutdown](../production/graceful-shutdown.md) — the full drain-and-exit sequence.
- [Health and readiness probes](../production/health-and-readiness-probes.md) — taking a process out of rotation before it stops.
