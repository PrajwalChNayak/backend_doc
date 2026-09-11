---
title: Scheduling
description: Cron jobs, intervals and timeouts with @nestjs/schedule 12.0.1 — the decorators, SchedulerRegistry for dynamic jobs, and the multi-replica problem that makes every one of them run N times.
status: current
updated: 2026-09-11
---

`@nestjs/schedule` is **12.0.1**. It wraps the `cron` package (4.4.0) and Node's own `setInterval`/`setTimeout` in three decorators and a registry, and discovers decorated methods on every provider at bootstrap. It is genuinely convenient, and it has one failure mode that catches almost everyone the first time they scale past a single replica.

## Why it exists

A scheduled task that lives inside your application can inject your services, share your database pool, and be tested with your testing module. A system `crontab` calling a separate script can do none of those, and drifts out of sync with the code it is supposed to exercise.

The trade-off is that the task now shares a process with your request handlers — so it competes for the same event loop, and it runs once per replica. Both of those are addressable; neither is addressed for you.

## Installing

```bash
npm install @nestjs/schedule@12.0.1
```

```ts title="src/app.module.ts"
import { Module } from '@nestjs/common'
import { ScheduleModule } from '@nestjs/schedule'
import { ReportsModule } from './reports/reports.module.js'

@Module({
  imports: [ScheduleModule.forRoot(), ReportsModule],
})
export class AppModule {}
```

`forRoot()` installs the explorer that scans providers for the decorators. Without it, every `@Cron` in the application is inert and nothing warns you.

`ScheduleModuleOptions` takes three booleans — `cronJobs`, `intervals`, `timeouts` — which switch each kind of discovery on or off. `ScheduleModule.forRoot({ cronJobs: true, intervals: false, timeouts: false })` is a blunt but effective way to make a worker process run only the cron jobs.

## The decorators

```ts title="src/reports/reports.scheduler.ts"
import { Injectable, Logger } from '@nestjs/common'
import { Cron, CronExpression, Interval, Timeout } from '@nestjs/schedule'
import { ReportsService } from './reports.service.js'

@Injectable()
export class ReportsScheduler {
  private readonly logger = new Logger(ReportsScheduler.name)
  private readonly reports: ReportsService

  constructor(reports: ReportsService) {
    this.reports = reports
  }

  @Cron('0 15 3 * * *', {
    name: 'nightly-rollup',
    timeZone: 'Europe/Berlin',
    waitForCompletion: true,
  })
  async nightlyRollup() {
    this.logger.log('starting nightly rollup')
    await this.reports.rollUpYesterday()
  }

  @Cron(CronExpression.EVERY_30_MINUTES, { name: 'refresh-exchange-rates' })
  async refreshRates() {
    await this.reports.refreshExchangeRates()
  }

  @Interval('cleanup-temp', 60_000)
  async cleanupTemp() {
    await this.reports.deleteExpiredExports()
  }

  @Timeout('warm-cache', 10_000)
  async warmCache() {
    await this.reports.warmSummaryCache()
  }
}
```

| Decorator | Fires | Naming |
| --- | --- | --- |
| `@Cron(expression, options)` | on a cron schedule, a `Date`, or a Luxon `DateTime` | `options.name` |
| `@Interval(timeout)` / `@Interval(name, timeout)` | every `timeout` ms, forever | the optional first argument |
| `@Timeout(timeout)` / `@Timeout(name, timeout)` | once, `timeout` ms after bootstrap | the optional first argument |

Name every job. The name is how `SchedulerRegistry` finds it, how a log line identifies it, and how you stop it in a test.

`CronExpression` is an enum of ready-made expressions — `EVERY_30_SECONDS`, `EVERY_DAY_AT_3AM`, `EVERY_WEEKDAY`, `MONDAY_TO_FRIDAY_AT_09_30AM`, and dozens more. Prefer it over a hand-written string for anything it already covers; a six-field expression with the seconds field forgotten is a job that runs sixty times more often than you meant.

:::note
The `cron` package accepts **six** fields, with seconds first. `'0 15 3 * * *'` is 03:15:00 every day. A five-field expression is interpreted with minutes first, the way a Unix crontab does. `CronExpression` mixes both forms — `EVERY_MINUTE` is five fields, `EVERY_30_SECONDS` is six — because both are valid. Count the fields before you trust a schedule.
:::

### `CronOptions`

| Option | Effect |
| --- | --- |
| `name` | register the job under this name for `SchedulerRegistry` |
| `timeZone` | IANA zone the expression is evaluated in; an invalid zone throws |
| `utcOffset` | an offset instead of a zone — do not set both |
| `waitForCompletion` | skip a tick entirely while the previous run is still going |
| `disabled` | register but do not run; default `false` |
| `initialDelay` | ms to wait after bootstrap before the first execution |
| `threshold` | ms of tolerated lateness before a missed deadline is skipped rather than run; default 250 |
| `unrefTimeout` | do not hold the event loop open for this job |

**`waitForCompletion: true` is the option most people need and do not set.** Without it, a job scheduled every five minutes that takes six minutes has two copies running, then three, and your database sees a slowly growing pile of identical transactions.

**Always set `timeZone` explicitly** for anything a human reasons about. "Run at 3 a.m." means 3 a.m. somewhere; the container's clock is UTC, the person who filed the ticket is not, and daylight saving moves the answer twice a year.

`initialDelay` exists for the job that needs a warm connection pool or a populated cache. It is a better answer than a `setTimeout` inside the handler because the scheduler still owns the lifecycle.

## Dynamic jobs with `SchedulerRegistry`

Decorators are for schedules known at compile time. For a schedule that comes from a database row or a tenant's settings, register the job yourself.

```ts title="src/reports/digest.scheduler.ts"
import { Injectable, OnModuleInit } from '@nestjs/common'
import { SchedulerRegistry } from '@nestjs/schedule'
import { CronJob } from 'cron'
import { DigestService } from './digest.service.js'

@Injectable()
export class DigestScheduler implements OnModuleInit {
  private readonly registry: SchedulerRegistry
  private readonly digests: DigestService

  constructor(registry: SchedulerRegistry, digests: DigestService) {
    this.registry = registry
    this.digests = digests
  }

  async onModuleInit() {
    for (const tenant of await this.digests.tenantsWithDigests()) {
      this.schedule(tenant.id, tenant.cronExpression, tenant.timeZone)
    }
  }

  schedule(tenantId: string, expression: string, timeZone: string) {
    const name = `digest:${tenantId}`
    if (this.registry.doesExist('cron', name)) {
      this.registry.deleteCronJob(name)
    }

    const job = CronJob.from({
      cronTime: expression,
      onTick: () => {
        void this.digests.sendFor(tenantId)
      },
      timeZone,
      waitForCompletion: true,
      start: false,
    })

    this.registry.addCronJob(name, job)
    job.start()
  }

  unschedule(tenantId: string) {
    const name = `digest:${tenantId}`
    if (this.registry.doesExist('cron', name)) {
      this.registry.deleteCronJob(name)
    }
  }
}
```

`SchedulerRegistry` in 12.0.1:

| Method | Notes |
| --- | --- |
| `doesExist(type, name)` | `type` is `'cron' \| 'timeout' \| 'interval'` |
| `addCronJob(name, job)` / `getCronJob(name)` / `deleteCronJob(name)` | `deleteCronJob` stops the job as well as removing it |
| `getCronJobs()` | a `Map` of every registered cron job |
| `addInterval(name, id)` / `getInterval(name)` / `deleteInterval(name)` / `getIntervals()` | `getIntervals()` returns names |
| `addTimeout(name, id)` / `getTimeout(name)` / `deleteTimeout(name)` / `getTimeouts()` | same |

`CronJob.from({ … })` is the readable constructor in `cron` 4.x; the long positional form still exists and has thirteen parameters, which is thirteen chances to put `timeZone` where `context` goes.

`addCronJob()` registers a job; it does **not** start it. Call `job.start()`, or pass `start: true`. A job that is registered and never started is the quietest bug on this page — the registry lists it and it never fires.

Adding a `setInterval` handle without `addInterval()` works, and then nothing shuts it down cleanly, so register it.

:::danger Validate a cron expression that came from a user
`new CronJob('not a schedule', …)` throws. If the expression comes from a tenant's settings, validate it at the point of *input* — inside `onModuleInit`, a single bad row throws during bootstrap and the application never starts. Wrap the loop in a try/catch that logs and skips, and reject the expression in the DTO before it is ever stored.
:::

## The multi-replica problem

This is the one that matters.

**Every replica runs every scheduled job.** Three pods means the nightly rollup runs three times, the digest email goes out three times, and the "delete rows older than 90 days" job runs three times concurrently against the same table. `@nestjs/schedule` has no coordination — it is `setInterval` and `cron` inside a process, and it has no idea another process exists.

The symptom is not always obvious. An idempotent job just wastes work. A job that sends email sends duplicates. A job that increments a counter triple-counts. A job that takes a lock you did not write deadlocks with itself.

There are three real answers.

### 1. Enqueue instead of executing

The best answer. The cron handler does nothing but add one job to a queue with a **deterministic job id**; BullMQ deduplicates on that id, so three replicas adding the same id produce one job, and one worker runs it.

```ts title="src/reports/rollup.scheduler.ts"
import { Injectable } from '@nestjs/common'
import { InjectQueue } from '@nestjs/bullmq'
import { Cron } from '@nestjs/schedule'
import { Queue } from 'bullmq'

@Injectable()
export class RollupScheduler {
  private readonly queue: Queue

  constructor(@InjectQueue('reports') queue: Queue) {
    this.queue = queue
  }

  @Cron('0 15 3 * * *', { name: 'nightly-rollup', timeZone: 'Etc/UTC' })
  async enqueueRollup() {
    const day = new Date().toISOString().slice(0, 10)
    await this.queue.add(
      'daily-rollup',
      { day },
      { jobId: `daily-rollup:${day}`, attempts: 3, backoff: { type: 'exponential', delay: 30_000 } },
    )
  }
}
```

You get deduplication, retries, backoff, a record of failures, and the work running off the request-handling event loop. BullMQ also has its own repeatable-job scheduling, which removes `@nestjs/schedule` from the picture entirely for this kind of work — see [Background jobs with BullMQ](bullmq.md).

### 2. Take a distributed lock

When a queue is more machinery than the job deserves, have every replica try to acquire a short-lived lock and let exactly one win.

```ts title="src/common/lock.service.ts"
import { Injectable } from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import Redis from 'ioredis'

@Injectable()
export class LockService {
  private readonly redis: Redis

  constructor(redis: Redis) {
    this.redis = redis
  }

  /** Runs `fn` only if this process wins the lock. Returns false if it did not. */
  async withLock(key: string, ttlMs: number, fn: () => Promise<void>): Promise<boolean> {
    const token = randomUUID()
    const acquired = await this.redis.set(`lock:${key}`, token, 'PX', ttlMs, 'NX')
    if (acquired !== 'OK') return false

    try {
      await fn()
      return true
    } finally {
      // Release only if we still hold it: a lock that expired mid-run now
      // belongs to somebody else, and deleting it would be worse than leaking it.
      const current = await this.redis.get(`lock:${key}`)
      if (current === token) await this.redis.del(`lock:${key}`)
    }
  }
}
```

The TTL must exceed the job's worst-case duration, or a second replica starts while the first is still running — which is the exact thing you were preventing. Size it generously and make the job idempotent anyway.

A `SELECT … FOR UPDATE` on a `scheduled_jobs` row, or a unique index on `(job_name, run_date)`, does the same thing without adding Redis. The uniqueness approach is attractive because the database enforces it: three inserts, one succeeds, two get a constraint violation they can swallow.

### 3. Run the scheduler in exactly one place

A separate deployment with one replica, or a leader-elected sidecar. This trades the coordination problem for a single point of failure and a second deployment to operate — but for a small number of heavy nightly jobs it is often the simplest thing that is obviously correct.

`ScheduleModule.forRoot()` behind a config flag is the mechanism: the API deployment imports the module with all three discovery flags off, the scheduler deployment imports it fully.

:::best-practice
Whichever you pick, **make the job idempotent**. Locks expire, queues occasionally deliver twice, and leaders occasionally overlap during a failover. A job that can run twice without harm makes all three mechanisms into optimizations rather than correctness requirements.
:::

## Errors and the event loop

A scheduled method that rejects has nobody to catch it. `SchedulerRegistry` wraps registered functions defensively, but the reliable contract is the one you write:

```ts
@Cron(CronExpression.EVERY_HOUR, { name: 'sync-catalog', waitForCompletion: true })
async syncCatalog() {
  try {
    await this.catalog.sync()
  } catch (error) {
    this.logger.error('catalog sync failed', error instanceof Error ? error.stack : String(error))
    // Swallowed deliberately: the next tick retries. Alert on the log line.
  }
}
```

And remember where this runs: **the same event loop as your HTTP handlers**. A job that does five minutes of synchronous JSON parsing stops the application from answering requests for five minutes, and your health check times out. CPU-bound work belongs in a worker process — see [Background jobs with BullMQ](bullmq.md) and [Performance](../nestjs-production/performance.md).

## Security considerations

**A cron expression from a user is executable configuration.** `* * * * * *` is a job every second, forever, per tenant. Validate it in the DTO, cap the frequency, and cap the number of jobs a tenant may register.

**Scheduled jobs run with no request context and therefore no authorization.** There is no `request.user`, so nothing constrains what a job touches. Scope every query the job runs to the tenant it is acting for, explicitly and in the `WHERE` clause — the same rule as [Authorization](authorization.md), with the guard removed.

**A job that sends mail, charges a card or calls a webhook is an amplifier.** Multiplied by replica count, a bug here is a duplicate charge, not a duplicate log line. This is the concrete reason the multi-replica section matters.

**Do not log the job's payload.** A digest job's data is customer data; see [Safe logging](../nestjs-security/safe-logging.md).

**Secrets a job needs come from the same validated config as everything else.** A job is not a reason to reach into `process.env` — see [Configuration](../nestjs/configuration.md).

**A long-running job holds a connection.** A job that takes a pooled connection for ten minutes has taken it from your request handlers. Give background work its own small pool, or its own process.

## Production considerations

**Decide the multi-replica story before the second replica exists**, not after the duplicate emails. Write down which of the three answers you chose, in the code, next to the job.

**Set `timeZone` on every human-facing schedule.** Containers run UTC; "3 a.m." does not.

**`waitForCompletion: true` on anything that can outrun its interval.** The default is overlapping executions.

**Log start, end and duration for every job**, with the job name. A job that silently stopped running is invisible otherwise, and a job whose duration is creeping toward its interval is about to become an overlapping-execution incident.

**Alert on absence, not only on failure.** "The nightly rollup has not reported success in 26 hours" catches the case where the scheduler never started — which no error log will ever tell you about.

**Jobs must survive shutdown.** `SIGTERM` arrives mid-run eventually. With `enableShutdownHooks()`, a job that checks a shutting-down flag between units of work can stop cleanly; a job that cannot be interrupted should be short enough not to matter, or should be a queued job with retries. See [Graceful shutdown](../nestjs-production/graceful-shutdown.md).

**Keep the scheduler off the request path where you can.** The cleanest production shape is: cron enqueues, workers execute, the API process does neither.

**A `@Timeout` fires relative to bootstrap.** In a rolling deploy, that means once per new pod, which is not "once".

## Common mistakes

- **Forgetting `ScheduleModule.forRoot()`.** Every decorator is inert and nothing says so.
- **Assuming a job runs once when you have three replicas.** It runs three times, concurrently.
- **A five-field expression where you meant six.** `'*/5 * * * *'` is every five minutes; `'*/5 * * * * *'` is every five seconds.
- **No `waitForCompletion`.** Overlapping executions pile up until something breaks.
- **No `timeZone`.** The schedule drifts by an hour twice a year and nobody knows why.
- **`addCronJob()` without `job.start()`.** Registered, listed, never fires.
- **An unvalidated cron expression from a tenant.** A throw during `onModuleInit` stops the whole application from booting.
- **A lock TTL shorter than the job.** The lock expires, a second replica starts, and you have the problem you were preventing plus a lock nobody owns.
- **Releasing a lock without checking the token.** You delete somebody else's lock.
- **CPU-bound work in a scheduled method.** It blocks the event loop that serves your HTTP requests.
- **An unhandled rejection in a job.** Depending on the Node flags, that is a crashed process.
- **`setInterval` in `onModuleInit` without `registry.addInterval()`.** Nothing stops it on shutdown and the process will not exit.
- **Alerting only on job failure.** A scheduler that never started produces no failures.

## Related topics

- [Background jobs with BullMQ](bullmq.md) — durable jobs, deduplication by id, retries, and running work off the API process.
- [Redis](../nestjs-databases/redis.md) — the store behind the lock and the queue.
- [Graceful shutdown](../nestjs-production/graceful-shutdown.md) — stopping a job mid-run without losing it.
- [Clustering](../nestjs-production/clustering.md) — why more than one process exists in the first place.
- [Configuration](../nestjs/configuration.md) — feature-flagging the scheduler per deployment.
- [Authorization](authorization.md) — there is no request context in a job, so the scoping is yours.
- [Logging](logging.md) — job start, end, duration, and alerting on absence.
- [Performance](../nestjs-production/performance.md) — the event loop the scheduler shares with your handlers.
- [Safe logging](../nestjs-security/safe-logging.md) — what a job may record about the rows it touched.
