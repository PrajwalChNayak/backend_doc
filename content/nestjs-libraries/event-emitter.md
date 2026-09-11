---
title: Events
description: In-process events with @nestjs/event-emitter 12.0.0 — EventEmitterModule.forRoot, @OnEvent, typed payloads, async listeners, and the error handling that is swallowed by default.
status: current
updated: 2026-09-11
---

`@nestjs/event-emitter` is **12.0.0**, a Nest wrapper around `eventemitter2` 6.4.9. It lets one part of your application announce that something happened and another part react, without the two knowing about each other. It is entirely **in-process** — nothing survives a restart, and nothing crosses to another replica — and that limitation is the most important fact on this page.

## Why it exists

A service that creates a user should not also send the welcome email, write the audit record, warm the cache and notify the CRM. Every one of those is a separate concern with a separate failure mode, and stitching them into `UsersService.create()` means that method grows a new dependency every quarter and becomes untestable.

An event inverts the dependency: `UsersService` announces `user.created` and stops caring. The email module, the audit module and the CRM module each subscribe. Adding a fifth reaction touches one new file and zero existing ones.

The cost is indirection. "What happens when a user is created" is no longer answerable by reading one method; it is answerable by grepping for the event name. That is a real cost, and it is why this pattern is worth it for cross-cutting reactions and not worth it for the two lines that belong in the service.

## Installing

```bash
npm install @nestjs/event-emitter@12.0.0
```

```ts title="src/app.module.ts"
import { Module } from '@nestjs/common'
import { EventEmitterModule } from '@nestjs/event-emitter'

@Module({
  imports: [
    EventEmitterModule.forRoot({
      wildcard: true,
      delimiter: '.',
      maxListeners: 20,
      verboseMemoryLeak: true,
      global: true,
    }),
  ],
})
export class AppModule {}
```

`EventEmitterModuleOptions` extends `eventemitter2`'s own `ConstructorOptions` and adds two Nest-specific fields:

| Option | Notes |
| --- | --- |
| `wildcard` | enable namespaced events, so `@OnEvent('user.*')` matches |
| `delimiter` | the namespace separator; `'.'` with `wildcard` on |
| `maxListeners` | warn above this many listeners for one event |
| `verboseMemoryLeak` | include the event name in that warning — always on |
| `global` | register the module globally (Nest-specific) |
| `inheritRequestContextId` | reuse the originating request's context id for request-scoped listeners (Nest-specific) |

`forRoot()` is the only static method; there is no `forRootAsync`, which is fine because none of these options come from the environment.

## Emitting and handling

```ts title="src/users/events/user-created.event.ts"
export class UserCreatedEvent {
  readonly userId: string
  readonly email: string
  readonly locale: string
  readonly occurredAt: Date

  constructor(userId: string, email: string, locale: string, occurredAt = new Date()) {
    this.userId = userId
    this.email = email
    this.locale = locale
    this.occurredAt = occurredAt
  }
}

export const USER_CREATED = 'user.created'
```

```ts title="src/users/users.service.ts"
import { Injectable } from '@nestjs/common'
import { EventEmitter2 } from '@nestjs/event-emitter'
import { UserRepository } from './user.repository.js'
import { USER_CREATED, UserCreatedEvent } from './events/user-created.event.js'

@Injectable()
export class UsersService {
  private readonly repo: UserRepository
  private readonly events: EventEmitter2

  constructor(repo: UserRepository, events: EventEmitter2) {
    this.repo = repo
    this.events = events
  }

  async create(input: { email: string; locale: string }) {
    const user = await this.repo.insert(input)

    // Fire-and-forget: `emit` returns once every listener has been *invoked*,
    // not once every async listener has settled.
    this.events.emit(USER_CREATED, new UserCreatedEvent(user.id, user.email, user.locale))

    return user
  }
}
```

```ts title="src/notifications/welcome.listener.ts"
import { Injectable } from '@nestjs/common'
import { OnEvent } from '@nestjs/event-emitter'
import { USER_CREATED, UserCreatedEvent } from '../users/events/user-created.event.js'
import { EmailsService } from '../emails/emails.service.js'

@Injectable()
export class WelcomeListener {
  private readonly emails: EmailsService

  constructor(emails: EmailsService) {
    this.emails = emails
  }

  @OnEvent(USER_CREATED, { async: true })
  async onUserCreated(event: UserCreatedEvent) {
    // Hand the actual work to a durable queue. See the limitation below.
    await this.emails.queueWelcome(event.userId, event.locale)
  }
}
```

The listener class must be a **provider** in a module the application loads. The discovery pass walks registered providers looking for `@OnEvent`; a class that is never provided is never scanned, and there is no error. A listener that silently does nothing is almost always this.

A payload class rather than a bare object is worth the file. It gives the emit site and the listener one shared type, so a renamed field is a compile error rather than an `undefined` in a welcome email.

`@OnEvent` accepts a string, a symbol, or an **array** of either, so one method can handle `['user.created', 'user.reactivated']`.

### `OnEventOptions`

`OnEventOptions` is `eventemitter2`'s `OnOptions` plus two Nest additions:

| Option | Effect |
| --- | --- |
| `async` | treat the listener as asynchronous (from `eventemitter2`) |
| `promisify` | make the listener's promise available to `emitAsync` |
| `objectify` | return a listener handle instead of the emitter |
| `prependListener` | run this listener before previously registered ones (Nest) |
| `suppressErrors` | whether a throwing listener is swallowed; **defaults to `true`** (Nest) |

## Error handling — the default that will surprise you

Read from the shipped source, Nest wraps every listener invocation in a try/catch, and the catch does this:

```ts
if (options?.suppressErrors ?? true) {
  this.logger.error(error.message, error.stack)
} else {
  throw e
}
```

**`suppressErrors` defaults to `true`.** A listener that throws is logged by the framework and otherwise ignored. Nothing propagates to the emitter, no request fails, and the user is told everything worked.

That is usually the correct behaviour — a failed CRM sync should not fail the signup — but it means **the listener is responsible for its own reliability**. There is no retry, no dead letter, and no record beyond one log line.

```ts title="src/audit/audit.listener.ts"
import { Injectable, Logger } from '@nestjs/common'
import { OnEvent } from '@nestjs/event-emitter'
import { AuditService } from './audit.service.js'
import { USER_CREATED, UserCreatedEvent } from '../users/events/user-created.event.js'

@Injectable()
export class AuditListener {
  private readonly logger = new Logger(AuditListener.name)
  private readonly audit: AuditService

  constructor(audit: AuditService) {
    this.audit = audit
  }

  @OnEvent(USER_CREATED, { async: true })
  async onUserCreated(event: UserCreatedEvent) {
    try {
      await this.audit.record('user.created', { userId: event.userId })
    } catch (error) {
      // Explicit, with the context the framework's generic handler lacks.
      this.logger.error(
        `audit write failed for user ${event.userId}`,
        error instanceof Error ? error.stack : String(error),
      )
    }
  }
}
```

Set `suppressErrors: false` only when a failing listener genuinely should fail the emitter — which, for `emit()`, means throwing out of whatever synchronous call stack fired the event, usually your request handler. That is rarely what you want.

### Waiting for listeners

`emit()` does not wait. `emitAsync()` returns a promise that resolves to an array of listener results:

```ts
const results = await this.events.emitAsync(USER_CREATED, event)
```

Use it sparingly. Awaiting listeners re-couples the emitter to them: the request now takes as long as the slowest listener, and a hanging listener hangs the request. If you find yourself needing the results, you probably wanted a method call rather than an event.

`EventEmitterReadinessWatcher` is provided for the opposite problem — emitting during bootstrap, before listeners are registered. `await watcher.waitUntilReady()` before an `onApplicationBootstrap` emit, or the event fires into an empty room.

## Wildcards and namespaces

With `wildcard: true` and `delimiter: '.'`:

| Pattern | Matches |
| --- | --- |
| `user.created` | exactly that |
| `user.*` | `user.created`, `user.deleted` — one segment |
| `user.**` | `user.created`, `user.profile.updated` — any depth |

```ts
@OnEvent('user.**', { async: true })
async onAnyUserEvent(payload: unknown) {
  await this.analytics.track(payload)
}
```

A wildcard listener is a good fit for analytics and audit, which want everything. It is a poor fit for business logic, because the payload type degrades to a union you have to narrow by hand — and because an event added six months later is silently routed into a handler nobody remembers.

Name events `noun.verb-in-past-tense`: `invoice.paid`, `user.deleted`, `subscription.renewed`. Past tense is not a style preference — it is what stops an "event" from being a disguised command. `user.created` is a fact; `send.welcome.email` is an instruction, and an instruction wants a method call or a queue.

## The limitation: in-process only

This is the honest part, and it decides where you may use this package.

`EventEmitter2` is an object in your process's memory. Therefore:

| | In-process events | A durable queue |
| --- | --- | --- |
| Survives a crash | **no** — everything in flight is lost | yes |
| Survives a deploy | **no** | yes |
| Reaches another replica | **no** | yes |
| Retries on failure | **no** | yes, with backoff |
| Failures are recorded | one log line | a failed-job record you can inspect |
| Ordering | listener registration order | per-queue semantics |
| Latency | microseconds | a Redis round trip |
| Backpressure | none — every listener runs now | queue depth and concurrency limits |

The rule that follows:

:::danger Do not use an in-process event for anything that must happen
If the process exits between `emit()` and the listener's `await`, the work is gone. There is no record that it was supposed to happen, because there was never a record — only a function call that did not finish.

A welcome email, a webhook delivery, a payment capture, an audit entry you are required to keep, a search-index update: every one of those must be a queued job. See [Background jobs with BullMQ](bullmq.md).
:::

The shape that gets you both is the one in the listener above: **the event is the notification, the queue is the work.** The listener does one thing — add a job — and that `add` is a fast, retryable call to Redis. If the process dies before it, you have lost an enqueue rather than an email; if it dies after, the job is durable and a worker picks it up.

What in-process events are genuinely good for:

- **Decoupling modules within one process** — a domain module announcing, several others reacting, without import cycles.
- **Cache invalidation on this instance.** For other instances you need Redis pub/sub.
- **Metrics and counters** that are allowed to be approximate.
- **Triggering the enqueue** of durable work, as above.

And a fifth thing, worth saying explicitly: **transactional consistency is not one of them.** `emit()` after a database write is not atomic with it. If the transaction rolls back after the emit, listeners have already reacted to something that did not happen. Emit after the commit, and accept that the window between commit and emit is a window where the work is lost — or use a transactional outbox, which is the same "record it durably first" idea as the queue.

For events that must cross process boundaries, `@nestjs/microservices` and `@nestjs/cqrs` are the framework's answers — see [Microservices and transports](../nestjs-advanced/microservices.md) and [CQRS](../nestjs-advanced/cqrs.md).

## Security considerations

**A listener runs with no request context.** There is no `request.user` and no guard has run. Whatever authorization the emitting path did is not carried along — put the acting principal in the payload and scope the listener's queries to it, the same as any background work. See [Authorization](authorization.md).

**The payload is whatever the emitter passed.** A listener in another module is trusting that shape completely. A typed payload class is the only enforcement there is; there is no validation pipe on an event.

**Do not put secrets or bulk personal data in a payload.** It is passed to every matching listener, including a wildcard analytics listener you may have forgotten about, and it ends up in whatever those listeners log.

**A swallowed listener error is a silent failure of whatever the listener was for.** If the listener enforces something — writing an audit record, revoking a session, invalidating a permission cache — then `suppressErrors: true` means that enforcement can fail invisibly. Alert on those log lines.

**A wildcard listener sees every matching event.** Adding `billing.card.updated` later routes card metadata into a handler written for user events. Audit what `**` patterns exist before adding an event to a namespace.

**`maxListeners` exists to catch a leak.** Registering listeners at runtime — per request, per connection — without removing them is a memory leak and, eventually, a slow emit path. `verboseMemoryLeak: true` makes the warning name the event.

## Production considerations

**Listeners run on the same event loop as your request handlers.** A synchronous listener doing real work blocks every in-flight request. Even an async one competes for the loop. Keep them short and hand anything substantial to a queue.

**An unawaited `emit()` with async listeners produces work that outlives the response.** That is the intent, but it means an error in a listener can surface after the request has already returned 201 — so the log line is your only link back to the request. Log the event name and a correlation id from the payload.

**`emitAsync` puts every listener on the critical path.** One slow listener becomes your endpoint's p99. Prefer `emit`.

**Order is registration order, not priority.** `prependListener: true` is the only control, and depending on inter-listener ordering is a design smell — two listeners that must run in a specific order are one listener, or two steps of a workflow.

**Count events and listener failures.** An event whose emit rate suddenly changes, or a listener whose error rate is non-zero, are both invisible without a metric. See [Observability with @nestjs/observe](observe.md).

**Test the listener directly.** Unit-test the listener class as a plain class, and test the emit separately with a spied emitter. Testing "create a user and assert an email was sent" through the emitter couples two modules in one test and gives you a flaky one — see [Mocking providers](../nestjs-testing/mocking-providers.md).

**Emit after the commit, never inside the transaction.** Otherwise a rollback leaves listeners having acted on a fact that never became true.

## Common mistakes

- **Forgetting `EventEmitterModule.forRoot()`.** No discovery pass, so no listener is registered and nothing warns.
- **A listener class that is not a provider.** Same silent outcome.
- **Expecting `emit()` to wait.** It returns once listeners have been invoked, not once they have settled.
- **Relying on an in-process event for work that must happen.** A crash loses it with no record.
- **Assuming other replicas hear the event.** They do not. Instance-local cache invalidation only invalidates this instance.
- **Not knowing `suppressErrors` defaults to `true`.** Listener failures are logged and otherwise ignored.
- **Setting `suppressErrors: false` casually.** The throw propagates into the emitter's call stack, usually a request handler that had nothing to do with it.
- **Emitting inside a transaction.** A rollback leaves listeners acting on something that did not happen.
- **`@OnEvent('user.*')` without `wildcard: true`.** The pattern is treated as a literal event name and never fires.
- **Naming events as commands.** `send.email` is a method call wearing a costume; `user.created` is an event.
- **Heavy synchronous work in a listener.** It blocks the event loop that serves your requests.
- **Registering listeners at runtime without removing them.** A leak, and `maxListeners` is the only thing that tells you.
- **Chaining events.** A listener that emits, whose listener emits, is a control flow nobody can follow and a cycle nobody detects.

## Related topics

- [Background jobs with BullMQ](bullmq.md) — where anything that must survive a restart belongs.
- [Modules](../nestjs/modules.md) — registering the listener as a provider, which is what makes it discoverable.
- [Scheduling](schedule.md) — the other "runs outside a request" mechanism, with the same lack of request context.
- [CQRS](../nestjs-advanced/cqrs.md) — commands, queries and events with an explicit bus and handler contract.
- [Microservices and transports](../nestjs-advanced/microservices.md) — events that cross process boundaries.
- [Redis](../nestjs-databases/redis.md) — pub/sub, for the cross-replica case this package does not cover.
- [Authorization](authorization.md) — there is no request context in a listener.
- [Mocking providers](../nestjs-testing/mocking-providers.md) — testing the emitter and the listener separately.
- [Observability with @nestjs/observe](observe.md) — counting emits and listener failures.
- [Caching](cache-manager.md) — instance-local invalidation, and why it is not enough on its own.
