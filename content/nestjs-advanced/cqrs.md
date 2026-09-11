---
title: CQRS
description: The @nestjs/cqrs 12 command, query and event buses — typed Command and Query base classes, handlers, sagas, the aggregate root, and an honest account of when CQRS is more machinery than your CRUD API needs.
status: current
updated: 2026-09-11
---

CQRS separates the code that changes state from the code that reads it, and routes each through its own bus. `@nestjs/cqrs@12.0.0` gives you three buses, four decorators and an event publisher; everything else is a convention you adopt or do not. The package is small. The pattern is not, and most applications should not adopt it.

## When it is over-engineering

Start here, because this is the part the tutorials skip.

A typical CRUD API has one model, one database, and a service per resource. CQRS adds, per operation: a command class, a handler class, a registration, and an indirection that no stack trace crosses. Ten endpoints become forty files. In exchange you get:

| CQRS gives you | Which matters when |
| --- | --- |
| A named object per operation | operations have names the business uses, and more than one trigger |
| A seam between write and read models | the read shape genuinely differs from the write shape |
| Events as first-class facts | several unrelated things must react to one change |
| A place to put cross-cutting write behavior | every write needs audit, outbox or idempotency handling |
| Independent scaling of reads and writes | you have measured that they need it |

If your answer to all five is "not really", a `OrdersService` with methods on it is the better design and will stay the better design. [Providers and services](../nestjs/providers-and-services.md) and [Layered architecture](../express/layered-architecture.md) describe what you already have.

:::best-practice
Adopt CQRS **per bounded context, not per application**. A checkout flow with six side effects can be command-driven while the admin CRUD screens next to it stay plain services. A codebase where everything goes through a bus because one thing needed to is a codebase where every change is three files further away than it should be.
:::

The remainder of this page assumes you decided yes.

## Installation and registration

```bash
npm install @nestjs/cqrs@12
```

```ts title="src/orders/orders.module.ts"
import { Module } from '@nestjs/common'
import { CqrsModule } from '@nestjs/cqrs'
import { ChargeOrderHandler } from './commands/charge-order.handler.js'
import { OrderByIdHandler } from './queries/order-by-id.handler.js'
import { OrderChargedHandler } from './events/order-charged.handler.js'
import { OrdersSagas } from './orders.sagas.js'

@Module({
  imports: [CqrsModule.forRoot()],
  providers: [ChargeOrderHandler, OrderByIdHandler, OrderChargedHandler, OrdersSagas],
})
export class OrdersModule {}
```

Handlers are ordinary providers. They are discovered at `onApplicationBootstrap` by reading the metadata the decorators wrote, which means **a handler you forget to list in `providers` is silently never registered** — dispatching its command then fails at runtime with "no handler found", not at compile time.

`CqrsModule.forRoot()` accepts `CqrsModuleOptions`; `forRootAsync()` takes the usual `useFactory`/`useClass`/`useExisting` forms. The options are all substitution points:

| Option | Default | Purpose |
| --- | --- | --- |
| `commandPublisher` | in-memory | replace the transport commands travel over |
| `queryPublisher` | in-memory | same, for queries |
| `eventPublisher` | in-memory | same, for events — this is the hook for an event store |
| `unhandledExceptionPublisher` | in-memory | where unhandled handler errors surface |
| `eventIdProvider` | default | how an event instance maps to a handler id |
| `rethrowUnhandled` | `false` | rethrow instead of swallowing unhandled exceptions |

:::warning
`rethrowUnhandled` defaults to **`false`**, so an exception thrown inside an `@EventsHandler()` does not reach your process's error handling by default — it goes to the `UnhandledExceptionBus` and, if nothing is subscribed there, nowhere. An event handler that started failing looks exactly like an event handler that is not being called. Subscribe to `UnhandledExceptionBus` or set `rethrowUnhandled: true`, and do it on day one rather than during the incident.
:::

## Commands

A command is an instruction: imperative name, one handler, may return a result.

`@nestjs/cqrs@12` ships a `Command<TResult>` base class whose only job is to carry the result type, so `commandBus.execute()` infers it. Use it — the older bare-class-implementing-`ICommand` form still works and returns `any`.

```ts title="src/orders/commands/charge-order.command.ts"
import { Command } from '@nestjs/cqrs'

export class ChargeOrderCommand extends Command<{ receiptId: string }> {
  readonly orderId: string
  readonly amountCents: number

  constructor(orderId: string, amountCents: number) {
    super()
    this.orderId = orderId
    this.amountCents = amountCents
  }
}
```

```ts title="src/orders/commands/charge-order.handler.ts"
import { CommandHandler, EventBus, type ICommandHandler } from '@nestjs/cqrs'
import { NotFoundException } from '@nestjs/common'
import { ChargeOrderCommand } from './charge-order.command.js'
import { OrderChargedEvent } from '../events/order-charged.event.js'
import { OrdersRepository } from '../orders.repository.js'
import { PaymentsService } from '../../payments/payments.service.js'

@CommandHandler(ChargeOrderCommand)
export class ChargeOrderHandler implements ICommandHandler<ChargeOrderCommand> {
  private readonly orders: OrdersRepository
  private readonly payments: PaymentsService
  private readonly events: EventBus

  constructor(orders: OrdersRepository, payments: PaymentsService, events: EventBus) {
    this.orders = orders
    this.payments = payments
    this.events = events
  }

  async execute(command: ChargeOrderCommand) {
    const order = await this.orders.findById(command.orderId)
    if (!order) {
      throw new NotFoundException(`Order ${command.orderId} not found`)
    }

    const receipt = await this.payments.charge(order, command.amountCents)
    this.events.publish(new OrderChargedEvent(order.id, receipt.id))

    return { receiptId: receipt.id }
  }
}
```

Dispatching from a controller:

```ts title="src/orders/orders.controller.ts"
import { Body, Controller, Param, Post } from '@nestjs/common'
import { CommandBus } from '@nestjs/cqrs'
import { ChargeOrderCommand } from './commands/charge-order.command.js'
import { ChargeOrderDto } from './dto/charge-order.dto.js'

@Controller('orders')
export class OrdersController {
  private readonly commandBus: CommandBus

  constructor(commandBus: CommandBus) {
    this.commandBus = commandBus
  }

  @Post(':id/charge')
  charge(@Param('id') id: string, @Body() dto: ChargeOrderDto) {
    // Inferred as Promise<{ receiptId: string }> from Command<…>.
    return this.commandBus.execute(new ChargeOrderCommand(id, dto.amountCents))
  }
}
```

The controller is now four lines and contains no rules. That is the good version of this trade: the transport layer shrinks to translation, and the operation has a name you can grep.

:::note
A `@CommandHandler()` may throw ordinary Nest exceptions. `NotFoundException` thrown in the handler above still reaches the HTTP exception filter, because `execute()` is awaited inside the controller's own call stack. That is not true of events — see below.
:::

## Queries

Identical machinery, opposite intent: a query must not change anything.

```ts title="src/orders/queries/order-by-id.query.ts"
import { Query } from '@nestjs/cqrs'
import type { OrderView } from '../views/order.view.js'

export class OrderByIdQuery extends Query<OrderView | null> {
  readonly orderId: string

  constructor(orderId: string) {
    super()
    this.orderId = orderId
  }
}
```

```ts title="src/orders/queries/order-by-id.handler.ts"
import { QueryHandler, type IQueryHandler } from '@nestjs/cqrs'
import { OrderByIdQuery } from './order-by-id.query.js'
import { OrderReadRepository } from '../order-read.repository.js'
import type { OrderView } from '../views/order.view.js'

@QueryHandler(OrderByIdQuery)
export class OrderByIdHandler implements IQueryHandler<OrderByIdQuery> {
  private readonly reads: OrderReadRepository

  constructor(reads: OrderReadRepository) {
    this.reads = reads
  }

  async execute(query: OrderByIdQuery): Promise<OrderView | null> {
    return this.reads.findView(query.orderId)
  }
}
```

The read repository returning a `OrderView` rather than an entity is the point of the separation. The read side is free to be a denormalized table, a materialized view or a join that no write path would tolerate — and it does not have to share a model with the write side. If your query handler just calls the same repository the command handler does, you have the file count of CQRS and none of the benefit.

## Events

An event is a fact in the past tense. Any number of handlers may react, none of them return anything, and the publisher does not wait.

```ts title="src/orders/events/order-charged.event.ts"
export class OrderChargedEvent {
  readonly orderId: string
  readonly receiptId: string

  constructor(orderId: string, receiptId: string) {
    this.orderId = orderId
    this.receiptId = receiptId
  }
}
```

```ts title="src/orders/events/order-charged.handler.ts"
import { EventsHandler, type IEventHandler } from '@nestjs/cqrs'
import { OrderChargedEvent } from './order-charged.event.js'
import { ReceiptsMailer } from '../../mail/receipts.mailer.js'

@EventsHandler(OrderChargedEvent)
export class OrderChargedHandler implements IEventHandler<OrderChargedEvent> {
  private readonly mailer: ReceiptsMailer

  constructor(mailer: ReceiptsMailer) {
    this.mailer = mailer
  }

  async handle(event: OrderChargedEvent) {
    await this.mailer.sendReceipt(event.orderId, event.receiptId)
  }
}
```

`@EventsHandler()` is plural and variadic — one class may handle several event types, which is how you write a projection that maintains one read model from many facts.

:::danger
`EventBus.publish()` is **in-process and not durable**. If the handler throws, or the pod is rescheduled between the publish and the handler, the effect simply does not happen — and the command that published it has already returned success to the caller. For anything that must not be lost (an email, a charge, a downstream call) publish through a durable mechanism instead: write the event to the database inside the same transaction as the state change, then dispatch from there. [Background jobs with BullMQ](../nestjs-libraries/bullmq.md) and [Transactions](../nestjs-databases/transactions.md) are the two halves of that pattern.
:::

## Sagas

A saga listens to the event stream and emits commands. It is where "when X happened, do Y" lives, and it is the one piece of CQRS that has no equivalent in a plain service layer.

```ts title="src/orders/orders.sagas.ts"
import { Injectable } from '@nestjs/common'
import { Saga, ofType, type ICommand } from '@nestjs/cqrs'
import { Observable, map } from 'rxjs'
import { OrderChargedEvent } from './events/order-charged.event.js'
import { ScheduleFulfilmentCommand } from './commands/schedule-fulfilment.command.js'

@Injectable()
export class OrdersSagas {
  @Saga()
  orderCharged = (events$: Observable<any>): Observable<ICommand> =>
    events$.pipe(
      ofType(OrderChargedEvent),
      map((event) => new ScheduleFulfilmentCommand(event.orderId)),
    )
}
```

Three things to get right:

- **`@Saga()` decorates a property, not a method.** It must be an arrow function assigned to a field; a class method will not be picked up.
- **`ofType()` filters with `instanceof`.** An event reconstructed from JSON — read back out of a queue, say — is a plain object and will not match. Rehydrate to the class first.
- **The returned observable must emit commands, and must not error.** An error terminates the subscription permanently, and the saga stops reacting to everything, not just the failing event. Put a `catchError` inside the pipe that logs and returns `EMPTY`.

A saga that grows a `switchMap` with three nested requests is no longer a saga; it is a workflow, and it wants a durable orchestrator rather than an RxJS pipeline in memory.

## The aggregate root

`AggregateRoot` lets a domain object collect events during a unit of work and publish them all at once, so the write model decides *what happened* and the handler decides *when to announce it*.

```ts title="src/orders/order.aggregate.ts"
import { AggregateRoot } from '@nestjs/cqrs'
import { OrderChargedEvent } from './events/order-charged.event.js'

export class OrderAggregate extends AggregateRoot {
  readonly id: string

  constructor(id: string) {
    super()
    this.id = id
  }

  charge(receiptId: string) {
    this.apply(new OrderChargedEvent(this.id, receiptId))
  }
}
```

```ts title="src/orders/commands/charge-order.handler.ts"
import { CommandHandler, EventPublisher, type ICommandHandler } from '@nestjs/cqrs'
import { ChargeOrderCommand } from './charge-order.command.js'
import { OrderAggregate } from '../order.aggregate.js'
import { PaymentsService } from '../../payments/payments.service.js'

@CommandHandler(ChargeOrderCommand)
export class ChargeOrderHandler implements ICommandHandler<ChargeOrderCommand> {
  private readonly publisher: EventPublisher
  private readonly payments: PaymentsService

  constructor(publisher: EventPublisher, payments: PaymentsService) {
    this.publisher = publisher
    this.payments = payments
  }

  async execute(command: ChargeOrderCommand) {
    const order = this.publisher.mergeObjectContext(new OrderAggregate(command.orderId))
    const receipt = await this.payments.charge(command.orderId, command.amountCents)

    order.charge(receipt.id)
    order.commit()      // nothing is published until this line

    return { receiptId: receipt.id }
  }
}
```

`mergeObjectContext()` attaches the publisher to an instance; `mergeClassContext()` does it to a class so every instance is publishable. `@Publishable()` is the decorator form of the latter. The useful property is `commit()`: events accumulate while the unit of work is still in doubt and are released only when it succeeded, which is what stops a rollback from having already sent the email.

## Where each bus belongs

| | Command | Query | Event |
| --- | --- | --- | --- |
| Grammar | imperative — `ChargeOrder` | interrogative — `OrderById` | past tense — `OrderCharged` |
| Handlers | exactly one | exactly one | any number, including zero |
| Returns | a result, or nothing | data | nothing |
| Caller waits | yes | yes | no |
| May change state | yes | **no** | handlers may |
| Failure reaches the caller | yes | yes | **no** |

The last row is the one that causes production incidents. A command's failure is the caller's problem; an event handler's failure is nobody's, unless you made it somebody's.

## Testing

CQRS is unusually pleasant to test, because a handler is a class with a single method and explicit dependencies.

```ts title="src/orders/commands/charge-order.handler.spec.ts"
import assert from 'node:assert/strict'
import test from 'node:test'
import { Test } from '@nestjs/testing'
import { EventBus } from '@nestjs/cqrs'
import { ChargeOrderCommand } from './charge-order.command.js'
import { ChargeOrderHandler } from './charge-order.handler.js'
import { OrdersRepository } from '../orders.repository.js'
import { PaymentsService } from '../../payments/payments.service.js'

test('charging a missing order is a 404', async () => {
  const published: unknown[] = []

  const moduleRef = await Test.createTestingModule({
    providers: [
      ChargeOrderHandler,
      { provide: OrdersRepository, useValue: { findById: async () => null } },
      { provide: PaymentsService, useValue: { charge: async () => ({ id: 'r_1' }) } },
      { provide: EventBus, useValue: { publish: (e: unknown) => published.push(e) } },
    ],
  }).compile()

  const handler = moduleRef.get(ChargeOrderHandler)

  await assert.rejects(() => handler.execute(new ChargeOrderCommand('missing', 100)))
  assert.equal(published.length, 0)
})
```

Asserting on what was **not** published is as important as asserting on the return value — an event emitted on a failed path is the bug this pattern is most prone to.

## Common mistakes

- **Adopting CQRS for CRUD.** Forty files where ten would do, and no read/write divergence to justify them. Use a service.
- **A query handler that calls the write repository.** You paid for the separation and did not take it. Either give the read side its own model or drop the query bus.
- **Forgetting a handler in `providers`.** Discovery is by metadata on registered providers. An unregistered handler fails at dispatch time with "no handler found".
- **Leaving `rethrowUnhandled` at `false` without subscribing to `UnhandledExceptionBus`.** Event-handler failures vanish. A broken handler is indistinguishable from an uncalled one.
- **Treating `EventBus.publish()` as durable.** It is in-process. A crash between publish and handle loses the effect, after the command already returned success.
- **`@Saga()` on a method.** It must be a property holding an arrow function.
- **A saga whose observable can error.** One error unsubscribes it permanently and it stops reacting to every event, not just the failing one.
- **`ofType()` against rehydrated JSON.** It compares with `instanceof`. Reconstruct the class first.
- **Publishing before `commit()` on an aggregate — or forgetting `commit()` entirely.** The first announces work that may still roll back; the second announces nothing at all.
- **Commands that return the whole entity.** A command's result should be the minimum the caller needs. If the caller wants the object, that is a query.
- **Using `ICommand` instead of `Command<T>`.** You lose result-type inference for nothing.

## Related topics

- [Providers and services](../nestjs/providers-and-services.md) — the simpler design CQRS replaces, and the one most applications should keep.
- [Modules](../nestjs/modules.md) — where handlers are registered, and why an unlisted one never runs.
- [Events](../nestjs-libraries/event-emitter.md) — `@nestjs/event-emitter`, the lighter in-process alternative to `EventBus`.
- [Microservices and transports](microservices.md) — the same command/event vocabulary across a network boundary.
- [Transactions](../nestjs-databases/transactions.md) — making a state change and its event atomic.
- [Background jobs with BullMQ](../nestjs-libraries/bullmq.md) — where a side effect goes when it must survive a crash.
- [Unit tests](../nestjs-testing/unit-tests.md) — testing a handler without booting the application.
- [Mocking providers](../nestjs-testing/mocking-providers.md) — substituting the buses in a testing module.
- [Layered architecture](../express/layered-architecture.md) — the plain-Express version of separating rules from transport.
- [Dependency injection](../nestjs/dependency-injection.md) — how `CommandBus`, `QueryBus` and `EventBus` reach your classes.
