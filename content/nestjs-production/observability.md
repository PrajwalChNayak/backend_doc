---
title: Observability
description: Structured logs with nestjs-pino, correlation ids through AsyncLocalStorage, the metrics a Nest service actually needs, OpenTelemetry tracing, and an honest look at the pre-1.0 @nestjs/observe.
status: current
updated: 2026-09-11
---

Three signals, and Nest changes how you wire each of them rather than what they are. Logs go through the framework's `LoggerService` so that Nest's own bootstrap lines land in the same stream as yours; correlation ids want `AsyncLocalStorage` rather than a request-scoped provider; and tracing has to be loaded before the module graph exists. The general material — what each signal is for, cardinality, alerting on symptoms, SLOs — is in [Observability](../production/observability.md) and is unchanged. This page is the Nest wiring.

## Structured logging

Nest's default logger writes colored, human-shaped lines. That is right for a terminal and wrong for anything that ingests logs, because an interpolated string cannot be filtered, counted or aggregated. You have two reasonable options and they are not equally sized.

### `nestjs-pino`, when you want one stream for everything

`nestjs-pino` 5.1.0 (peers: `pino` ^10, `pino-http` ^11) replaces Nest's logger *and* installs `pino-http` as request logging, so framework lines, your lines and access lines are one JSON stream.

```ts title="src/logger/logger.module.ts"
import { Module } from '@nestjs/common'
import { LoggerModule } from 'nestjs-pino'
import { randomUUID } from 'node:crypto'

@Module({
  imports: [
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.LOG_LEVEL ?? 'info',

        // Fields that let you correlate a line back to a deploy.
        base: {
          service: 'api',
          env: process.env.APP_ENV ?? 'local',
          version: process.env.GIT_SHA ?? 'dev',
        },

        // Honour an id from the edge so the trail crosses services.
        genReqId: (req, res) => {
          const existing = req.headers['x-request-id']
          const id = typeof existing === 'string' ? existing : randomUUID()
          res.setHeader('x-request-id', id)
          return id
        },

        // Probes would otherwise be 95% of your log volume.
        autoLogging: {
          ignore: (req) => req.url === '/livez' || req.url === '/readyz',
        },

        // 4xx is the client's problem; 5xx is yours.
        customLogLevel: (req, res, err) => {
          if (err || res.statusCode >= 500) return 'error'
          if (res.statusCode >= 400) return 'warn'
          return 'info'
        },

        // A safety net, not a policy. See "Security considerations".
        redact: {
          paths: [
            'req.headers.authorization',
            'req.headers.cookie',
            'res.headers["set-cookie"]',
            'req.body.password',
            'req.body.token',
            '*.password',
          ],
          censor: '[redacted]',
        },
      },
    }),
  ],
})
export class AppLoggerModule {}
```

```ts title="src/main.ts"
import { NestFactory } from '@nestjs/core'
import { Logger } from 'nestjs-pino'
import { AppModule } from './app.module.js'

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    // Hold Nest's own bootstrap lines until the real logger is installed,
    // then replay them through it. Without this the first lines of every
    // boot are in a different format from everything after.
    bufferLogs: true,
    forceCloseConnections: true,
  })

  app.useLogger(app.get(Logger))
  app.enableShutdownHooks()
  await app.listen(process.env.PORT ?? 3000)
}

bootstrap()
```

`bufferLogs: true` plus `app.useLogger()` is the pair that matters. Skip it and the module-initialization lines — including the ones naming a provider that failed to resolve — go to the default console logger in a different shape, which is exactly when you least want two formats.

### The built-in `ConsoleLogger`, when you want no dependency

Nest 12's `ConsoleLogger` can emit JSON, which is enough for a service that does not need `pino-http`'s access logging.

```ts title="src/main.ts — JSON console logging"
import { ConsoleLogger } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module.js'

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: new ConsoleLogger({
      json: true,
      // A trailing plain object is treated as structured params.
      // structuredParams defaults to true; flattenParams (default false)
      // spreads them into the root object instead of nesting under `params`.
      structuredParams: true,
      flattenParams: false,
    }),
  })

  await app.listen(3000)
}

bootstrap()
```

That is a real v12 capability and it is genuinely enough for a small service. It does not give you `pino`'s throughput, its redaction engine, or request logging — so for anything with meaningful traffic, `nestjs-pino` is the better default.

### Rules that hold either way

- **Write JSON to stdout and stop.** The platform collects stdout. An application that writes files, rotates them and ships them is duplicating the platform's job and will get it wrong. Inside a container a log file is ephemeral anyway.
- **`pino-pretty` 13.1.3 is a devDependency.** Pipe to it locally; never run it in production, where it spends CPU producing a format nothing parses.
- **Log a failure once, at the boundary.** An exception filter is the right boundary in Nest. Logging the same failure in the repository, the service *and* the filter produces three lines that look like three problems. See [Exception filters](../nestjs-request-handling/exception-filters.md).
- **Levels mean something.** `error` is "a human should look at this". If it fires a thousand times an hour it is not an error and people will stop reading it.

## Correlation ids with `AsyncLocalStorage`

A single Nest request passes through a guard, an interceptor, a pipe, a controller, two services and a repository. Without a shared identifier those lines are unrelatable, and under concurrency they are interleaved with fifty other requests.

The tempting Nest answer is a `Scope.REQUEST` provider holding the id. Do not: scope bubbles up, and everything that injects it — up to and including the controller — is then rebuilt on every request. [Performance](performance.md) has the measurement; the correct tool is `AsyncLocalStorage`, which follows the async chain through every `await` without touching the DI graph.

```ts title="src/context/request-context.service.ts"
import { Injectable } from '@nestjs/common'
import { AsyncLocalStorage } from 'node:async_hooks'

export interface RequestStore {
  requestId: string
  userId?: string
  tenantId?: string
}

// An ordinary singleton. Nothing downstream becomes request-scoped.
@Injectable()
export class RequestContextService {
  private readonly storage = new AsyncLocalStorage<RequestStore>()

  run<T>(store: RequestStore, callback: () => T): T {
    return this.storage.run(store, callback)
  }

  get(): RequestStore | undefined {
    return this.storage.getStore()
  }

  set<K extends keyof RequestStore>(key: K, value: RequestStore[K]) {
    const store = this.storage.getStore()
    if (store) store[key] = value
  }
}
```

```ts title="src/context/request-context.middleware.ts"
import { Injectable, NestMiddleware } from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import type { Request, Response, NextFunction } from 'express'
import { RequestContextService } from './request-context.service.js'

@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  private readonly context: RequestContextService

  constructor(context: RequestContextService) {
    this.context = context
  }

  use(req: Request, res: Response, next: NextFunction) {
    const inbound = req.headers['x-request-id']
    const requestId = typeof inbound === 'string' ? inbound : randomUUID()
    res.setHeader('x-request-id', requestId)

    // Everything downstream — guards, interceptors, services, repositories —
    // runs inside this store.
    this.context.run({ requestId }, () => next())
  }
}
```

Register it first, before anything else that logs:

```ts title="src/app.module.ts"
import { Module, MiddlewareConsumer, NestModule } from '@nestjs/common'
import { RequestContextMiddleware } from './context/request-context.middleware.js'

@Module({})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RequestContextMiddleware).forRoutes('{*path}')
  }
}
```

Then any provider, at any depth, attaches the id without a parameter passing through six signatures:

```ts title="src/orders/orders.service.ts"
import { Injectable, Logger } from '@nestjs/common'
import { RequestContextService } from '../context/request-context.service.js'

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name)
  private readonly context: RequestContextService

  constructor(context: RequestContextService) {
    this.context = context
  }

  place(sku: string, quantity: number) {
    const { requestId } = this.context.get() ?? { requestId: 'none' }
    this.logger.log(`placing order sku=${sku} qty=${quantity} req=${requestId}`)
  }
}
```

:::warning
`AsyncLocalStorage` follows the async chain, not the calendar. Work that escapes the request — a `@Cron` job, a BullMQ consumer, an `onApplicationBootstrap` hook, an event-emitter listener — has no store, which is why every read needs a fallback.

For background work, open a **fresh** context with its own id (the job id) rather than reaching for a request's. A cron that logs `requestId: none` forever is a cron whose failures you cannot trace.
:::

:::best-practice
Propagate the id outbound. Send `x-request-id` — or the W3C `traceparent` header if you are using OpenTelemetry — on every call your service makes, and accept it on every call it receives. One id spanning your whole stack is worth more than any dashboard.
:::

## Metrics

Two frameworks, used together: **RED** (Rate, Errors, Duration) for the request path, and **USE** (Utilization, Saturation, Errors) for resources — your event loop, your connection pool, your heap.

| Metric | Type | Why it earns its place in a Nest service |
| --- | --- | --- |
| Request rate by **route pattern** and method | counter | the denominator for everything else |
| Error rate by route pattern and status class | counter | 4xx is clients misbehaving, 5xx is you |
| Latency p50/p95/p99 by route pattern | histogram | the distribution is the signal; never average a latency |
| **Event-loop delay** | histogram | Node's true saturation metric; nothing else says the process is CPU-bound |
| Connection-pool in-use and waiting counts | gauge | predicts the outage before latency moves |
| Outbound dependency duration and errors | histogram + counter | turns "we are slow" into "the payment provider is slow" |
| Queue depth **and oldest-job age** | gauge | depth alone is ambiguous; age is not |
| Provider-instantiation count, if you use `REQUEST` scope | counter | the cheapest way to notice scope has bubbled somewhere new |
| Business events — signups, orders, payments | counter | nobody notices a 500 faster than an order rate hitting zero |

:::danger
**Use the route pattern, never the resolved path.** `/users/:id` is one time series; `/users/8f3c…` is one time series *per user*, and unbounded label cardinality is the classic way to take a metrics backend down — always at peak traffic.

In Nest the pattern is available on the Express request as `req.route?.path` inside an interceptor, and from the `Reflector` via the handler's path metadata. Whichever you use, assert that the label set is bounded before you ship it.
:::

An interceptor is the natural place to record RED metrics, because it sees every handler:

```ts title="src/metrics/metrics.interceptor.ts"
import { Injectable, NestInterceptor, ExecutionContext, CallHandler } from '@nestjs/common'
import { Observable, tap } from 'rxjs'
import type { Request } from 'express'
import { MetricsService } from './metrics.service.js'

@Injectable()
export class MetricsInterceptor implements NestInterceptor {
  private readonly metrics: MetricsService

  constructor(metrics: MetricsService) {
    this.metrics = metrics
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp()
    const request = http.getRequest<Request>()
    // The PATTERN, not request.url. Bounded cardinality.
    const route = request.route?.path ?? 'unmatched'
    const startedAt = process.hrtime.bigint()

    const record = () => {
      const ms = Number(process.hrtime.bigint() - startedAt) / 1e6
      this.metrics.observeRequest(request.method, route, http.getResponse().statusCode, ms)
    }

    // Both paths, so a thrown exception is still counted.
    return next.handle().pipe(tap({ next: record, error: record }))
  }
}
```

:::deprecated
`prom-client` is **deprecated on npm** in favour of `@prometheus-io/client`. It still works and is widely deployed, but new projects should use the successor package and existing ones should plan the move. Check the registry for the current version before pinning either.
:::

Whatever client you use: expose `/metrics` on a separate port or behind authentication — it reveals your route table, your traffic volume and your error rates — and exclude the probe paths from request metrics, or they dominate your rate graph.

## Tracing with OpenTelemetry

A trace is a tree of spans across service boundaries: 12 ms in a guard, 340 ms in a query, 2 ms serializing. In a system with more than one service it is the only signal that answers "where did the time go" without guessing.

The Nest-specific constraint is **load order**. Auto-instrumentation works by patching modules as they are loaded, so the SDK must start before `@nestjs/core`, Express, `pg` or anything else is imported. Importing it from inside `main.ts` after your other imports is too late, and it fails silently — you get a running SDK and no spans.

```ts title="src/tracing.ts — loaded before the application"
import { NodeSDK } from '@opentelemetry/sdk-node'
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node'

const sdk = new NodeSDK({
  instrumentations: [getNodeAutoInstrumentations()],
})

sdk.start()
```

```bash
# --import runs the module first, before dist/main.js is evaluated.
node --import ./dist/tracing.js dist/main.js
```

```dockerfile
CMD ["node", "--import", "./dist/tracing.js", "dist/main.js"]
```

:::note
The `@opentelemetry/*` packages version independently of each other and move quickly, and their versions were **not** verified in this site's fact-checking pass. Check the registry for the current release of `@opentelemetry/sdk-node` and its matching auto-instrumentation package before pinning, and read their setup guide — exporter configuration in particular changes between majors.
:::

Two more things to get right:

- **Sample.** Tracing every request at scale is expensive and mostly redundant. Head sampling at a low percentage plus tail sampling that keeps every error and every slow request gives you the interesting traces at a fraction of the cost.
- **Correlate the signals.** Put the trace id into every log line — with the `AsyncLocalStorage` pattern above, that is one more field on the store — so you can jump from a slow trace to that request's logs. Without it you have three tools that each know something and cannot introduce you.

## `@nestjs/observe`

`@nestjs/observe` is the first-party observability SDK, and it is **0.1.8** — pre-1.0. Treat it accordingly.

Instrumentation is opt-in through the **`instrument` application option**, which lives on `NestApplicationContextOptions` and is therefore accepted by `NestFactory.create()`. Read from the shipped `@nestjs/common@12.0.1` declarations, it takes exactly one field:

```ts title="the relevant slice of NestApplicationContextOptions"
interface InstrumentOption {
  instrument?: {
    // Decorates every instance the application context creates.
    instanceDecorator: (instance: unknown) => unknown
  }
}
```

That is the whole mechanism, and it explains the design: Nest hands each provider it constructs to your function, and an observability SDK returns a wrapped instance whose methods are traced. It is a general-purpose hook, not an `@nestjs/observe` API — anything can supply the decorator.

```ts title="src/main.ts"
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module.js'
import { instanceDecorator } from './observability/instrumentation.js'

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    // Opt-in. Without this option nothing is instrumented.
    instrument: { instanceDecorator },
  })

  app.enableShutdownHooks()
  await app.listen(3000)
}

bootstrap()
```

`@nestjs/observe` exports `createInstanceDecorator` — a factory the module uses to produce exactly that function — plus `createObserveModule`, a `TracerService`, a `TraceSpanDelegate` and a custom-metrics surface. It requires an `appKey`, an `appSecret` and a `serviceId`, and it posts to a hosted collector whose endpoint is overridable through an option and the `OBSERVE_ENDPOINT` environment variable. The concrete module wiring is in [Observability with @nestjs/observe](../nestjs-libraries/observe.md).

:::warning
`instanceDecorator` runs for **every instance the container creates**. For singletons that is once each, at bootstrap, and costs nothing at request time. If your application has `Scope.REQUEST` providers it runs per request, per instance, on top of the construction cost those already carry — which is one more reason to keep request scope out of hot paths. See [Performance](performance.md).
:::

Three honest caveats before you adopt it:

- **It is pre-1.0.** A `0.x` version carries no compatibility promise. Expect option names and exports to move.
- **It exports no decorators.** There is no `@Trace()`, no `@Span()`, no `@Metric()` in 0.1.8 — `createInstanceDecorator` is a factory the module calls, not something you apply to a class. Instrumentation you add by hand goes through the tracer service.
- **The wire contract to its collector is not a published specification.** The endpoint is configurable, which is not the same as it being OTLP-compatible. Do not plan on pointing it at your existing collector until that is confirmed.

:::best-practice
For a service you are operating today, OpenTelemetry plus `nestjs-pino` plus a Prometheus-compatible client is the combination with no version risk and a portable data model. Adopt `@nestjs/observe` when you want its hosted product and can absorb a pre-1.0 dependency — not as the default observability stack for a production service.
:::

## Flush the logger before the process exits

pino's asynchronous transports buffer, and process exit does not wait for pending I/O. The lines explaining a shutdown are therefore exactly the ones you lose.

Flush in `onApplicationShutdown`, which runs last:

```ts title="src/logger/logger.flush.ts"
import { Injectable, Logger } from '@nestjs/common'
import type { OnApplicationShutdown } from '@nestjs/common'
import type { Logger as PinoInstance } from 'pino'

@Injectable()
export class LoggerFlush implements OnApplicationShutdown {
  private readonly pino: PinoInstance

  constructor(pino: PinoInstance) {
    this.pino = pino
  }

  onApplicationShutdown(signal?: string) {
    Logger.log(`flushing logs (${signal ?? 'no signal'})`, 'Shutdown')
    this.pino.flush()
  }
}
```

The same applies to a metrics push and a trace exporter: give each a bounded shutdown window inside your grace period. See [Graceful shutdown](graceful-shutdown.md).

## Security considerations

- **Redact at the source, and again on the way out.** pino's `redact` is a net; the policy is not putting the value in the log in the first place. See [Safe logging](../nestjs-security/safe-logging.md).
- **Never log a DTO wholesale.** A `LoggingInterceptor` that logs `request.body` on every call will eventually log a password, a card number or a reset token — and validation runs *after* some middleware, so the raw body is what you would capture.
- **Authorization headers and cookies never get logged.** A logged bearer token is a working credential sitting in a log store with a far wider audience than your secret store.
- **`/metrics` is reconnaissance.** Route names, traffic volumes and error rates. Bind it to an internal port or require authentication.
- **Trace attributes leak too.** Auto-instrumentation can attach query parameters and, depending on configuration, statement text. Review what your exporter actually sends before pointing it at a vendor.
- **Log security events deliberately** — failed logins, authorization denials, rate-limit trips, token rejections — with enough context to investigate and no credential material.
- **A newline in user-controlled text can forge a log entry** in a line-oriented format. JSON output escapes it; plain text does not. That is one more argument for `json: true`.
- **Do not log the resolved configuration object.** `DATABASE_URL` contains a password. See [Environment configuration](configuration.md).

## Common mistakes

- **Leaving Nest's default colored logger in production.** Interpolated strings cannot be filtered, counted or aggregated.
- **Installing `nestjs-pino` without `bufferLogs` and `app.useLogger()`.** Bootstrap lines — including the provider-resolution failures — come out in a different format.
- **A `Scope.REQUEST` provider for the correlation id.** Scope bubbles up and the whole subtree is rebuilt per request. Use `AsyncLocalStorage`.
- **Reading the store in a cron or a queue consumer.** There is no store there; open a fresh context with the job id.
- **Not propagating the id outbound.** The trail stops at your service boundary.
- **Logging the probe endpoints.** 86,400 identical lines per replica per day.
- **Logging a failure in the service *and* the filter.** One problem, three lines, three investigations.
- **Averaging latency.** The mean hides the tail, and the tail is the user experience.
- **The resolved path as a metric label.** Unbounded cardinality; use the route pattern.
- **Loading the OpenTelemetry SDK from inside `main.ts`.** Auto-instrumentation patches at import time; too late is the same as not at all, and it fails silently.
- **Tracing 100% of requests at scale.** Expensive and mostly redundant. Sample, keeping errors and slow requests.
- **Adopting `@nestjs/observe` 0.1.8 as the production default.** It is pre-1.0, exports no decorators, and its collector contract is not a published specification.
- **`pino-pretty` in production.** CPU spent producing a format no aggregator parses.
- **Writing log files inside a container.** Ephemeral, and it competes with the platform's collector.
- **Exiting without flushing.** You lose the lines describing the shutdown.
- **Not measuring event-loop delay.** Without it you cannot distinguish "CPU-bound" from "the database is slow", and the fixes are opposite.

## Related topics

- [Observability](../production/observability.md) — the three signals, alerting on symptoms, SLOs and error budgets.
- [Observability with @nestjs/observe](../nestjs-libraries/observe.md) — the package's module wiring and exports in detail.
- [Logging](../nestjs-libraries/logging.md) — `nestjs-pino` and `ConsoleLogger` configuration in depth.
- [Safe logging](../nestjs-security/safe-logging.md) — redaction, and what must never be logged.
- [Injection scopes](../nestjs/injection-scopes.md) — why the correlation id is not a request-scoped provider.
- [Performance](performance.md) — acting on event-loop delay and pool saturation once you can see them.
- [Health and readiness probes](health-and-readiness-probes.md) — probes versus dependency monitoring.
- [Graceful shutdown](graceful-shutdown.md) — flushing logs and exporters before exit.
- [Exception filters](../nestjs-request-handling/exception-filters.md) — the boundary where a failure is logged once.
- [Interceptors](../nestjs-request-handling/interceptors.md) — where RED metrics are recorded.
- [Clustering](clustering.md) — giving each worker an identity in logs and metrics.
- [Environment configuration](configuration.md) — logging the safe config view at boot.
- [Deployment checklist](deployment-checklist.md) — the observability items to verify before shipping.
