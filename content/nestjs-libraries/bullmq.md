---
title: Background jobs with BullMQ
description: "@nestjs/bullmq 12.0.0 with bullmq 6.3.4: BullModule.forRoot and registerQueue, @Processor with WorkerHost, job options, retries and backoff, idempotency, and separating the worker from the API."
status: current
updated: 2026-09-11
---

`@nestjs/bullmq` is **12.0.0**, wrapping `bullmq` **6.3.4**. It puts queues and workers in the DI container: `BullModule.registerQueue()` provides an injectable `Queue`, and a class decorated with `@Processor` that extends `WorkerHost` becomes a worker. The queue itself is Redis, and everything true about operating Redis applies.

## Why it exists

Some work should not happen inside a request. Sending an email, generating a PDF, calling a payment provider, re-indexing a document — each is slow, each can fail transiently, and each makes the caller wait for something they do not need to wait for.

A queue converts "do this now, synchronously, and hope" into "record that this must happen, and retry until it does". The three properties that matter:

- **Durability.** The job survives a deploy, a crash, and a Redis restart with persistence on. An `await sendEmail()` inside a handler does not.
- **Retries with backoff.** A provider's 30-second outage becomes a delayed retry rather than a lost email and a 500.
- **Isolation.** The work runs in a process that is not serving HTTP, so a slow job does not eat your request latency.

## Installing

```bash
npm install @nestjs/bullmq@12.0.0 bullmq@6.3.4
```

`@nestjs/bullmq` 12.0.0 peers on `bullmq` `^3 || ^4 || ^5 || ^6` and on `@nestjs/common`/`@nestjs/core` 10, 11 or 12. BullMQ needs a real Redis (or a compatible server) — not a cluster-mode-only setup unless you understand key hashing, and not an in-memory stub.

## Registering the connection and the queues

```ts title="src/app.module.ts"
import { Module } from '@nestjs/common'
import { ConfigModule, ConfigService } from '@nestjs/config'
import { BullModule } from '@nestjs/bullmq'

@Module({
  imports: [
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: {
          host: config.getOrThrow<string>('REDIS_HOST'),
          port: config.getOrThrow<number>('REDIS_PORT'),
          password: config.get<string>('REDIS_PASSWORD'),
          // BullMQ blocks on Redis; it requires this to be null.
          maxRetriesPerRequest: null,
        },
        prefix: config.get<string>('QUEUE_PREFIX', 'app'),
        defaultJobOptions: {
          attempts: 5,
          backoff: { type: 'exponential', delay: 2_000 },
          removeOnComplete: { age: 3_600, count: 1_000 },
          removeOnFail: { age: 7 * 24 * 3_600 },
        },
      }),
    }),
  ],
})
export class AppModule {}
```

```ts title="src/emails/emails.module.ts"
import { Module } from '@nestjs/common'
import { BullModule } from '@nestjs/bullmq'
import { EmailsService } from './emails.service.js'
import { EmailsProcessor } from './emails.processor.js'

@Module({
  imports: [BullModule.registerQueue({ name: 'emails' })],
  providers: [EmailsService, EmailsProcessor],
  exports: [BullModule],
})
export class EmailsModule {}
```

`forRoot` registers the shared connection and defaults; `registerQueue` creates one queue and its injection token. Re-export `BullModule` from the feature module so another module can inject the same queue after importing it.

:::warning `maxRetriesPerRequest: null`
BullMQ workers use blocking Redis commands. With ioredis's default `maxRetriesPerRequest`, a blocking call that outlives the retry budget is aborted and the worker throws. BullMQ documents `null` as the required value — set it, or expect intermittent worker crashes that look like Redis flapping.
:::

`prefix` namespaces every key. Two environments sharing one Redis without distinct prefixes is a staging worker processing production jobs, which is exactly as bad as it sounds.

## Producing jobs

```ts title="src/emails/emails.service.ts"
import { Injectable } from '@nestjs/common'
import { InjectQueue } from '@nestjs/bullmq'
import { Queue } from 'bullmq'

export interface WelcomeEmailJob {
  userId: string
  locale: string
}

@Injectable()
export class EmailsService {
  private readonly queue: Queue<WelcomeEmailJob>

  constructor(@InjectQueue('emails') queue: Queue<WelcomeEmailJob>) {
    this.queue = queue
  }

  async queueWelcome(userId: string, locale: string) {
    await this.queue.add(
      'welcome',
      { userId, locale },
      {
        jobId: `welcome:${userId}`,
        attempts: 5,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: { age: 3_600 },
        removeOnFail: { age: 7 * 24 * 3_600 },
      },
    )
  }
}
```

The first argument is the **job name**, which the processor switches on; the second is the payload; the third is per-job options that override `defaultJobOptions`.

| Option | What it does |
| --- | --- |
| `jobId` | your own id. BullMQ refuses a duplicate, which is deduplication for free |
| `attempts` | total tries, including the first |
| `backoff` | `{ type: 'exponential' \| 'fixed', delay }`, or a named custom strategy |
| `delay` | milliseconds before the job becomes available |
| `priority` | lower number runs first; adds cost, so use it sparingly |
| `removeOnComplete` | `true`, a count, or `{ age, count }` |
| `removeOnFail` | same shape; keep failures longer than successes |
| `lifo` | process most-recent-first |

**The payload must be JSON-serializable and small.** It goes into Redis. Pass an id, not a 4 MB buffer and not an entity with a circular reference — the worker can load whatever it needs.

Typing the queue (`Queue<WelcomeEmailJob>`) is the cheapest correctness win here. Producer and consumer are in different files and often different processes; without a shared type, a renamed field is a runtime failure in a worker log nobody is reading.

## Consuming jobs

```ts title="src/emails/emails.processor.ts"
import { Logger } from '@nestjs/common'
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq'
import { Job, UnrecoverableError } from 'bullmq'
import { MailClient } from './mail.client.js'
import { UsersService } from '../users/users.service.js'
import type { WelcomeEmailJob } from './emails.service.js'

@Processor('emails', { concurrency: 10, limiter: { max: 50, duration: 1_000 } })
export class EmailsProcessor extends WorkerHost {
  private readonly logger = new Logger(EmailsProcessor.name)
  private readonly mail: MailClient
  private readonly users: UsersService

  constructor(mail: MailClient, users: UsersService) {
    super()
    this.mail = mail
    this.users = users
  }

  async process(job: Job<WelcomeEmailJob>): Promise<void> {
    switch (job.name) {
      case 'welcome':
        return this.sendWelcome(job)
      default:
        // An unknown name is a deploy skew, not a transient failure.
        throw new UnrecoverableError(`Unknown job name: ${job.name}`)
    }
  }

  private async sendWelcome(job: Job<WelcomeEmailJob>): Promise<void> {
    const user = await this.users.findById(job.data.userId)
    if (!user) {
      // The user was deleted between enqueue and execution. Retrying
      // will never help, so stop now instead of burning five attempts.
      throw new UnrecoverableError('User no longer exists')
    }

    await job.updateProgress(50)
    await this.mail.sendWelcome(user.email, job.data.locale, {
      idempotencyKey: `welcome:${user.id}`,
    })
    await job.updateProgress(100)
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job<WelcomeEmailJob> | undefined, error: Error) {
    this.logger.error(
      `job ${job?.id} failed on attempt ${job?.attemptsMade} of ${job?.opts.attempts}: ${error.message}`,
    )
  }

  @OnWorkerEvent('completed')
  onCompleted(job: Job<WelcomeEmailJob>) {
    this.logger.log(`job ${job.id} completed`)
  }
}
```

`WorkerHost` is an abstract class with one abstract method, `process(job, token)`. Extending it and decorating the class with `@Processor` is what registers a BullMQ `Worker`; the underlying worker is reachable as `this.worker`.

`@Processor` takes the queue name plus BullMQ worker options — or a Nest-specific options object `{ name, scope, configKey }` followed by worker options.

| Worker option | Why |
| --- | --- |
| `concurrency` | how many jobs this worker runs at once. Default is 1, which surprises people |
| `limiter: { max, duration }` | a rate limit across the worker, for provider quotas |
| `lockDuration` | how long a job's lock is held before it is considered stalled |
| `autorun` | `false` to start the worker manually |

**Concurrency defaults to 1.** A worker that processes one job at a time while your queue depth grows is the most common "BullMQ is slow" report.

### Failing correctly

Throwing from `process()` fails the attempt and BullMQ retries it per `attempts` and `backoff`. Throwing `UnrecoverableError` marks the job failed **immediately**, skipping the remaining attempts.

Use it. The distinction is whether a retry could plausibly succeed:

| Failure | Retry? |
| --- | --- |
| provider 503, connection reset, timeout | yes — transient |
| 429 from a provider | yes, with backoff |
| the referenced row no longer exists | no — `UnrecoverableError` |
| the payload does not match the current schema | no — `UnrecoverableError` |
| a validation error in the payload | no — `UnrecoverableError` |

Retrying an unrecoverable failure five times with exponential backoff wastes half an hour and fills your logs with the same message five times.

### Worker events

`@OnWorkerEvent(name)` registers a listener on this processor's worker: `'completed'`, `'failed'`, `'active'`, `'progress'`, `'stalled'`, `'error'`, `'drained'`. `@OnQueueEvent` on a `QueueEventsHost` subclass listens to the queue-wide stream instead, which is what you want for events from workers in *other* processes.

`'stalled'` is worth logging on its own: it means a job's lock expired while it was supposedly being processed, which almost always means the handler blocked the event loop for longer than `lockDuration`.

## Idempotency

**Assume every job can run twice.** A worker that finishes the work and dies before acknowledging it leaves the job to be retried; a stalled job is re-delivered; a `jobId` collision that you cleaned up returns. None of these are bugs you can eliminate, so make the second run harmless.

Three mechanisms, in order of preference:

**1. A deterministic `jobId`.** `jobId: 'welcome:${userId}'` means the second `add()` is refused while a job with that id exists. This is deduplication at enqueue time and it is nearly free. Note the caveat: once the job is removed by `removeOnComplete`, the id is available again — so it prevents duplicate *queueing*, not duplicate *execution across time*.

**2. An idempotency key at the far end.** Most payment and email providers accept one and deduplicate server-side. This is the only mechanism that survives "we sent the request, then crashed before recording that we did".

**3. A uniqueness constraint you own.**

```ts title="src/emails/sent-email.repository.ts"
// A unique index on (user_id, kind) turns "send twice" into a constraint
// violation you can swallow, instead of a duplicate the customer sees.
async recordSend(userId: string, kind: string): Promise<boolean> {
  const result = await this.pool.query(
    'INSERT INTO sent_emails (user_id, kind, sent_at) VALUES ($1, $2, now()) ON CONFLICT DO NOTHING',
    [userId, kind],
  )
  return result.rowCount === 1
}
```

Check the return value *before* doing the side effect, and record the send in the same transaction as any other state change the job makes.

:::best-practice
Write down, for each job, what happens if it runs twice. If the answer is "a duplicate charge" or "a duplicate email", one of the three mechanisms above is not optional. If the answer is "nothing", say so in a comment so the next person does not add one unnecessarily.
:::

## Separating the worker from the API

The default `nest start` runs everything in one process: HTTP handlers and workers on the same event loop, competing for the same CPU and the same database pool. That is fine in development and wrong in production.

Split them with two bootstraps over one codebase.

```ts title="src/main.ts"
import { NestFactory } from '@nestjs/core'
import { ApiModule } from './api.module.js'

async function bootstrap() {
  const app = await NestFactory.create(ApiModule)
  app.enableShutdownHooks()
  await app.listen(3000)
}

bootstrap()
```

```ts title="src/worker.ts"
import { NestFactory } from '@nestjs/core'
import { WorkerModule } from './worker.module.js'

async function bootstrap() {
  // No HTTP listener: this process only runs workers.
  const app = await NestFactory.createApplicationContext(WorkerModule)
  app.enableShutdownHooks()
}

bootstrap()
```

`ApiModule` imports the feature modules and `BullModule.registerQueue()` — it *produces* jobs. `WorkerModule` imports the processors. The shared services live in modules both import.

```json title="package.json"
{
  "scripts": {
    "start:api": "node dist/main.js",
    "start:worker": "node dist/worker.js"
  }
}
```

What you get:

- The API's latency is unaffected by a job that pegs a core.
- Workers scale independently — three API pods and ten worker pods, or zero workers overnight.
- A worker crash from a poison job does not take HTTP traffic down with it.
- Each process gets its own connection pool, sized for what it actually does.

`NestFactory.createApplicationContext()` is the right factory: it builds the DI container and runs lifecycle hooks without an HTTP adapter.

:::warning Shutdown
`app.enableShutdownHooks()` is what lets BullMQ close its workers on `SIGTERM`, which means finishing the in-flight job rather than abandoning it mid-write. Without it, every deploy abandons whatever was running, and those jobs come back as stalled. See [Graceful shutdown](../nestjs-production/graceful-shutdown.md).
:::

## Security considerations

**The payload is stored in Redis in plaintext.** Do not put a password, a token, a card number or a full personal record in `job.data`. Store an id and let the worker load what it needs from the database, where your access controls already are.

**A job runs with no request context.** There is no `request.user`, so nothing constrains what the worker touches. Carry the acting principal in the payload explicitly, and scope every query to it the way a service would — see [Authorization](authorization.md).

**Validate the payload in the worker.** It came from another process, possibly an older deploy, and it has been sitting in Redis. Treat it as input: parse it before you trust it, the same way you would a request body — see [The ValidationPipe](../nestjs-validation/validation-pipe.md).

**Do not log `job.data`.** It is application data and often personal data. Log the job id, the name, the attempt number and the error — see [Safe logging](../nestjs-security/safe-logging.md).

**Redis needs a password and network isolation.** Anyone who can reach the queue can read every payload, delete jobs, and insert their own for your workers to execute. That last one is remote code execution by proxy if a job name dispatches to something powerful.

**A poison job is a denial-of-service vector.** A job that crashes the worker process, retried forever, is an infinite crash loop. Bounded `attempts` plus `UnrecoverableError` for permanent failures is the defense.

**Rate-limit outbound work with `limiter`.** A queue that drains at full speed into a third-party API gets your credentials throttled or banned; the `limiter` option is cheaper than discovering the provider's limits in production.

## Production considerations

**Run workers as their own deployment.** It is the single highest-value change on this page.

**Set `concurrency` deliberately.** The default of 1 underuses a worker; a high value on an IO-bound job is fine, while on a CPU-bound job it just multiplies event-loop starvation. Measure.

**Set `removeOnComplete` and `removeOnFail`.** BullMQ keeps completed and failed jobs forever by default. An unbounded completed set is a Redis memory leak on a schedule. `{ age: 3600, count: 1000 }` for successes and a week for failures is a reasonable starting point — keep failures longer, because they are the ones you will want to inspect.

**Monitor queue depth, not just errors.** Waiting count, active count, failed count and oldest-waiting age. A queue whose depth grows monotonically is a worker that is not keeping up, and you want to know that before the backlog is a day long. Wire it into a health indicator — see [Health checks with Terminus](terminus.md).

**Alert on the failed set.** A job that exhausted its attempts is sitting in Redis being ignored. Decide whether you retry it manually, move it to a dead-letter queue, or drop it, and make somebody responsible for that decision.

**`lockDuration` must exceed your longest job.** A job that runs longer than its lock is marked stalled and re-delivered while the original is still running, which is a duplicate execution you built idempotency to survive but should not be causing routinely.

**Deploy-time schema skew is real.** During a rolling deploy, an old worker can pick up a job produced by a new API. Version the payload, keep changes additive, and make an unknown shape an `UnrecoverableError` rather than a crash.

**Redis persistence matters here in a way it does not for a cache.** A cache that loses everything is slow for a minute. A queue that loses everything has lost work you told the user was accepted. Configure AOF or an appropriate RDB cadence, and do not share the instance with a cache configured to evict — see [Redis](../nestjs-databases/redis.md).

**Give the worker its own database pool size.** Ten concurrent jobs each taking a connection will exhaust a pool sized for an idle API — see [Connection pooling](../nestjs-databases/connection-pooling.md).

## Common mistakes

- **Running workers in the API process.** Job latency becomes request latency, and a heavy job makes the health check time out.
- **Omitting `maxRetriesPerRequest: null`.** Blocking commands abort and workers crash intermittently.
- **Leaving `concurrency` at 1** and concluding the queue is slow.
- **No `removeOnComplete`.** Redis memory grows until it does not.
- **Large payloads in `job.data`.** Redis memory, serialization cost, and a hard size ceiling you hit at the worst moment.
- **Secrets or personal data in the payload.** Plaintext in Redis, and in any log line that prints the job.
- **No `attempts`, or infinite retries.** A permanently broken job retried forever.
- **Retrying an unrecoverable failure.** Use `UnrecoverableError` for "this will never work".
- **Assuming exactly-once delivery.** It is at-least-once. Build for a second run.
- **Forgetting `enableShutdownHooks()`.** Every deploy abandons in-flight jobs.
- **Forgetting `super()` in the processor constructor.** `WorkerHost` needs it, and the failure is a runtime error at boot.
- **Not exporting `BullModule` from the feature module.** Another module importing yours cannot inject the queue and gets an unresolved-dependency error.
- **One Redis, no `prefix`, two environments.** Staging workers processing production jobs.
- **`lockDuration` shorter than the job.** Routine stall-and-redeliver, which looks exactly like a bug in your handler.
- **Never looking at the failed set.** Work you told the user was accepted, quietly discarded.

## Related topics

- [Scheduling](schedule.md) — cron that enqueues instead of executing, which is how you avoid running a job once per replica.
- [Redis](../nestjs-databases/redis.md) — persistence, eviction policy, and why a queue must not share an instance with a cache.
- [Graceful shutdown](../nestjs-production/graceful-shutdown.md) — finishing the in-flight job on `SIGTERM`.
- [Health checks with Terminus](terminus.md) — a custom indicator for queue depth.
- [Connection pooling](../nestjs-databases/connection-pooling.md) — sizing the worker's pool for its concurrency.
- [The ValidationPipe](../nestjs-validation/validation-pipe.md) — validating a payload that arrived from another process.
- [Authorization](authorization.md) — there is no request context in a worker.
- [Logging](logging.md) — what a worker should record per job.
- [Safe logging](../nestjs-security/safe-logging.md) — keeping payloads out of the log platform.
- [Performance](../nestjs-production/performance.md) — the event loop a co-located worker competes for.
