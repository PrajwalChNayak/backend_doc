---
title: Logging
description: The built-in ConsoleLogger in NestJS 12 including the structuredParams change, custom LoggerService implementations, app.useLogger and bufferLogs, and nestjs-pino 5.1.0 with pino 10.3.1 for production.
status: current
updated: 2026-09-11
---

Nest ships a logger you can use immediately and replace without touching a single call site. `Logger` is the façade your code injects; `ConsoleLogger` is the implementation behind it; `app.useLogger()` swaps that implementation for something else. NestJS 12 changes one visible behaviour of the default implementation — a trailing plain object is now structured metadata rather than a second message — and that change is the first thing to understand before you configure anything.

## The two classes

| Class | What it is | Where it appears |
| --- | --- | --- |
| `Logger` | The façade. Holds a context string, delegates to whatever implementation is installed. | In your services: `new Logger(MyService.name)` |
| `ConsoleLogger` | The default `LoggerService` implementation. Formats and writes to `stdout`/`stderr`. | In `main.ts`, when you configure or subclass it |

Both come from `@nestjs/common` **12.0.1**. Nest's own bootstrap messages ("Nest application successfully started", route mappings, DI errors) go through the same pipeline, so replacing the logger replaces those too.

## Structured params — the v12 change

In NestJS 12, `ConsoleLogger` treats **a plain object passed after the message** as structured metadata attached to that log entry, instead of logging it as a separate message. The option is `structuredParams`, and it defaults to **`true`**.

```ts title="src/orders/orders.service.ts"
import { Injectable, Logger } from '@nestjs/common'

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name)

  place(orderId: string, userId: number) {
    this.logger.log('Order placed', { orderId, userId })
    return { orderId }
  }
}
```

With `json: true`, that produces one record:

```json
{
  "level": "log",
  "pid": 41233,
  "timestamp": 1789041600123,
  "message": "Order placed",
  "context": "OrdersService",
  "params": { "orderId": "o_9f1", "userId": 1 }
}
```

The rules, read from the shipped implementation rather than inferred:

- The **last argument, if it is a string**, is still the context. That has not changed, and it is why `this.logger.log('msg', 'MyContext')` keeps working.
- Every **plain object after the first argument** is pulled out as a param. Several objects are merged into one `params` object, left to right.
- Anything that is not a plain object — an array, an `Error`, a number — stays in the message list and is formatted as before.
- The JSON record's own fields are `level`, `pid`, `timestamp`, `message`, plus `context` and `stack` when present.

### `flattenParams`

`flattenParams` (default **`false`**) applies only in `json` mode. When enabled, params are spread into the root of the JSON object instead of nesting under `params`:

```ts title="src/logging/logger.ts"
import { ConsoleLogger } from '@nestjs/common'

export const logger = new ConsoleLogger({
  json: true,
  structuredParams: true,
  flattenParams: true,
})
```

```json
{
  "level": "log",
  "pid": 41233,
  "timestamp": 1789041600123,
  "message": "Order placed",
  "context": "OrdersService",
  "orderId": "o_9f1",
  "userId": 1
}
```

Flattening is what most log platforms want, because a field at the root is directly indexable while `params.orderId` needs a nested-field mapping. The framework's own keys win on a collision: a param named `message` or `level` is dropped rather than allowed to overwrite the real message or severity. That is a safety property, not a bug — but it does mean a field you thought you were logging can silently vanish, so do not name params after framework fields.

:::warning `flattenParams` requires `structuredParams`
It spreads params, and with `structuredParams: false` there are no params to spread. Setting `flattenParams: true` alone changes nothing.
:::

### Restoring the v11 behaviour

If you have log assertions, a parser, or a downstream pipeline built on "objects after the message are printed as separate messages", turn the extraction off:

```ts title="src/main.ts"
import { ConsoleLogger } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module.js'

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: new ConsoleLogger({ json: true, structuredParams: false }),
  })

  await app.listen(3000)
}

bootstrap()
```

Treat that as a migration aid with an end date. The v12 default is better: one record per event, with the metadata attached to it, is the shape every log platform is built to query.

## Configuring `ConsoleLogger`

`ConsoleLogger` takes a context string, an options object, or both. The options that matter in practice:

| Option | Default | Effect |
| --- | --- | --- |
| `logLevels` | all | Which levels are enabled — see the gotcha below |
| `json` | `false` | Emit one JSON object per line instead of the pretty format |
| `colors` | `true` unless `json` | ANSI colors |
| `timestamp` | `false` | Print the delta since the previous message (ignored in `json` mode) |
| `prefix` | `'Nest'` | Text in the leading tag (ignored in `json` mode) |
| `structuredParams` | **`true`** | Trailing plain objects become `params` |
| `flattenParams` | `false` | Spread `params` into the root JSON object |
| `forceConsole` | `false` | Use `console.log` instead of `process.stdout.write`, for test runners that capture the console |
| `depth`, `maxArrayLength`, `maxStringLength`, `sorted`, `compact`, `breakLength`, `showHidden` | see `util.inspect` | Formatting knobs, ignored in parseable JSON output |

```ts title="src/main.ts"
import { ConsoleLogger } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module.js'

const isProduction = process.env.NODE_ENV === 'production'

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    bufferLogs: true,
    logger: new ConsoleLogger({
      json: isProduction,
      colors: !isProduction,
      flattenParams: isProduction,
      logLevels: isProduction ? ['error', 'warn', 'log'] : ['error', 'warn', 'log', 'debug', 'verbose'],
    }),
  })

  await app.listen(3000)
}

bootstrap()
```

## Log levels

The six levels, lowest to highest: `verbose`, `debug`, `log`, `warn`, `error`, `fatal`.

:::warning `logLevels` is not an exact allow-list
A level is enabled when it appears in the array **or when it sits at or above the highest level in the array**. So `logLevels: ['warn']` also enables `error` and `fatal` — which is what you want, and is not what the array literally says. The practical consequence: to get "everything from `log` upwards", `['log']` is enough; listing `['error']` alone does *not* silence `fatal`.
:::

`logger: false` disables logging entirely, including Nest's bootstrap output. `logger: ['error', 'warn']` is shorthand for "default `ConsoleLogger`, these levels".

Which level to use is the same judgement as everywhere else, and the table in [Logging](../express-libraries/logging.md) applies unchanged. The one Nest-specific note: a rejected request that your `ValidationPipe` turned into a 400 is a `warn`, not an `error`. Nest's own exception filter logs unhandled exceptions at `error`, and if expected 4xx responses land there too, the signal is gone.

## Injecting `Logger` into a service

Two forms, and the difference matters.

```ts title="src/orders/orders.service.ts"
import { Injectable, Logger } from '@nestjs/common'

@Injectable()
export class OrdersService {
  // Not injected. Constructed directly, context set once.
  private readonly logger = new Logger(OrdersService.name)

  cancel(orderId: string) {
    this.logger.warn('Order cancelled', { orderId })
  }
}
```

```ts title="src/orders/orders.module.ts"
import { Logger, Module } from '@nestjs/common'
import { OrdersService } from './orders.service.js'

@Module({
  providers: [OrdersService, Logger],
})
export class OrdersModule {}
```

```ts title="src/orders/orders.service.ts"
import { Injectable, Logger } from '@nestjs/common'

@Injectable()
export class OrdersService {
  private readonly logger: Logger

  // Injected. Requires `Logger` in the module's providers, and lets a test
  // replace it with a mock through the testing module.
  constructor(logger: Logger) {
    this.logger = logger
    this.logger.setContext(OrdersService.name)
  }

  cancel(orderId: string) {
    this.logger.warn('Order cancelled', { orderId })
  }
}
```

Use the field form by default — it needs no wiring and the context is right. Reach for injection when a test needs to assert on log output, or when you want the logger's own dependencies resolved by the container.

Either way, `Logger` delegates to whatever implementation `useLogger()` installed, so neither form locks you to `ConsoleLogger`.

## Replacing the logger

`app.useLogger()` takes anything implementing `LoggerService`, and everything — your code and Nest's internals — routes through it from that moment on.

The problem is *that moment*. `NestFactory.create()` already logged the module graph before you get a chance to call `useLogger()`, and a logger that lives in the DI container does not exist until the container is built. `bufferLogs: true` solves both:

```ts title="src/main.ts"
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module.js'
import { AuditLogger } from './logging/audit-logger.service.js'

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true })
  app.useLogger(app.get(AuditLogger))

  await app.listen(3000)
}

bootstrap()
```

`bufferLogs: true` holds every log line produced during initialization instead of printing it. `autoFlushLogs` defaults to **`true`**, so the buffer is replayed through the logger you installed once initialization completes or fails. Set `autoFlushLogs: false` only if you want to call `app.flushLogs()` yourself at a specific point.

:::danger Without `bufferLogs`, a boot failure is invisible
With `bufferLogs: true` and `autoFlushLogs: false`, and no `flushLogs()` on the error path, a DI resolution error is buffered and then thrown away. The process exits with no explanation. Leave `autoFlushLogs` at its default unless you have a reason, and if you do turn it off, call `flushLogs()` in a `catch`.
:::

## Writing a `LoggerService`

`LoggerService` requires `log`, `error` and `warn`; `debug`, `verbose`, `fatal` and `setLogLevels` are optional. Extending `ConsoleLogger` is usually better than implementing the interface from scratch, because you inherit level filtering, JSON mode and param extraction:

```ts title="src/logging/audit-logger.service.ts"
import { ConsoleLogger, Injectable } from '@nestjs/common'
import { AuditSink } from './audit-sink.service.js'

@Injectable()
export class AuditLogger extends ConsoleLogger {
  private readonly sink: AuditSink

  constructor(sink: AuditSink) {
    super('App', { json: true, flattenParams: true })
    this.sink = sink
  }

  error(message: any, ...optionalParams: any[]): void {
    // Format and write exactly as ConsoleLogger would...
    super.error(message, ...optionalParams)

    // ...then mirror it to the audit trail, without ever letting that fail
    // the caller. A logger that throws breaks unrelated code.
    this.sink.record(message).catch(() => {})
  }
}
```

Two rules for any custom logger:

- **It must not throw.** An exception from inside a logger surfaces at an arbitrary point in unrelated code and is very hard to attribute. Wrap any I/O and swallow its failures.
- **It must not block.** Writing synchronously to a remote sink turns every log line into network latency on the request path. Buffer and flush, or hand off to a transport.

Which is a long way of saying: for production, use a logger someone else has already made correct.

## `nestjs-pino` for production

`nestjs-pino` **5.1.0** wires **pino** 10.3.1 and `pino-http` 11.0.0 into Nest. It gives you three things `ConsoleLogger` does not: a per-request child logger carried automatically across `await` boundaries, path-based redaction, and an output format the whole pino ecosystem already understands.

:::tabs
@tab npm
```bash
npm install nestjs-pino@5.1.0 pino@10.3.1 pino-http@11.0.0
npm install --save-dev pino-pretty@13.1.3
```
@tab pnpm
```bash
pnpm add nestjs-pino@5.1.0 pino@10.3.1 pino-http@11.0.0
pnpm add -D pino-pretty@13.1.3
```
@tab yarn
```bash
yarn add nestjs-pino@5.1.0 pino@10.3.1 pino-http@11.0.0
yarn add -D pino-pretty@13.1.3
```
:::

`nestjs-pino` 5.1.0 declares `engines.node: ">=22.12.0"` and peers on `@nestjs/common` and `@nestjs/core` `^11.0.8 || ^12.0.0`, `pino ^10`, `pino-http ^11` and `rxjs ^7`.

```ts title="src/app.module.ts"
import { randomUUID } from 'node:crypto'
import { Module } from '@nestjs/common'
import { LoggerModule } from 'nestjs-pino'

@Module({
  imports: [
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.LOG_LEVEL ?? 'info',

        // One id per request, echoed into every line the request produces.
        // The inbound header is client input — validate its shape before use.
        genReqId: (req, res) => {
          const inbound = req.headers['x-request-id']
          const id =
            typeof inbound === 'string' && /^[\w-]{1,64}$/.test(inbound) ? inbound : randomUUID()
          res.setHeader('x-request-id', id)
          return id
        },

        redact: {
          paths: [
            'req.headers.authorization',
            'req.headers.cookie',
            'res.headers["set-cookie"]',
            'req.headers["x-api-key"]',
            'req.body.password',
            '*.password',
          ],
          censor: '[Redacted]',
        },

        customLogLevel: (req, res, err) => {
          if (err || res.statusCode >= 500) return 'error'
          if (res.statusCode >= 400) return 'warn'
          return 'info'
        },

        autoLogging: {
          ignore: (req) => req.url === '/healthz' || req.url === '/readyz',
        },
      },
    }),
  ],
})
export class AppModule {}
```

```ts title="src/main.ts"
import { NestFactory } from '@nestjs/core'
import { Logger } from 'nestjs-pino'
import { AppModule } from './app.module.js'

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true })
  app.useLogger(app.get(Logger))

  await app.listen(3000)
}

bootstrap()
```

`LoggerModule` registers its `pino-http` middleware for every route by default; `forRoutes` and `exclude` narrow that, and they take the same arguments as [Middleware](../nestjs-request-handling/middleware.md). To keep the request context but stop the automatic "request completed" lines, use `pinoHttp.autoLogging` rather than `exclude` — excluding a route removes the request context from everything that route logs.

### Redaction

`pino-http` logs `req.headers` wholesale by default. Without the `redact` block above, `Authorization` and `Cookie` land in your log platform in plaintext, permanently, readable by everyone with log access.

The path syntax, the `censor` versus `remove: true` decision, and the limits of deny-listing are covered once in [Logging](../express-libraries/logging.md) and are identical here. The one thing worth repeating: **redaction by path only catches what you named**. A password inside an error message or a stringified object is not covered by `req.body.password`. Allow-list what you log; do not log whole objects and hope.

### Logging from a service

Inject `PinoLogger` where you want pino's own API, including the per-request bindings:

```ts title="src/orders/orders.service.ts"
import { Injectable } from '@nestjs/common'
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino'

@Injectable()
export class OrdersService {
  private readonly logger: PinoLogger

  constructor(@InjectPinoLogger(OrdersService.name) logger: PinoLogger) {
    this.logger = logger
  }

  async place(orderId: string, userId: string) {
    // Fields assigned here appear on every subsequent log line in this request.
    this.logger.assign({ userId })
    this.logger.info({ orderId }, 'order placed')
  }
}
```

The request id set by `genReqId` is on every one of those lines without being passed down through a single function signature. That is the whole reason to install this package.

For work that has no HTTP request — a BullMQ processor, a cron job, a CLI script — `PinoLogger` exposes `runInContext(fn, { bindings })`, which opens the same kind of context manually so `assign()` and the bindings still apply.

:::tip Errors need the error object
`this.logger.error({ err, orderId }, 'charge failed')` — the key must be `err`, because pino's standard serializer keys off that name to produce `type`, `message` and `stack`. Passing `err.message` throws the stack away.
:::

### Matching the built-in format

If you are migrating and something downstream parses `ConsoleLogger`'s JSON shape, `nestjs-pino` ships a preset and a matching `LoggerService` that reproduce it: `nativeLoggerOptions` for `pinoHttp`, and `NativeLogger` instead of `Logger` in `app.useLogger()`. `Params.nativeLogger` carries `structuredParams` and `flattenParams` with the same meanings as the `ConsoleLogger` options.

## Security considerations

**Never log credentials, tokens or session identifiers.** Access tokens, refresh tokens, cookies, `Authorization` headers, API keys and password fields are the obvious set. The `redact` block above is the floor, not the ceiling — the full treatment is in [Safe logging](../nestjs-security/safe-logging.md).

**Do not log `request.user`.** It is an object your authentication strategy built, and if `validate()` returned the database row it contains the password hash. Log the id.

**Structured params make leaks easier to write.** `this.logger.log('login', req.body)` is now one tidy record containing the user's password. The convenience of attaching an object is exactly what makes an unreviewed object attachment dangerous — name the fields you want.

**Validate an inbound request id before echoing it.** It is client-controlled text that ends up in your log store and in a response header. The regex in `genReqId` above is the control; without it a caller can inject newlines and forge log lines.

**`flattenParams` puts caller-influenced keys at the root of the record.** Framework fields are protected, but nothing else is. If params can come from a request body, flattening lets a caller shape your log schema — prefer nested `params` when the keys are not fixed by your code.

**Redact before the data leaves the process, not in the log platform.** A redaction rule applied at ingest still means the secret crossed the network and may sit in a buffer, a sidecar or a retry queue.

**Error messages leak internals.** A driver error or a stack trace in a response body is a disclosure; in a log it is fine. Keep the two separate — see [Exception filters](../nestjs-request-handling/exception-filters.md).

**Log authentication events**: login success, login failure, logout, password change, token refresh, authorization denial. With a user id and a request id, never with the credential.

## Production considerations

**Write JSON to stdout and nothing else.** One line per event, no file handles, no rotation, no log directory in the container. The platform — Docker, Kubernetes, systemd — collects the stream. A process that writes its own log files in a container is a process that fills a disk nobody is watching.

**Never run `pino-pretty` in production.** It is a development formatter and it is slow. Pipe it in the `start:dev` script, keep it in `devDependencies`, and leave production output as raw JSON.

**Set the level from the environment.** `LOG_LEVEL` as a variable means you can drop one instance to `debug` for ten minutes without a deploy. Default to `info`.

**Filter health checks out of `autoLogging`.** A probe every second is 86,400 lines per instance per day that you pay to ingest, store and search past.

**`bufferLogs: true` plus `app.useLogger()` is the correct production bootstrap.** Without it, the first few hundred lines of every boot are in the default format and the rest are in yours, and a log parser sees two schemas.

**Budget for log volume before you turn `debug` on globally.** Ingest is usually billed per gigabyte; a chatty `debug` line on a hot path is a line item.

**Correlate logs and traces with one id.** Whatever generates the request id should feed both — see [Observability with @nestjs/observe](observe.md), whose `attachTraceIdToLogs` option does exactly this for its own trace ids.

**A logger is on the request path.** Synchronous I/O inside a custom `LoggerService` shows up directly in p99 latency. pino writes to stdout and lets the collector do the rest, which is why it is fast.

**Keep the format stable.** Renaming a field breaks every saved query and dashboard built on it. Decide on `flattenParams` once, at the start, not after six months of stored logs.

## Common mistakes

- **Expecting v11 output from v12.** A trailing object is now `params`, not a second message. If a test asserts on the old shape, either update it or set `structuredParams: false` deliberately.
- **Setting `flattenParams: true` with `structuredParams: false`.** Nothing happens, and it looks like the option is broken.
- **Naming a param `message`, `level`, `context`, `pid` or `timestamp` with `flattenParams` on.** The framework field wins and your value is dropped silently.
- **Reading `logLevels` as an exact allow-list.** Anything at or above the highest listed level is enabled too.
- **Calling `app.useLogger()` without `bufferLogs: true`.** Everything logged during initialization — including the route table and DI errors — comes out in the old format.
- **Buffering with `autoFlushLogs: false` and no `flushLogs()` on the failure path.** A boot error is swallowed and the process exits silently.
- **Injecting `Logger` without adding it to `providers`.** Nest cannot resolve it and the module fails to instantiate.
- **A custom logger that throws or blocks.** The exception lands somewhere unrelated; the blocking call lands in your latency budget.
- **`console.log` in a service.** It bypasses levels, context, JSON mode and redaction, and it is invisible to the logger you configured.
- **Logging whole request or response objects.** Headers carry credentials, bodies carry PII, and a deny-list will not catch all of it.
- **Running `pino-pretty` in the production process.** Slow, and it destroys the JSON your platform is parsing.
- **Logging expected 4xx responses at `error`.** Alerting becomes noise and people stop reading it.
- **Excluding a route to quiet its request logs.** `exclude` also removes the request context from that route's application logs; use `autoLogging.ignore` instead.

## Related topics

- [Logging](../express-libraries/logging.md) — pino, pino-http, redaction path syntax, levels and morgan, framework-independent.
- [Safe logging](../nestjs-security/safe-logging.md) — the threat model: what must never reach a log line, and how to prove it does not.
- [Observability with @nestjs/observe](observe.md) — traces and metrics alongside these logs, and log forwarding with built-in redaction.
- [Exception filters](../nestjs-request-handling/exception-filters.md) — where unhandled errors are logged and what the client sees instead.
- [Middleware](../nestjs-request-handling/middleware.md) — the `forRoutes` / `exclude` arguments `LoggerModule` reuses.
- [Configuration](../nestjs/configuration.md) — validating `LOG_LEVEL` and the rest of the environment at boot.
- [Authentication](authentication.md) — the events worth logging, and the values that must never appear in them.
- [Background jobs with BullMQ](bullmq.md) — work with no request, where `runInContext` supplies the bindings.
