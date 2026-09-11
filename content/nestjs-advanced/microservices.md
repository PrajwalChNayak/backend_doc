---
title: Microservices and transports
description: How @nestjs/microservices 12 turns a Nest module into a transport-agnostic message handler — the seven transports, message versus event patterns, ClientProxy, hybrid applications, custom serializers, and the NATS v3 package move.
status: current
updated: 2026-09-11
---

`@nestjs/microservices` is not a deployment architecture. It is one abstraction: a handler that is bound to a **pattern** instead of a URL, and a client that sends to that pattern over a transport you choose in one line of configuration. The same controller class works over TCP, Redis, NATS, MQTT, gRPC, Kafka or RabbitMQ, and swapping between them changes only `main.ts`.

## Why it exists

The alternative is writing a broker client by hand in every service: subscribe, parse, dispatch, serialize the reply, correlate it back to a request id, and reimplement your validation and error handling because the HTTP pipeline no longer applies.

The microservices package gives you the pipeline back. Guards, interceptors, pipes and exception filters run on a message handler exactly as they do on a route handler, DI works identically, and the handler itself is a plain method.

What it is **not** is a reason to split a service. Nest's docs call an in-process module boundary and a network boundary by two different names for a reason: the first costs you nothing, and the second costs you partial failure, ordering, retries, schema versioning and a distributed trace. Reach for a transport when you actually have two deployables — see [When plain Express is better](../express-vs-nestjs/when-plain-express-is-better.md) for the same argument one level up.

## The transports

`Transport` is an enum in `@nestjs/microservices@12.0.1` with exactly seven members. Each one loads its driver lazily, so you install only the driver you use.

| `Transport` | Driver package | Request-response | Notes |
| --- | --- | --- | --- |
| `TCP` | none (built in) | yes | Newline-framed JSON over a socket. Zero infrastructure; no fan-out, no durability. |
| `REDIS` | `ioredis` 6.0.0 | yes | Pub/sub. `wildcards: true` switches to `psubscribe`. Nothing is persisted. |
| `NATS` | `@nats-io/transport-node` 3.4.0 | yes | Subject-based. Built-in queue groups via `queue`. **See the v3 note below.** |
| `MQTT` | `mqtt` 5.15.2 | yes | QoS levels through `subscribeOptions.qos`. Good for device fleets. |
| `GRPC` | `@grpc/grpc-js` 1.14.4 + `@grpc/proto-loader` 0.8.1 | yes | Contract-first from a `.proto`. The only transport with a real schema. |
| `KAFKA` | `kafkajs` 2.2.4 | yes (reply topics) | Partitioned, durable log. Request-response is emulated and expensive. |
| `RMQ` | `amqplib` 2.0.1 + `amqp-connection-manager` 5.0.0 | yes | Queues, acks, prefetch, topic exchanges via `wildcards: true`. |

:::tip
If you do not already run a broker, start with `TCP` between two services or `NATS` for anything fan-out shaped. Kafka is the right answer when you need a replayable log and the wrong answer when you need a request to come back.
:::

## Creating a microservice

```bash
npm install @nestjs/microservices@12.0.1
```

```ts title="src/main.ts"
import { NestFactory } from '@nestjs/core'
import { Transport, type MicroserviceOptions } from '@nestjs/microservices'
import { AppModule } from './app.module.js'

async function bootstrap() {
  const app = await NestFactory.createMicroservice<MicroserviceOptions>(AppModule, {
    transport: Transport.TCP,
    options: { host: '0.0.0.0', port: 3001 },
  })

  await app.listen()
}

bootstrap()
```

`createMicroservice` returns an `INestMicroservice`, not an `INestApplication`. There is no HTTP server, so `app.use()`, `setGlobalPrefix()` and HTTP middleware do not exist on it. Global pipes, guards, interceptors and filters do — `app.useGlobalPipes(new ValidationPipe())` works the same way, and registering them through `APP_PIPE` and friends in a module is still better because the container constructs them.

The module is an ordinary `@Module()`. Handlers live on classes decorated with `@Controller()`; the decorator's path argument is ignored when there is no HTTP adapter.

## Message patterns and event patterns

This is the distinction the whole package is built on, and picking the wrong one is the most common design mistake in a Nest service mesh.

```ts title="src/billing/billing.controller.ts"
import { Controller } from '@nestjs/common'
import { Ctx, EventPattern, MessagePattern, Payload, NatsContext } from '@nestjs/microservices'

@Controller()
export class BillingController {
  // Request-response: the caller is waiting for this return value.
  @MessagePattern({ cmd: 'charge' })
  charge(@Payload() data: { orderId: string; amountCents: number }) {
    return this.billing.charge(data.orderId, data.amountCents)
  }

  // Fire-and-forget: the caller has already moved on.
  @EventPattern('order.placed')
  async onOrderPlaced(@Payload() data: { orderId: string }, @Ctx() context: NatsContext) {
    await this.billing.scheduleInvoice(data.orderId, context.getSubject())
  }
}
```

| | `@MessagePattern()` | `@EventPattern()` |
| --- | --- | --- |
| Caller uses | `client.send(pattern, data)` | `client.emit(pattern, data)` |
| Return value | serialized and sent back | **ignored** |
| Caller waits | yes — the observable emits the reply | no — it completes once the message is dispatched |
| Thrown error | reaches the caller as a rejected observable | stays on the consumer side |
| Handlers per pattern | one meaningful reply | any number, all of them run |
| Correct for | "compute this and tell me" | "this happened" |

The pattern itself can be a string or any JSON-serializable object; `{ cmd: 'charge' }` and `'order.placed'` are both valid. Keep the shape consistent across a codebase, because the pattern is matched by a deep equality check on the serialized form and a stray key silently produces "no handler".

:::warning
An `@EventPattern()` handler that returns a value is not an error and not a warning — the value is simply dropped. If a caller seems to hang waiting for an event handler's result, this is why. Events are one-way by construction.
:::

## Calling a microservice

`ClientsModule.register()` publishes a `ClientProxy` under an injection token.

```ts title="src/orders/orders.module.ts"
import { Module } from '@nestjs/common'
import { ClientsModule, Transport } from '@nestjs/microservices'
import { OrdersService } from './orders.service.js'

@Module({
  imports: [
    ClientsModule.register([
      {
        name: 'BILLING',
        transport: Transport.TCP,
        options: { host: 'billing', port: 3001 },
      },
    ]),
  ],
  providers: [OrdersService],
})
export class OrdersModule {}
```

```ts title="src/orders/orders.service.ts"
import { Inject, Injectable } from '@nestjs/common'
import { ClientProxy } from '@nestjs/microservices'
import { firstValueFrom, timeout } from 'rxjs'

@Injectable()
export class OrdersService {
  private readonly billing: ClientProxy

  constructor(@Inject('BILLING') billing: ClientProxy) {
    this.billing = billing
  }

  async charge(orderId: string, amountCents: number) {
    return firstValueFrom(
      this.billing
        .send<{ receiptId: string }>({ cmd: 'charge' }, { orderId, amountCents })
        .pipe(timeout(3000)),
    )
  }

  orderPlaced(orderId: string) {
    this.billing.emit('order.placed', { orderId })
  }
}
```

Three things about `ClientProxy` that bite people:

- **`send()` is lazy.** It returns a cold observable. Nothing is sent until something subscribes, so a `send()` whose result you throw away never leaves the process. `firstValueFrom()` is the subscription.
- **There is no default timeout.** If the other side is gone, the observable hangs forever. Add `timeout()` from RxJS to every `send()`, and pick the number from your own latency budget — see [Retries and timeouts](../nestjs-databases/retries-and-timeouts.md).
- **`emit()` returns an observable too**, which completes once the message is handed to the transport. Subscribing to it is how you find out the broker rejected the publish.

Use a `symbol` rather than the string `'BILLING'` when the token could collide; the reasoning is the same as for any other provider token in [Dependency injection](../nestjs/dependency-injection.md).

### Configuration that comes from the container

`registerAsync()` takes the same `useFactory` / `useClass` / `useExisting` forms as any other dynamic module:

```ts title="src/orders/orders.module.ts"
import { Module } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { ClientsModule, Transport } from '@nestjs/microservices'

@Module({
  imports: [
    ClientsModule.registerAsync([
      {
        name: 'BILLING',
        useFactory: (config: ConfigService) => ({
          transport: Transport.NATS,
          options: { servers: [config.getOrThrow<string>('NATS_URL')] },
        }),
        inject: [ConfigService],
      },
    ]),
  ],
})
export class OrdersModule {}
```

Both `register()` and `registerAsync()` also accept the object form `{ clients: [...], isGlobal: true }` when you genuinely want one client available everywhere. The warning from [Modules](../nestjs/modules.md) applies: a global client is a dependency that no longer shows up in any `imports` array.

## Hybrid applications

A hybrid application is an HTTP server that also listens on one or more transports. This is the shape most real systems end up with, because a service that consumes events usually also needs a health endpoint.

```ts title="src/main.ts"
import { NestFactory } from '@nestjs/core'
import { Transport, type MicroserviceOptions } from '@nestjs/microservices'
import { AppModule } from './app.module.js'

async function bootstrap() {
  const app = await NestFactory.create(AppModule)

  app.connectMicroservice<MicroserviceOptions>(
    {
      transport: Transport.NATS,
      options: { servers: ['nats://nats:4222'], queue: 'billing' },
    },
    { inheritAppConfig: true },
  )

  await app.startAllMicroservices()
  await app.listen(3000)
}

bootstrap()
```

`connectMicroservice()` may be called more than once; `startAllMicroservices()` starts every connected listener, and `app.getMicroservices()` returns them.

The second argument is `NestHybridApplicationOptions`, which has exactly two fields:

| Option | Default | Effect |
| --- | --- | --- |
| `inheritAppConfig` | `false` | Reuse the HTTP application's global pipes, guards, interceptors and filters for the message handlers |
| `deferInitialization` | `false` | Do not initialize the microservice at `connectMicroservice()` time |

:::warning
`inheritAppConfig` defaults to **`false`**, which means a hybrid application's message handlers run with **no** global `ValidationPipe` unless you say otherwise. A team that validated everything at the HTTP edge and then added an event consumer has, at that moment, an unvalidated entry point. Set `inheritAppConfig: true`, or register the pipe with `APP_PIPE` in a module, which applies to both surfaces.
:::

Enhancers registered through `APP_PIPE`, `APP_GUARD`, `APP_INTERCEPTOR` and `APP_FILTER` are container-level, so they cover message handlers regardless of `inheritAppConfig`. That is one more reason to prefer them over `app.useGlobalX()`.

## The NATS v3 package move

If you are copying a NATS example off the internet, it is almost certainly wrong now.

:::deprecated
The `nats` package on npm — last published as 2.29.3 — carries the registry deprecation notice *"Package moved. Use @nats-io/transport-node"*. Uninstall it. `@nestjs/microservices@12.0.1` declares `@nats-io/transport-node` as its optional peer dependency and loads that name at runtime; with only the old package installed, the NATS transport fails to start.

```bash
npm uninstall nats
npm install @nats-io/transport-node@3.4.0
```
:::

The client configuration is unchanged — `servers`, `queue`, `name`, `token` and the rest of `NatsOptions` are the same keys. What changed is what a **custom deserializer receives**.

In the v2 driver a deserializer was handed an already-decoded payload. In v3 it is handed the full NATS message object, and you read the body with `msg.json()`. The deserializer Nest installs by default does exactly that before handing the result to the normal packet mapping, and a custom one has to do the same:

```ts title="src/transport/nats-json.deserializer.ts"
import type { Deserializer, IncomingEvent, IncomingRequest } from '@nestjs/microservices'

export class NatsJsonDeserializer implements Deserializer {
  deserialize(value: any, options?: Record<string, any>): IncomingRequest | IncomingEvent {
    // v3: `value` is the NATS message object, not the payload. Decode it first.
    const packet = value.json()

    // A packet sent by a Nest ClientProxy already carries pattern/data.
    if (packet?.pattern !== undefined || packet?.data !== undefined) {
      return packet
    }

    // Anything published by a non-Nest producer arrives as a bare body.
    return { pattern: options?.channel, data: packet }
  }
}
```

A deserializer written against the v2 shape does not throw a helpful error — it reads `undefined` properties off a message object and every incoming pattern stops matching. If NATS handlers went silent after an upgrade, this is the first thing to check.

Headers are read from the context rather than the payload:

```ts
import { Controller } from '@nestjs/common'
import { Ctx, MessagePattern, NatsContext, Payload } from '@nestjs/microservices'

@Controller()
export class AuditController {
  @MessagePattern('audit.record')
  record(@Payload() data: unknown, @Ctx() context: NatsContext) {
    return this.audit.write(context.getSubject(), context.getHeaders(), data)
  }
}
```

To send headers, wrap the payload in a `NatsRecord`:

```ts
import { NatsRecordBuilder } from '@nestjs/microservices'

const record = new NatsRecordBuilder({ orderId: 'o_123' })
  .setHeaders({ 'x-correlation-id': correlationId })
  .build()

client.emit('order.placed', record)
```

`RmqRecordBuilder` and `MqttRecordBuilder` are the equivalents for those transports.

## Serialization and deserialization

Every transport carries JSON by default. The two hooks are symmetrical and live in the transport `options`:

| Hook | Interface | Runs |
| --- | --- | --- |
| `serializer` | `Serializer<TInput, TOutput>` — `serialize(value, options?)` | on the way out, before the driver publishes |
| `deserializer` | `Deserializer<TInput, TOutput>` — `deserialize(value, options?)` | on the way in, before pattern matching |

Both exist on the client and on the server, and both may return a promise.

```ts title="src/transport/envelope.serializer.ts"
import type { Serializer } from '@nestjs/microservices'

export class EnvelopeSerializer implements Serializer {
  serialize(value: any) {
    return { ...value, meta: { sentAt: new Date().toISOString(), schema: 1 } }
  }
}
```

```ts title="src/main.ts"
import { NestFactory } from '@nestjs/core'
import { Transport, type MicroserviceOptions } from '@nestjs/microservices'
import { AppModule } from './app.module.js'
import { EnvelopeSerializer } from './transport/envelope.serializer.js'

async function bootstrap() {
  const app = await NestFactory.createMicroservice<MicroserviceOptions>(AppModule, {
    transport: Transport.NATS,
    options: {
      servers: ['nats://nats:4222'],
      serializer: new EnvelopeSerializer(),
    },
  })

  await app.listen()
}

bootstrap()
```

The rule that saves you later: **a serializer is where a message version number goes, and nowhere else.** Putting it in the pattern (`'order.placed.v2'`) makes every consumer's subscription list churn; putting it in each handler's payload type makes it invisible until something breaks.

:::danger
A deserializer runs **before** guards, pipes and validation, on bytes that arrived from a broker. It is the earliest attacker-reachable code in the service. Do not deserialize to anything but plain data there — no `eval`, no prototype-carrying revivers, no class hydration — and keep validation in a pipe where a failure produces a clean error. [Validation as a security control](../nestjs-security/validation-as-a-control.md) covers the rest.
:::

## Error handling across a transport

Throwing an `HttpException` from a message handler does not do anything useful: there is no response to set a status on. `RpcException` is the transport-shaped equivalent.

```ts title="src/billing/billing.controller.ts"
import { Controller } from '@nestjs/common'
import { MessagePattern, Payload, RpcException } from '@nestjs/microservices'

@Controller()
export class BillingController {
  @MessagePattern({ cmd: 'charge' })
  async charge(@Payload() data: { orderId: string }) {
    const order = await this.orders.find(data.orderId)
    if (!order) {
      throw new RpcException({ code: 'ORDER_NOT_FOUND', orderId: data.orderId })
    }
    return this.billing.charge(order)
  }
}
```

On the caller's side that arrives as an error on the observable, carrying whatever object you passed:

```ts
import { catchError, firstValueFrom, throwError } from 'rxjs'
import { NotFoundException } from '@nestjs/common'

const receipt = await firstValueFrom(
  this.billing.send({ cmd: 'charge' }, { orderId }).pipe(
    catchError((error) =>
      error?.code === 'ORDER_NOT_FOUND'
        ? throwError(() => new NotFoundException('Order not found'))
        : throwError(() => error),
    ),
  ),
)
```

That mapping step is the whole job of a gateway service: translate a remote failure into a local one that your HTTP exception filter already knows how to render. Without it, an `RpcException` from three hops away surfaces as a 500 with a message your users should never see.

To catch centrally, write a filter implementing `RpcExceptionFilter` — note that its `catch()` returns an **`Observable`**, not `void` like the HTTP one — or extend `BaseRpcExceptionFilter`:

```ts title="src/common/filters/all-rpc-exceptions.filter.ts"
import { ArgumentsHost, Catch } from '@nestjs/common'
import { BaseRpcExceptionFilter, RpcException } from '@nestjs/microservices'
import { Logger } from '@nestjs/common'

@Catch()
export class AllRpcExceptionsFilter extends BaseRpcExceptionFilter {
  private readonly logger = new Logger(AllRpcExceptionsFilter.name)

  catch(exception: unknown, host: ArgumentsHost) {
    this.logger.error(exception instanceof Error ? exception.stack : String(exception))
    const safe = exception instanceof RpcException ? exception : new RpcException('Internal error')
    return super.catch(safe, host)
  }
}
```

Replacing an unknown exception with a generic one before it crosses the wire is deliberate: a stack trace or a driver error string is exactly the kind of internal detail that should not leave the process. See [Safe logging](../nestjs-security/safe-logging.md).

### What "delivered" means differs per transport

Error handling is not only about exceptions. The failure modes differ enough that you cannot write one retry policy for all seven:

| Transport | If the consumer crashes mid-message | Redelivery |
| --- | --- | --- |
| TCP | the message is lost | none |
| Redis pub/sub | the message is lost | none |
| NATS core | the message is lost | none — queue groups balance, they do not persist |
| MQTT | depends on QoS and session persistence | QoS 1/2 only |
| RMQ | redelivered if `noAck: false` and no ack was sent | yes |
| Kafka | reprocessed from the last committed offset | yes |

With `RMQ`, `noAck` defaults to `false`, so Nest acknowledges automatically after the handler resolves and a thrown error leaves the message unacknowledged. Set `noAck: true` only when losing a message is genuinely acceptable. For anything that must not be lost on a transport in the top three rows, write it to a durable store first and publish from there — see [Background jobs with BullMQ](../nestjs-libraries/bullmq.md).

## Custom transports

`CustomStrategy` takes any object implementing `CustomTransportStrategy`, which is how you put Nest's handler pipeline on a protocol the package does not ship:

```ts
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module.js'
import { MyStrategy } from './transport/my.strategy.js'

const app = await NestFactory.createMicroservice(AppModule, {
  strategy: new MyStrategy(),
})
```

Worth knowing it exists. Worth not using it until a broker you must talk to has no driver here.

## Common mistakes

- **`@EventPattern()` for something the caller needs an answer from.** The return value is discarded and the caller's observable completes empty. Use `@MessagePattern()`.
- **`send()` without subscribing.** It is a cold observable; nothing is transmitted. `firstValueFrom()` or `await lastValueFrom()`.
- **`send()` without `timeout()`.** There is no default. A dead peer hangs the request until the client gives up, which it never does.
- **Leaving `inheritAppConfig` at its default in a hybrid app.** Your global `ValidationPipe` does not apply to message handlers, and you have an unvalidated entry point. Set it, or register through `APP_PIPE`.
- **Installing the old, moved NATS package.** It is deprecated on npm and Nest 12 loads `@nats-io/transport-node`. Uninstall it.
- **A NATS deserializer written for the v2 payload shape.** v3 hands you the message object; read the body with `msg.json()`. The symptom is handlers that never match.
- **Throwing `HttpException` from a message handler.** There is no response to put a status on. Use `RpcException` and map it at the caller.
- **Letting an unknown exception cross the transport.** Stack traces and driver errors leak internals. Replace them in a filter.
- **One retry policy for all transports.** Redis pub/sub drops messages and Kafka replays them. Match the policy to what the transport actually guarantees.
- **Splitting a monolith to get these decorators.** A module boundary is free; a network boundary costs partial failure. Split when you have two deployables, not to use `@MessagePattern()`.
- **Encoding a schema version in the pattern.** Every consumer's subscription changes. Put it in the envelope, in a serializer.

## Related topics

- [Modules](../nestjs/modules.md) — the `imports`/`exports` boundary `ClientsModule` plugs into.
- [Dependency injection](../nestjs/dependency-injection.md) — tokens for `ClientProxy`, and why a symbol beats a string.
- [Dynamic modules](dynamic-modules.md) — what `register()` / `registerAsync()` are doing underneath.
- [Exception filters](../nestjs-request-handling/exception-filters.md) — the HTTP counterpart of `RpcExceptionFilter`.
- [Pipes](../nestjs-request-handling/pipes.md) — validating a `@Payload()` the same way you validate a body.
- [Validation as a security control](../nestjs-security/validation-as-a-control.md) — why an unvalidated message handler is an entry point.
- [Safe logging](../nestjs-security/safe-logging.md) — keeping internals out of what crosses the wire.
- [Retries and timeouts](../nestjs-databases/retries-and-timeouts.md) — picking the number for that `timeout()`.
- [Background jobs with BullMQ](../nestjs-libraries/bullmq.md) — durable work when the transport does not persist.
- [Events](../nestjs-libraries/event-emitter.md) — the in-process version, for when you do not need a network.
- [CQRS](cqrs.md) — commands and events inside one process, with the same vocabulary.
- [When plain Express is better](../express-vs-nestjs/when-plain-express-is-better.md) — the case against splitting early.
- [Health and readiness probes](../nestjs-production/health-and-readiness-probes.md) — what a hybrid application still needs to expose over HTTP.
