---
title: Server-sent events
description: Streaming one-way updates with @Sse() and an Observable<MessageEvent> — the wire format Nest writes for you, the Nest 12 @SseSignal() decorator, when SSE beats WebSockets, proxy buffering, and the browser connection limit.
status: current
updated: 2026-09-11
---

`@Sse()` turns a route handler into a long-lived `text/event-stream` response. You return an `Observable<MessageEvent>`; Nest keeps the connection open, serializes each emission into the event-stream format, and tears everything down when the client goes away. It is the smallest real-time mechanism that exists, and for one-way updates it is almost always the right one.

## Why it exists

Polling is wasteful and late. WebSockets are neither, but they cost you a second protocol, sticky sessions, a shared adapter for fan-out across replicas, and your own reconnect logic.

SSE sits between them. It is plain HTTP, so every proxy, load balancer, auth header and observability tool you already have applies unchanged — and the browser's `EventSource` reconnects on its own, replaying the last event id it saw. The price is that it only goes one way.

| | SSE | WebSockets |
| --- | --- | --- |
| Direction | server → client only | both |
| Protocol | HTTP | upgrade to `ws://` |
| Reconnect | automatic, with `Last-Event-ID` | you write it |
| Works through proxies | yes, it is a normal response | usually, sometimes not |
| Payload | UTF-8 text (JSON in practice) | text or binary |
| Server code | one decorator | a gateway, an adapter, a lifecycle |
| Per-origin browser limit | **6 over HTTP/1.1** | ~255 |

The rule of thumb: if the client never needs to send anything on the same channel, use SSE. Notifications, job progress, a live dashboard, a log tail, a streamed model response — all one-way. A collaborative editor or a chat where typing indicators matter is not.

## The basic shape

```ts title="src/jobs/jobs.controller.ts"
import { Controller, Param, Sse, type MessageEvent } from '@nestjs/common'
import { Observable, interval, map } from 'rxjs'
import { JobsService } from './jobs.service.js'

@Controller('jobs')
export class JobsController {
  private readonly jobs: JobsService

  constructor(jobs: JobsService) {
    this.jobs = jobs
  }

  @Sse(':id/progress')
  progress(@Param('id') id: string): Observable<MessageEvent> {
    return interval(1000).pipe(
      map(() => ({ data: this.jobs.progressFor(id) })),
    )
  }
}
```

`@Sse()` takes the same path argument as `@Get()`, and the route obeys the same path-to-regexp 8 grammar as every other Nest route — see [Routing and path syntax](../nestjs/routing-and-path-syntax.md).

The handler **must** return an `Observable`. Returning a promise or a plain value throws `ReferenceError: You must return an Observable stream to use Server-Sent Events (SSE).`

## `MessageEvent` and the wire format

`MessageEvent` from `@nestjs/common` has five optional fields, and each maps to one line of the event-stream format:

| Field | Type | Becomes | Notes |
| --- | --- | --- | --- |
| `data` | `string \| object` | `data: …` | an object is `JSON.stringify`-ed for you |
| `type` | `string` | `event: …` | the client listens with `addEventListener(type, …)` |
| `id` | `string` | `id: …` | Nest assigns an incrementing one when you omit it |
| `retry` | `number` | `retry: …` | tells the client how long to wait before reconnecting, in ms |
| `comment` | `string` | `: …` | ignored by clients — this is the heartbeat |

```ts
import { Observable, map } from 'rxjs'
import type { MessageEvent } from '@nestjs/common'

const events: Observable<MessageEvent> = source$.pipe(
  map((job) => ({
    type: 'job.progress',
    id: `${job.id}:${job.revision}`,
    data: { percent: job.percent, stage: job.stage },
  })),
)
```

Two details Nest handles that are easy to get wrong by hand:

- **Multi-line values are split correctly.** A `data` string containing newlines becomes several `data:` lines, which is what the spec requires; a naive implementation terminates the event early and the client sees garbage.
- **`type`, `id` and `retry` are sanitized** — carriage returns and newlines are stripped. That closes a response-splitting hole when any of them come from user input, but it is not a licence to put user input there.

### Headers Nest sets for you

When the first message is written, Nest commits these:

```text
Content-Type:  text/event-stream
Connection:    keep-alive
Cache-Control: private, no-cache, no-store, must-revalidate, max-age=0, no-transform
Pragma:        no-cache
X-Accel-Buffering: no
```

`X-Accel-Buffering: no` is the nginx opt-out and `no-transform` asks intermediaries not to re-encode the body. Nest sends both without being asked, which removes the two most common causes of "my stream arrives all at once at the end".

:::note
Headers are deliberately deferred until the first emission. That is what lets an exception filter still set a status code when the observable errors before emitting anything — once a byte of the stream is out, the status is fixed at 200 and an error can only be signalled inside the stream.
:::

## Cleaning up: `@SseSignal()`

The subscription is unsubscribed when the client disconnects, so an observable's own teardown function runs. What that does **not** cover is work done during setup, before the observable exists — and on a slow setup path the client may already be gone by the time you would subscribe.

Nest 12 adds `@SseSignal()`, which injects the `AbortSignal` for the stream's whole lifetime:

```ts title="src/logs/logs.controller.ts"
import { Controller, Sse, SseSignal, type MessageEvent } from '@nestjs/common'
import { EMPTY, Observable } from 'rxjs'
import { LogsService } from './logs.service.js'

@Controller('logs')
export class LogsController {
  private readonly logs: LogsService

  constructor(logs: LogsService) {
    this.logs = logs
  }

  @Sse('tail')
  async tail(@SseSignal() signal: AbortSignal): Promise<Observable<MessageEvent>> {
    const cursor = await this.logs.openCursor()

    // The client may have disconnected while openCursor() was running.
    if (signal.aborted) {
      await cursor.close()
      return EMPTY
    }

    return new Observable<MessageEvent>((subscriber) => {
      const stop = this.logs.stream(cursor, (line) => subscriber.next({ data: line }))
      signal.addEventListener('abort', () => void cursor.close(), { once: true })
      return () => stop()
    })
  }
}
```

The signal aborts on **every** exit path — client disconnect, normal completion, and error — which is what makes it a reliable place to hang cleanup. Two consequences:

- `signal.aborted` is only meaningful as a "did the client leave?" check **during setup**, before you return the observable. After that it also fires on success.
- Cleanup attached to `abort` may run alongside the observable's own teardown, so make it idempotent.

Without this, a handler that allocates a database cursor, a file handle or a subscription before returning leaks it on every client that disconnects during setup — and a client that navigates away mid-request is the normal case, not the edge case.

## Heartbeats

An idle TCP connection through a load balancer or a corporate proxy gets closed, typically after 30 to 60 seconds of silence. The client reconnects, so nothing is broken, but you pay a reconnect storm on every quiet minute.

A comment-only message is invisible to the client and keeps the connection alive:

```ts title="src/notifications/notifications.controller.ts"
import { Controller, Sse, type MessageEvent } from '@nestjs/common'
import { Observable, interval, map, merge } from 'rxjs'
import { NotificationsService } from './notifications.service.js'

@Controller('notifications')
export class NotificationsController {
  private readonly notifications: NotificationsService

  constructor(notifications: NotificationsService) {
    this.notifications = notifications
  }

  @Sse('stream')
  stream(): Observable<MessageEvent> {
    const heartbeat = interval(15_000).pipe(map((): MessageEvent => ({ comment: 'keep-alive' })))
    const events = this.notifications.asObservable().pipe(map((n): MessageEvent => ({ data: n })))

    return merge(events, heartbeat)
  }
}
```

Set the interval below your shortest proxy idle timeout. Fifteen seconds is a safe default; if you control every hop, measure and raise it.

## Resuming with `Last-Event-ID`

The reason to set `id` yourself is resumption. When `EventSource` reconnects it sends the id of the last event it received in a `Last-Event-ID` header, and your handler can start from there:

```ts title="src/feed/feed.controller.ts"
import { Controller, Headers, Sse, type MessageEvent } from '@nestjs/common'
import { Observable, map } from 'rxjs'
import { FeedService } from './feed.service.js'

@Controller('feed')
export class FeedController {
  private readonly feed: FeedService

  constructor(feed: FeedService) {
    this.feed = feed
  }

  @Sse()
  stream(@Headers('last-event-id') lastEventId?: string): Observable<MessageEvent> {
    return this.feed.since(lastEventId).pipe(
      map((entry): MessageEvent => ({ id: entry.seq, data: entry.payload })),
    )
  }
}
```

The auto-assigned id is a per-connection counter and therefore useless for resumption — it restarts on every reconnect. If you want at-least-once delivery across reconnects, the id must be a cursor into your own data.

:::warning
`Last-Event-ID` arrives from the client and is used to build a query. Treat it as untrusted input: validate its shape and parameterize the lookup. A handler that interpolates it into a query has the same problem a controller would — see [SQL injection](../nestjs-security/sql-injection.md).
:::

## Authentication

The browser's `EventSource` **cannot set request headers**. That leaves three options, in descending order of preference:

1. **A cookie.** SSE is a normal `GET`, so a `HttpOnly; Secure; SameSite` session cookie is sent automatically with `new EventSource(url, { withCredentials: true })`. This is the only option that keeps the credential out of URLs and logs.
2. **A short-lived, single-purpose token in the query string.** Acceptable only if you accept that it will appear in access logs, proxy logs and `Referer` headers. Mint it for this stream, scope it to this stream, and expire it in minutes.
3. **`fetch()` with a streaming reader instead of `EventSource`.** You can set headers, but you have written your own reconnect logic and given up the one thing SSE was giving you for free.

Guards run on an `@Sse()` handler exactly as on any other route, so authorization itself is ordinary. It is only the credential's transport that is constrained.

## The six-connection limit

This one surprises people in production and never in development.

Over **HTTP/1.1**, browsers allow about **six concurrent connections per origin**. An SSE stream holds one open indefinitely. Open the app in three tabs and half your connection budget is gone; open a fourth and ordinary API requests to the same origin **queue behind the streams and appear to hang**.

Three mitigations, in order:

- **Serve over HTTP/2 or HTTP/3.** Streams are multiplexed over one connection and the limit effectively disappears. This is the real fix, and it is usually a load-balancer setting rather than an application change.
- **One stream per tab, not per component.** Multiplex your event types onto a single `@Sse()` endpoint and fan out on the client with `addEventListener(type, …)`. That is what the `type` field is for.
- **Share one connection between tabs** with a `SharedWorker` or a leader election over `BroadcastChannel`, if you cannot do the first two.

## Proxies and buffering

The failure mode is unmistakable: nothing arrives for a long time, and then everything arrives at once when the stream closes. Something between you and the client is buffering.

| Hop | What to check |
| --- | --- |
| nginx | `proxy_buffering off;` for the location, or rely on the `X-Accel-Buffering: no` Nest already sends. Also raise `proxy_read_timeout` — the default will cut an idle stream |
| Compression middleware | gzip buffers to fill a block. Exclude `text/event-stream`, or disable compression on the route |
| CDN / edge proxy | most will not stream a response they think they can cache. Bypass the cache for the path, and confirm it rather than assume it |
| API gateway / serverless | many enforce a hard response timeout — often 30 or 60 seconds — and some do not stream at all. Check before you design around SSE |

:::warning
Response compression is the one that hurts most, because it is usually enabled globally and looks unrelated. `Cache-Control: no-transform` asks intermediaries not to re-encode, and Nest sends it — but a compression middleware inside your own application runs before any of that matters. Exclude `text/event-stream` explicitly. [Compression](../express-libraries/compression.md) has the mechanics.
:::

## Operational limits

An SSE endpoint is a way for clients to hold your server's resources open. Budget for it deliberately:

- **Every open stream is a socket, an event-loop subscription and whatever your observable holds.** Multiply by your peak concurrent users, not your request rate.
- **Cap concurrent streams per user.** Rate limiting by request count does not help — this is one request that lasts an hour. Count open streams instead; see [Rate limiting and abuse](../nestjs-security/rate-limiting.md).
- **Set an explicit maximum stream lifetime.** Completing the observable after, say, an hour makes the client reconnect and re-authenticate, which is also your revocation story.
- **Close streams on shutdown.** A rolling deploy that drops thousands of streams produces a synchronized reconnect. Stagger it with `retry` and a jitter, and see [Graceful shutdown](../nestjs-production/graceful-shutdown.md).
- **Multiple replicas need a shared source.** An observable fed by an in-process emitter only sees events raised on that instance — exactly the problem described in [WebSockets](websockets.md). Feed it from Redis pub/sub or your database.

## Common mistakes

- **Returning a promise or a value instead of an `Observable`.** The handler throws a `ReferenceError`.
- **Reaching for WebSockets for one-way data.** You pay for sticky sessions, an adapter and reconnect logic and use none of it.
- **No heartbeat.** Idle proxies close the connection, and you get a reconnect on every quiet minute.
- **Relying on the auto-assigned `id` for resumption.** It is a per-connection counter and restarts on reconnect. Emit a cursor into your own data.
- **Trusting `Last-Event-ID`.** It is client input that becomes a query parameter. Validate and parameterize it.
- **Trying to set an `Authorization` header from `EventSource`.** You cannot. Use a cookie, or accept a scoped token in the URL and its logging consequences.
- **One stream per UI component.** Six connections per origin over HTTP/1.1 and then your normal requests queue. Multiplex on `type`.
- **Leaving global compression on.** It buffers the stream and the symptom looks like a server bug.
- **Allocating resources before returning the observable without `@SseSignal()`.** A client that disconnects during setup leaks them every time.
- **Rate limiting by request count.** One stream is one request. Limit concurrent streams per user instead.
- **Streams with no maximum lifetime.** Connections accumulate, and a revoked session keeps receiving data until the process restarts.
- **An in-process event source behind more than one replica.** Clients only see events raised on the instance they landed on.

## Related topics

- [WebSockets](websockets.md) — the bidirectional alternative, and what it costs.
- [Routing and path syntax](../nestjs/routing-and-path-syntax.md) — the path grammar `@Sse()` shares with `@Get()`.
- [The request lifecycle](../nestjs/request-lifecycle.md) — where guards and interceptors sit relative to the stream.
- [Guards](../nestjs-request-handling/guards.md) — authorizing a stream, which is ordinary; only the credential's transport is not.
- [Rate limiting and abuse](../nestjs-security/rate-limiting.md) — why counting requests misses long-lived connections.
- [SQL injection](../nestjs-security/sql-injection.md) — `Last-Event-ID` is untrusted input.
- [Compression](../express-libraries/compression.md) — the middleware that silently buffers your stream.
- [Graceful shutdown](../nestjs-production/graceful-shutdown.md) — closing streams instead of dropping them.
- [Redis](../nestjs-databases/redis.md) — the shared source a multi-replica stream needs.
- [Streams and buffers](../node/streams-and-buffers.md) — what the transform underneath is actually doing.
- [Events](../nestjs-libraries/event-emitter.md) — the in-process source most SSE endpoints start out reading from.
