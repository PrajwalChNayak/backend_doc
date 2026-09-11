---
title: Observability with @nestjs/observe
description: What @nestjs/observe 0.1.8 actually is — a pre-1.0 first-party APM agent wired in through the instrument application option — with its verified module API, TracerService, custom metrics and the honest limits of a 0.1.x package.
status: current
updated: 2026-09-11
---

`@nestjs/observe` is the Nest team's own application-performance-monitoring agent: it instruments every provider in the container, produces traces for HTTP, GraphQL, RPC, BullMQ and scheduled handlers, samples runtime metrics, and ships all of it to a collector from a detached worker thread. It is also version **0.1.8** — pre-1.0, published recently, and not yet something to bet an incident response process on. This page documents what is in the package and says where the edges are.

:::warning It is 0.1.8
A 0.1.x version number is a statement about stability, not modesty. Options can be renamed, defaults can change, and the wire format is not a published specification. Pin the exact version, read the changelog before bumping, and keep whatever observability you already trust running alongside it until it reaches 1.0. Everything below was read out of the published `.d.ts` and `.js` files of 0.1.8; the authority for anything newer is [the official documentation](https://docs.nestjs.com).
:::

## What it covers

| Signal | Source |
| --- | --- |
| Traces | HTTP requests, GraphQL operations, microservice (RPC) and gRPC handlers, BullMQ jobs, `@Cron` / `@Interval` / `@Timeout` handlers |
| Spans inside a request | every method on every instrumented provider, plus spans you open yourself |
| Errors | captured with tags, and optionally with the source lines around each in-app stack frame |
| Runtime metrics | memory, CPU load, GC and event-loop latency, sampled on an interval |
| Custom metrics | counters, gauges and summaries you define |
| Logs | forwarded and correlated with traces, off by default |

The protocol integrations are **optional peer dependencies** — `@nestjs/microservices`, `@nestjs/graphql`, `@nestjs/bullmq` with `bullmq`, and `@nestjs/schedule`. Each is loaded only if you have it, so an HTTP-only service installs nothing extra.

## How it hooks in

This is the part worth understanding, because it is unlike every other `@nestjs/*` package.

A dynamic module alone cannot wrap the methods of providers it did not create. So the agent needs a hook that runs as each instance is constructed, and NestJS 12 adds exactly one: the **`instrument`** option on `NestApplicationContextOptions`, which is inherited by `NestApplicationOptions`.

```ts
// The verified shape of the option, from @nestjs/common 12.0.1:
// instrument?: { instanceDecorator: (instance: unknown) => unknown }
```

`createObserveModule()` returns both halves at once — the module you import, and the instrument you pass to `NestFactory`:

```ts title="src/observe.ts"
import { createObserveModule } from '@nestjs/observe'

export const { ObserveModule, ObserveInstrument } = createObserveModule()
```

```ts title="src/main.ts"
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module.js'
import { ObserveInstrument } from './observe.js'

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    instrument: ObserveInstrument,
  })

  await app.listen(3000)
}

bootstrap()
```

```ts title="src/app.module.ts"
import { Module } from '@nestjs/common'
import { ConfigModule, ConfigService } from '@nestjs/config'
import { ObserveModule } from './observe.js'

@Module({
  imports: [
    ObserveModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        appKey: config.getOrThrow<string>('OBSERVE_APP_KEY'),
        appSecret: config.getOrThrow<string>('OBSERVE_APP_SECRET'),
        serviceId: config.getOrThrow<string>('OBSERVE_SERVICE_ID'),
        serviceVersion: config.get<string>('GIT_SHA'),
      }),
    }),
  ],
})
export class AppModule {}
```

Both halves are required. The module without the instrument gives you `TracerService` and nothing automatic; the instrument without the module has no options to run with.

`forRoot()` takes the same options statically and registers the module as **global**. `forRootAsync()` also defaults to global and accepts `useFactory`, `useClass` and `useExisting` — the class form implements `ObserveOptionsFactory`, whose single method is `createObserveOptions()`. Pass `global: false` if you would rather import it explicitly, with the trade-off described in [Modules](../nestjs/modules.md).

### Two option objects, not one

The split is easy to get wrong: `createObserveModule()` and `forRoot()` take **different** option types.

| Passed to | Type | What lives there |
| --- | --- | --- |
| `createObserveModule(...)` | `CreateObserveModuleOptions` | `traceIdKey`, `traceIdGenerator`, `attachTraceIdToLogs`, `skipInstrumentation`, `sourceContext` |
| `ObserveModule.forRoot(...)` | `ObserveOptions` | credentials, `endpoint`, `serviceId`, sampling, batching, `forwardLogs`, `redaction`, and the per-protocol blocks |

The first group is needed before the container exists, because it shapes the instance decorator itself. The second is ordinary configuration and can come from `ConfigService`.

```ts title="src/observe.ts"
import { createObserveModule } from '@nestjs/observe'
import { randomUUID } from 'node:crypto'

export const { ObserveModule, ObserveInstrument } = createObserveModule({
  traceIdKey: 'traceId',
  attachTraceIdToLogs: true,
  sourceContext: false,
  traceIdGenerator: (req: any) => {
    const inbound = req?.headers?.['x-request-id']
    return typeof inbound === 'string' && /^[\w-]{1,64}$/.test(inbound) ? inbound : randomUUID()
  },
})
```

| Option | Default | Notes |
| --- | --- | --- |
| `traceIdKey` | `'traceId'` | Key the trace id is stored under in the async context |
| `traceIdGenerator` | `x-request-id` header, else a random UUID | Receives the request for HTTP; for other protocols there may be no request object |
| `attachTraceIdToLogs` | `true` | Augments `ConsoleLogger` so log lines carry the trace id |
| `skipInstrumentation` | `() => false` | Return `true` for an instance that must not be proxied |
| `sourceContext` | `true` | Attach source lines around in-app stack frames to captured errors |

`skipInstrumentation` is not an optimization knob. Some libraries register proxy providers that throw on any property access outside their own context; the agent already skips instances whose inspection throws, and this hook is how you exclude anything else by hand.

## Credentials and the collector

`appKey` and `appSecret` are issued together by the hosted service at [observe.nestjs.com](https://observe.nestjs.com) and sent as `x-api-key` and `x-api-secret` on every ingest request. Without valid credentials the collector answers **401** and the batch is dropped — silently, as far as your application is concerned.

`endpoint` defaults to `https://observe-api.nestjs.com` and can be overridden in code or by setting `OBSERVE_ENDPOINT` in the environment, which is the usual way to point a local or self-hosted collector at yourself.

:::note What is not documented here
The ingest wire format is not a published specification, so "point `endpoint` at your own collector" is a statement about the option existing, not a claim that an OTLP endpoint will work. Plans, retention and dashboard features live with the service, not the package, and are deliberately out of scope for this page.
:::

## The options that matter

Read from `ObserveOptions` in 0.1.8.

| Option | Default | What it controls |
| --- | --- | --- |
| `appKey`, `appSecret` | — | Required. Ingest credentials. |
| `serviceId` | — | Required. Identifies this service; use a hostname or container id when you run replicas. |
| `serviceVersion` | — | A semver string or a commit SHA, for comparing releases. |
| `endpoint` | hosted collector | Base URL for telemetry. |
| `flushInterval` | `5000` ms | How often buffered traces are submitted. |
| `tracesSampleRate` | `1.0` | A number, or a function `(protocol, attributes) => boolean` for per-request decisions. |
| `maxTracesPerBatch` | `1000` | Upper bound on one submission. |
| `runtimeMetrics` | `true` | Memory, CPU, GC and event-loop gauges. |
| `runtimeMetricsInterval` | `60000` ms | Sampling interval for the above. |
| `forwardLogs` | `false` | Ship log lines to the collector, correlated with traces. |
| `redaction` | on when `forwardLogs` is on | How log lines are scrubbed before leaving the process. |
| `debug` | `false` | Extra agent diagnostics on the console. |
| `http`, `rpc`, `grpc`, `graphql`, `jobs` | — | Per-protocol `ignore` / `tags` / `setAttributes` / `getUserId` hooks. |

The per-protocol blocks are the ones you will actually reach for:

```ts title="src/app.module.ts"
import { Module } from '@nestjs/common'
import { ObserveModule } from './observe.js'

@Module({
  imports: [
    ObserveModule.forRoot({
      appKey: process.env.OBSERVE_APP_KEY as string,
      appSecret: process.env.OBSERVE_APP_SECRET as string,
      serviceId: 'orders-api',
      tracesSampleRate: 0.2,
      http: {
        ignore: [{ method: 'GET', path: '/healthz' }, /^\/readyz/],
        tags: { environment: process.env.NODE_ENV ?? 'development' },
        getUserId: (req: any) => req.user?.id,
      },
      jobs: {
        tags: { environment: process.env.NODE_ENV ?? 'development' },
      },
    }),
  ],
})
export class AppModule {}
```

`http.ignore` takes an array of strings, `{ method, path }` objects and regular expressions, or a single predicate function. `http.queryParamsObfuscateRegex` adds to a built-in list that already masks `token`, `password`, `code` and `signature`; it does not replace it.

For GraphQL the unit is one **operation**, not one resolver: `graphql.ignore` matching a field name skips the whole operation that field leads, because an operation is measured end to end. `graphql.getUserId` is consulted only for operations that are not already inside an HTTP trace — a query over HTTP takes its user id from `http.getUserId`. That distinction exists for subscriptions over a websocket.

## Tracing your own code

`TracerService` is exported by the module and injected like any provider.

```ts title="src/orders/orders.service.ts"
import { Injectable } from '@nestjs/common'
import { TracerService } from '@nestjs/observe'

@Injectable()
export class OrdersService {
  private readonly tracer: TracerService

  constructor(tracer: TracerService) {
    this.tracer = tracer
  }

  async place(orderId: string, userId: string) {
    return this.tracer.createSpan('orders.reserve-stock', async (span) => {
      span.setTag('orderId', orderId).addTags({ userId, channel: 'web' })
      return this.reserve(orderId)
    })
  }

  private async reserve(orderId: string) {
    return { orderId, reserved: true }
  }
}
```

The verified surface:

| Member | Signature | Use |
| --- | --- | --- |
| `createSpan` | `(name, callback) => Promise<any>` | Wrap a unit of work; the callback receives a `TraceSpanDelegate` |
| `activeSpan` | `() => Promise<TraceSpanDelegate>` | The current span — throws when there is none |
| `captureError` | `(error, tags?) => Promise<void>` | Attach a handled error to the current trace |
| `currentTraceId` | `() => string \| null` | The id to echo into a response header or a log line |
| `counter` / `gauge` / `summary` | `(name, attributes?)` | Custom metrics, below |
| `setAttribute` / `getAttribute` | typed by the store generic | Request-scoped values carried on the trace |

`TraceSpanDelegate` carries `id`, `name`, `setTag(key, value)` and `addTags(record)`; `setTag` and `addTags` both return the span, so they chain.

Because every provider method is already wrapped, `createSpan` is for *naming* work that does not correspond to a method — a loop iteration, a batch, a third-party call — not for adding spans you already get.

## Custom metrics

Three types, each obtained from `TracerService` by name. Asking for the same name twice returns the same instrument.

```ts title="src/billing/billing.service.ts"
import { Injectable } from '@nestjs/common'
import { TracerService } from '@nestjs/observe'

@Injectable()
export class BillingService {
  private readonly tracer: TracerService

  constructor(tracer: TracerService) {
    this.tracer = tracer
  }

  recordCharge(outcome: 'ok' | 'declined', latencyMs: number) {
    this.tracer
      .counter<'outcome'>('billing.charges', {
        description: 'Charge attempts',
        labels: ['outcome'],
      })
      .increment({ outcome })

    this.tracer
      .summary('billing.charge_latency_ms', { description: 'Charge latency' })
      .observe(latencyMs)
  }
}
```

| Type | Methods | For |
| --- | --- | --- |
| `Counter` | `increment()`, `increment(value)`, `increment(label)`, `increment(label, value)` | Monotonic totals: attempts, failures, messages handled |
| `Gauge` | `increment`, `decrement`, `setValue`, with `kind` of `'additive'`, `'ratio'` or `'peak'` | Values that go up and down: queue depth, open connections |
| `Summary` | `observe(value)`, `observe(value, label)`, exposing `p50`, `p95`, `p99`, `total`, `maximum` | Distributions: latency, payload size |

:::warning Labels are cardinality
Each distinct label combination is a separate time series, and the package caps a metric at **1000** series before it stops admitting new ones. A label whose value is a user id, an order id or a raw URL path will hit that cap and quietly stop recording. Label with bounded sets — an outcome, a route template, a queue name.
:::

## What the package does not do

Being precise about the gaps is more useful than a feature list.

- **There are no decorators.** No `@Trace()`, no `@Span()`, no `@Metric()`. The public exports are `createObserveModule`, `TracerService`, `TraceSpanDelegate`, the metric classes, the interfaces and constants, and a couple of type helpers. Instrumentation is automatic or explicit through `createSpan`, and nothing else.
- **Continuous profiling is shelved.** The package's own source says the sampler is not started and the collector's profile endpoints are unregistered; there is no `profiling` option on `ObserveOptions` to set. The implementation is present for a later return. Do not plan around flame graphs.
- **It is not OpenTelemetry.** It does not emit OTLP and it is not a drop-in for an existing OTel pipeline. If your organization has standardized on OTel collectors, this is a parallel system, not a replacement.
- **It is not a metrics scrape endpoint.** There is no `/metrics` route to point Prometheus at; metrics go to the collector.

## Security considerations

**`appSecret` is a password.** It is shown once when the pair is issued and cannot be retrieved afterwards. Supply it from the environment, validate it at boot, and never commit it — see [Secrets and config validation](../nestjs-security/secrets-and-config.md). If it leaks, issue a new pair from the dashboard.

**This is data egress by design.** Turning the agent on sends request metadata, error details, and — if you enable `forwardLogs` — log lines to a third party. That is a decision for whoever owns your data-processing agreements, not one to make in a pull request.

**`sourceContext` ships your source code.** It defaults to **`true`**, and it reads the lines around each in-app stack frame and attaches them to the captured error, where they are stored alongside it. Frames inside `node_modules` and Node internals are never read, but your own application source is. If shipping source fragments to a vendor is not acceptable, set `sourceContext: false` explicitly.

**Redaction is on by default with `forwardLogs`, and you should leave it on.** The built-in patterns cover bearer tokens, JWTs, AWS key ids, PEM private keys, `key=value` secrets and Luhn-valid card numbers, and the built-in key list is matched case-insensitively ignoring `-` and `_`. `redaction.patterns` and `redaction.keys` add to that; `useDefaultPatterns: false` replaces it wholesale and is almost never right. There is no configuration in which forwarding logs unredacted is a good idea.

**`getUserId` puts an identifier on every trace.** That is deliberate and useful, and it is also personal data in a third-party system. Use an opaque internal id, never an email address.

**`setAttributes` and `tags` are unfiltered.** Whatever you return is sent. `(req) => ({ 'user-agent': req.headers['user-agent'] })` is fine; returning the whole header object is a credential leak.

**Query strings are partially masked, not safe.** `queryParamsObfuscateRegex` and the built-in list cover well-known parameter names. A secret in a parameter only your application knows about is not covered until you add it — and a secret in a URL is a bad idea regardless, because it reaches proxy logs and browser history too. See [Safe logging](../nestjs-security/safe-logging.md).

**Ignore your health endpoints.** `http.ignore` on `/healthz` and `/readyz` keeps probe traffic — and the fact that your probes are unauthenticated — out of an external system.

## Production considerations

**Pin the exact version.** `@nestjs/observe@0.1.8`, not `^0.1.8`. On a 0.x line a minor bump is allowed to break, and this is a package that touches every provider in your container.

**Run it alongside what you already have, not instead of it.** Adopt it in a staging environment first, and keep your existing dashboards and alerts until you have watched a real incident through this one.

**Instrumentation wraps every provider.** A proxy on every instance and a span per method call is not free. Measure request latency and CPU with the agent on and off before you roll it out to every service — and use `skipInstrumentation` for hot, tiny providers where a span per call is pure overhead.

**Sample.** `tracesSampleRate: 1.0` at any real traffic level generates a great deal of data. Drop it for high-volume services, and use the function form to keep 100% of errors and slow paths while sampling the rest.

**`flushInterval` is a loss window.** Traces buffered for the default five seconds are gone if the process is killed. Shorter means more requests to the collector; longer means more loss. Leave it alone unless you have a reason.

**The agent works on a detached worker thread.** That is what keeps submission off the request path, and it also means an unreachable collector degrades quietly rather than throwing into your handlers. Turn `debug: true` on temporarily when you need to know whether data is actually arriving — a 401 from bad credentials looks exactly like "no data" from the outside.

**`serviceId` must distinguish replicas.** Use the hostname or container id, not a constant, or every instance's metrics merge into one series and per-instance problems become invisible.

**Runtime metrics answer a different question from traces.** They tell you whether a process was struggling; traces tell you what it was doing. Keep `runtimeMetrics` on — the 60-second default interval is cheap — and read them together.

**Correlate with your logs.** `attachTraceIdToLogs` puts the trace id on `ConsoleLogger` output; if you have replaced the logger with [nestjs-pino](logging.md), wire `tracer.currentTraceId()` into your own bindings instead, because the augmentation only applies to the built-in logger.

**Have a way to turn it off.** A feature flag or an environment variable that skips `ObserveModule` and the `instrument` option entirely is worth having in place before you need it. On a pre-1.0 dependency, "disable it and restart" should not require a code change.

## Common mistakes

- **Importing `ObserveModule` without passing `ObserveInstrument`.** No provider is wrapped, so nothing is traced automatically and only manual `createSpan` calls appear.
- **Passing `ObserveInstrument` without importing the module.** There are no options and no `TracerService`.
- **Calling `createObserveModule()` twice.** Import the one module and instrument from a single file; two of them means two instances of everything.
- **Putting `traceIdKey` or `sourceContext` in `forRoot()`.** They belong to `createObserveModule()`, and `forRoot()` ignores them.
- **Assuming there are decorators.** There are none. Use `createSpan`, or rely on the automatic instrumentation.
- **Planning on CPU profiles.** Profiling is shelved in 0.1.8 and there is no option to enable it.
- **A user id, an order id or a raw path as a metric label.** Unbounded cardinality; the series cap is reached and new values stop being recorded.
- **Leaving `tracesSampleRate` at `1.0` in a high-traffic service.** Volume, cost, and a collector you are hammering.
- **Enabling `forwardLogs` without reading the redaction defaults.** It is on by default, and that is the only reason this is not an immediate incident — do not switch `useDefaultPatterns` off.
- **Leaving `sourceContext` on without deciding to.** It sends fragments of your source to the collector; that should be a choice.
- **Treating a 401 as "no traffic yet".** Bad credentials drop the batch, and from the application side it looks identical to an idle service. Turn `debug` on to see it.
- **Using a caret range.** On 0.x, a minor release may break.

## Related topics

- [Logging](logging.md) — the log side of the same picture, and where trace ids belong in log lines.
- [Modules](../nestjs/modules.md) — what `forRoot()` registering itself globally costs you.
- [Dynamic modules](../nestjs-advanced/dynamic-modules.md) — the `forRoot` / `forRootAsync` pattern underneath.
- [Configuration](../nestjs/configuration.md) — validating `OBSERVE_APP_KEY` and friends at boot rather than discovering a 401 later.
- [Secrets and config validation](../nestjs-security/secrets-and-config.md) — where `appSecret` should live.
- [Safe logging](../nestjs-security/safe-logging.md) — what must never reach a forwarded log line.
- [Health checks with Terminus](terminus.md) — the endpoints worth adding to `http.ignore`.
- [Observability](../production/observability.md) — the framework-independent version: metrics, traces, logs and what each is for.
- [Scheduling](schedule.md) — the `@Cron` handlers the `jobs` block reports on.
- [Background jobs with BullMQ](bullmq.md) — the queue processors it instruments through its optional peer.
