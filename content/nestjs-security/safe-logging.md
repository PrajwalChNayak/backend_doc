---
title: Safe logging
description: Keeping credentials and PII out of a NestJS 12 service's logs — the v12 ConsoleLogger structured-params behaviour, pino 10.3.1 redact paths for nestjs-pino 5.1.0, errors that carry secrets, tokens in query strings, and correlation IDs.
status: current
updated: 2026-09-11
---

Your logs are read by more people than your database, retained longer than you think, and copied into a third-party aggregator that has its own access model. Anything you write into them is disclosed to that whole audience, and unlike a database row you cannot delete it selectively. This page is about making that safe in a Nest 12 service, where the two things that decide the outcome are how you *call* the logger and how the transport is configured.

The general treatment — retention policy, the erasure obligation, correlation-ID design — is in [Logging without leaking PII](../security/logging-without-leaking-pii.md). The transport setup is in [Logging](../nestjs-libraries/logging.md). This page is the leaks.

## What must never appear in a log line

| Never | Why |
| --- | --- |
| Passwords, in any form, including "wrong" ones | users reuse them; a failed attempt is still a real password from somewhere |
| `Authorization` headers, JWTs, API keys, session identifiers | each is a working credential for as long as it is valid |
| `Cookie` and `Set-Cookie` headers | the session identifier is in there |
| Full card numbers, CVV, bank details | regulated, and there is no legitimate reason |
| Government identifiers, health data | regulated, and disclosure is the harm |
| Full request bodies on authentication, payment or profile routes | every one of the above lives in one |
| Database query parameters | the values are the data you were protecting |
| A connection string with a password in it | it appears in exactly the error you were debugging |

| Log instead | Why it is enough |
| --- | --- |
| A user id | resolves to the person when you are entitled to look |
| A correlation id | ties the request together without naming anybody |
| `email.length`, or a hash prefix | proves shape without disclosing the value |
| The last four digits of a card | what the user themselves sees |
| A status code, a route template, a duration | everything an operator actually needs |

## The leak

### The exploit

The attacker here is not necessarily an attacker. It is anybody with read access to your log aggregator — which, at most companies, is far more people than have production database access.

:::danger A login handler that logs the payload
```ts vulnerable title="DO NOT COPY — src/auth/auth.controller.ts"
import { Body, Controller, Logger, Post } from '@nestjs/common'
import { LoginDto } from './dto/login.dto.js'

@Controller('auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name)

  @Post('login')
  async login(@Body() dto: LoginDto) {
    // "Just while we debug the mobile client." It shipped.
    this.logger.debug(`login attempt: ${JSON.stringify(dto)}`)
    return this.auth.login(dto)
  }
}
```
:::

```bash
curl -s -X POST localhost:3000/auth/login -H 'content-type: application/json' \
  -d '{"email":"dana@example.test","password":"Summer2024!"}'
```

```text title="what lands in the aggregator"
[Nest] 4711  - 09/11/2026, 10:14:02   DEBUG [AuthController] login attempt: {"email":"dana@example.test","password":"Summer2024!"}
```

Now the search that turns this into an incident:

```bash
# Anybody with read access to the log platform.
logcli query '{app="api"} |= "password"' --since=720h --limit=100000 | wc -l
```

```text
418277
```

Four hundred thousand plaintext passwords, retained for thirty days, searchable, exported to whoever asked for a dashboard. No vulnerability was exploited. Somebody added a debug line.

The same line also fails the redaction fix below, and that is the part worth understanding.

## Why structured params are the prerequisite

NestJS 12's `ConsoleLogger` treats plain objects passed **after** the first argument as structured metadata rather than as extra messages. `structuredParams` defaults to **`true`**.

```ts good title="src/auth/auth.controller.ts"
import { Body, Controller, Logger, Post } from '@nestjs/common'
import { LoginDto } from './dto/login.dto.js'

@Controller('auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name)

  @Post('login')
  async login(@Body() dto: LoginDto) {
    // The message is a constant. The data is a named object. Nothing here
    // is a credential, and every field has a key a redactor can target.
    this.logger.log('Login attempt', { emailLength: dto.email.length, result: 'pending' })
    return this.auth.login(dto)
  }
}
```

With `json: true` that produces a record rather than a sentence:

```json title="one line of stdout"
{
  "level": "log",
  "pid": 4711,
  "timestamp": 1789121642000,
  "message": "Login attempt",
  "context": "AuthController",
  "params": { "emailLength": 17, "result": "pending" }
}
```

The relevant options, from the shipped `ConsoleLoggerOptions`:

| Option | Default | Effect |
| --- | --- | --- |
| `structuredParams` | **`true`** | trailing plain objects become `params` instead of extra messages |
| `flattenParams` | `false` | in `json` mode, spread `params` into the root; framework keys win on a collision |
| `json` | `false` | emit one JSON object per line |
| `maxStringLength` | `10000` | truncates long values in non-JSON output |

```ts good title="src/main.ts"
import { ConsoleLogger } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module.js'

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: new ConsoleLogger({
      json: process.env.NODE_ENV === 'production',
      colors: process.env.NODE_ENV !== 'production',
      logLevels: process.env.NODE_ENV === 'production' ? ['log', 'warn', 'error', 'fatal'] : undefined,
    }),
  })
  await app.listen(3000)
}

bootstrap()
```

**This is what makes redaction possible at all.** A redactor works on keys: it can find `params.password` in a tree and replace it. It cannot find a password inside `"login attempt: {\"password\":\"Summer2024!\"}"`, because by the time the string exists there is no structure left — the value has been smeared into the message. Interpolating data into the message is not a style preference; it is the decision that makes every downstream control impossible.

:::best-practice
Message strings are constants. Data goes in the object. Enforce it with a lint rule that bans template literals in logger calls, and you have removed a whole class of leak before it can be written.
:::

The same rule applies to `nestjs-pino`'s `Logger`, which implements the same Nest `LoggerService` interface, and whose `nativeLogger.structuredParams` option mirrors the `ConsoleLogger` one.

## Redaction with `nestjs-pino` and `pino`

`nestjs-pino` **5.1.0** with `pino` **10.3.1** and `pino-http` **11.0.0**. The `redact` option is applied at serialization time, so a value that matches a path never reaches the output stream — including when it arrives from somewhere you did not anticipate.

```ts good title="src/logging/logger.module.ts"
import { Module, RequestMethod } from '@nestjs/common'
import { ConfigModule, ConfigService } from '@nestjs/config'
import { LoggerModule } from 'nestjs-pino'
import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'

@Module({
  imports: [
    LoggerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        pinoHttp: {
          level: config.get<string>('LOG_LEVEL') ?? 'info',

          redact: {
            paths: [
              // --- request headers (pino-http serializes all of them) ---
              'req.headers.authorization',
              'req.headers.cookie',
              'req.headers["x-api-key"]',
              'req.headers["x-csrf-token"]',
              'req.headers["proxy-authorization"]',

              // --- response headers ---
              'res.headers["set-cookie"]',

              // --- anything you attach yourself ---
              'password',
              'newPassword',
              'currentPassword',
              'token',
              'accessToken',
              'refreshToken',
              'params.password',
              'params.token',

              // --- nested objects ---
              'user.email',
              'user.phone',
              'payment.card.number',
              'payment.card.cvv',

              // --- arrays: [*] applies to every element ---
              'user.tokens[*].value',
              'order.items[*].giftMessage',
              'body.recipients[*].email',

              // --- a whole subtree ---
              'req.body.*',
            ],
            censor: '[REDACTED]',
          },

          // A per-request id that is not a user identifier.
          genReqId: (request: IncomingMessage, response: ServerResponse) => {
            const existing = request.headers['x-request-id']
            const id = typeof existing === 'string' && existing.length <= 64 ? existing : randomUUID()
            response.setHeader('x-request-id', id)
            return id
          },

          // Keep the automatic request/response lines terse; the detail is in
          // the fields, not in an English sentence built from user input.
          customSuccessMessage: () => 'request completed',
          customErrorMessage: () => 'request failed',

          // Health and metrics at debug, so they do not drown the signal.
          customLogLevel: (_request, response, error) => {
            if (error || response.statusCode >= 500) return 'error'
            if (response.statusCode >= 400) return 'warn'
            return 'info'
          },
        },

        // Never log the probe endpoints at all.
        exclude: [{ path: 'health', method: RequestMethod.ALL }],
      }),
    }),
  ],
})
export class AppLoggerModule {}
```

### Path syntax that actually matches

This is where redaction quietly fails. The rules, from pino's own documentation:

| Form | Matches | Note |
| --- | --- | --- |
| `password` | a top-level `password` key | **not** `password` at any depth |
| `req.body.password` | that exact path | |
| `req.headers["set-cookie"]` | a key containing a hyphen | brackets are **required** |
| `user.tokens[*].value` | `value` in every array element | `[*]` is the array wildcard |
| `req.body.*` | every key one level under `req.body` | a trailing wildcard, one level only |
| `a.*.b` | `b` under any key of `a` | an intermediate wildcard |

Four things that catch people out:

- **Paths are anchored at the root of the emitted object.** Under `pino-http` the request lives at `req`, so `headers.authorization` matches nothing and `req.headers.authorization` matches.
- **Paths are case sensitive.** Node lowercases incoming HTTP header names, so `req.headers.authorization` is right and `req.headers.Authorization` silently never fires.
- **A hyphenated key needs bracket notation.** `res.headers.set-cookie` is a syntax error waiting to be parsed as subtraction; `res.headers["set-cookie"]` is the path.
- **Wildcards cost.** Pino documents wildcard redaction as materially slower than explicit keys. Enumerate the paths you know and use wildcards for the subtrees you cannot enumerate.

`censor` replaces the value; `remove: true` deletes the key entirely. Prefer `censor` — seeing `"password": "[REDACTED]"` tells a reviewer the redaction is working, whereas a missing key is indistinguishable from a key that was never sent.

```ts good title="src/logging/redaction.ts"
/**
 * Shared with the test suite, so a new path is covered by the assertion that
 * checks the list is non-empty for each category.
 */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  'password',
  'params.password',
  'req.body.*',
] as const
```

:::warning Redaction is the last line, not the first
`redact` protects against the data you forgot about. It does not license logging the request body "because it is redacted" — a new field named `secretAnswer` is not on the list, and nobody will notice for months. Log the fields you chose; redact as the backstop.
:::

## Errors carry credentials

An error object is not just a message and a stack. Pino's default `err` serializer walks the error with `for (const key in err)` and copies **every enumerable own property** onto the log record. Library errors are full of them.

| Error source | The property that leaks |
| --- | --- |
| TypeORM `QueryFailedError` | `parameters` — the bound values of the failing query |
| `pg` | `where`, and a connection error's message containing the full `DATABASE_URL` |
| An HTTP client error | `config.headers.Authorization`, `config.data`, `request` |
| `class-validator` via Nest | `target` — the whole DTO instance, including the password |
| A custom error someone attached context to | whatever they attached |

```json title="what a single error line can contain"
{
  "level": 50,
  "msg": "request failed",
  "err": {
    "type": "QueryFailedError",
    "message": "duplicate key value violates unique constraint \"users_email_key\"",
    "stack": "QueryFailedError: duplicate key ...",
    "query": "INSERT INTO users(email, password_hash) VALUES($1, $2)",
    "parameters": ["dana@example.test", "$argon2id$v=19$m=65536,t=3,p=4$..."]
  }
}
```

The fix is a serializer that keeps the diagnostic value and drops the payload:

```ts good title="src/logging/error.serializer.ts"
import { HttpException } from '@nestjs/common'

interface SerializedError {
  type: string
  message: string
  stack?: string
  statusCode?: number
  [key: string]: unknown
}

// Only these are copied off an error. Everything else — parameters, config,
// target, request — is dropped rather than inspected and hoped about.
const SAFE_KEYS = ['code', 'errno', 'syscall'] as const

export function errorSerializer(error: unknown): SerializedError {
  if (!(error instanceof Error)) {
    return { type: 'NonError', message: String(error) }
  }

  const source = error as unknown as Record<string, unknown>
  const serialized: SerializedError = {
    type: error.constructor?.name ?? 'Error',
    message: error.message,
    stack: error.stack,
  }

  for (const key of SAFE_KEYS) {
    const value = source[key]
    if (typeof value === 'string' || typeof value === 'number') serialized[key] = value
  }

  if (error instanceof HttpException) serialized.statusCode = error.getStatus()
  else if (typeof source.statusCode === 'number') serialized.statusCode = source.statusCode

  return serialized
}
```

```ts good title="src/logging/logger.module.ts"
import { LoggerModule } from 'nestjs-pino'
import { errorSerializer } from './error.serializer.js'

LoggerModule.forRoot({
  pinoHttp: {
    serializers: {
      // Replaces pino's default, which copies every enumerable property.
      err: errorSerializer,
    },
  },
})
```

An allow-list, not a deny-list. You cannot enumerate the properties every library will attach to an error next year; you can enumerate the five you actually use.

:::warning The message itself can be the leak
`duplicate key value violates unique constraint "users_email_key"` is safe. `duplicate key value ... Key (email)=(dana@example.test) already exists` is not, and Postgres will produce the second form given `DETAIL` verbosity. Truncating or pattern-scrubbing error messages before they are logged is worth doing for exactly this family.
:::

Errors also reach the client. A Nest exception filter that echoes `error.message` on a 500 hands the same content to whoever made the request — see [Exception filters](../nestjs-request-handling/exception-filters.md).

## Tokens in query strings reach the access log

### The exploit

A token in a URL is disclosed to every layer that logs URLs, and there are more of them than you control.

```bash
curl -s 'https://api.example.test/reports/export?api_key=sk_live_51H7mQ2eZvKYlo2C&from=2026-01-01'
```

```text title="your access log, your proxy's access log, the CDN's, the load balancer's"
10.0.4.17 - - [11/Sep/2026:10:14:02] "GET /reports/export?api_key=sk_live_51H7mQ2eZvKYlo2C&from=2026-01-01 HTTP/1.1" 200
```

It is also in the browser history, and in the `Referer` header sent to every third-party script the resulting page loads.

### The fix

**Move the credential to a header.** That is the actual fix; everything else is damage limitation for the endpoints you cannot change.

For those, scrub the URL before it is serialized. `pino-http` serializes `req.url` from `originalUrl`, so redact the query wholesale and log a sanitized copy:

```ts good title="src/logging/request.serializer.ts"
import type { IncomingMessage } from 'node:http'

const SENSITIVE_PARAMS = new Set(['token', 'api_key', 'apikey', 'access_token', 'code', 'state', 'signature'])

interface SerializedRequest {
  id?: unknown
  method?: string
  url: string
  remoteAddress?: string
}

export function requestSerializer(request: IncomingMessage & { id?: unknown; originalUrl?: string }): SerializedRequest {
  const raw = request.originalUrl ?? request.url ?? '/'
  let url = raw

  try {
    // A base is required because raw is path-only; it is discarded below.
    const parsed = new URL(raw, 'http://internal')
    for (const key of [...parsed.searchParams.keys()]) {
      if (SENSITIVE_PARAMS.has(key.toLowerCase())) parsed.searchParams.set(key, '[REDACTED]')
    }
    url = `${parsed.pathname}${parsed.search}`
  } catch {
    url = '[unparseable url]'
  }

  return { id: request.id, method: request.method, url, remoteAddress: request.socket?.remoteAddress }
}
```

```ts good title="src/logging/logger.module.ts"
LoggerModule.forRoot({
  pinoHttp: {
    serializers: { req: requestSerializer, err: errorSerializer },
    // req.query is serialized separately by the default serializer; this
    // removes the duplicate that the URL scrubbing above would otherwise miss.
    redact: { paths: ['req.query', 'req.headers.authorization', 'req.headers.cookie'], censor: '[REDACTED]' },
  },
})
```

An allow-list of query parameters is stronger than a deny-list if your routes are stable enough to enumerate them. The deny-list above is the pragmatic version.

## Correlation IDs instead of identities

You need to follow one request across services. You do not need the person's name to do it.

```ts good title="src/logging/correlation.interceptor.ts"
import { Injectable } from '@nestjs/common'
import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common'
import type { Observable } from 'rxjs'
import { PinoLogger } from 'nestjs-pino'

@Injectable()
export class CorrelationInterceptor implements NestInterceptor {
  private readonly logger: PinoLogger

  constructor(logger: PinoLogger) {
    this.logger = logger
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest()

    // assign() binds fields to every log line made during this request.
    // An opaque user id, never an email; a route template, never the path
    // with its identifiers in it.
    this.logger.assign({
      userId: request.user?.id,
      route: `${context.getClass().name}.${context.getHandler().name}`,
      tenantId: request.user?.tenantId,
    })

    return next.handle()
  }
}
```

Outside an HTTP request — a BullMQ worker, a `@Cron` job, a microservice consumer — there is no request context for `assign` to attach to. `PinoLogger.runInContext()` creates one:

```ts good title="src/jobs/reports.processor.ts"
import { Injectable } from '@nestjs/common'
import { Processor, WorkerHost } from '@nestjs/bullmq'
import type { Job } from 'bullmq'
import { randomUUID } from 'node:crypto'
import { PinoLogger } from 'nestjs-pino'

@Processor('reports')
@Injectable()
export class ReportsProcessor extends WorkerHost {
  private readonly logger: PinoLogger

  constructor(logger: PinoLogger) {
    super()
    this.logger = logger
  }

  async process(job: Job<{ tenantId: string; correlationId?: string }>) {
    // Every log line inside fn() carries these bindings, across awaits.
    return this.logger.runInContext(
      async () => {
        this.logger.info('report generation started')
        return this.generate(job.data.tenantId)
      },
      { bindings: { jobId: job.id, correlationId: job.data.correlationId ?? randomUUID() } },
    )
  }
}
```

Propagate the correlation id into the job payload when you enqueue it, and into the `x-request-id` header when you call another service. That is what makes a distributed trace possible without any personal data in it at all.

:::best-practice The rule that makes retention tractable
Log **pseudonymous** identifiers only — a user id, a tenant id, a correlation id — and resolve them to a person through the database when an operator is entitled to. Logs then contain references rather than personal data, which changes what your retention policy has to promise.
:::

## Retention and the erasure problem

Two facts that collide:

- Logs are append-only by design and replicated into systems that cannot rewrite an individual line.
- A user with a right to erasure can require you to delete their personal data, including from logs.

If the logs contain only pseudonymous identifiers, the collision mostly dissolves: the identifier alone is not personal data once the mapping is deleted, and a retention window does the rest. If the logs contain email addresses, you have committed to selectively deleting lines from an immutable store, which is the expensive answer.

| Stream | Typical retention | Reasoning |
| --- | --- | --- |
| Application logs | 7–30 days | operational debugging; the shortest window that supports it |
| Access logs | 30–90 days | incident investigation |
| Security and audit events | 1 year or more, write-once | this is the one you must keep, so keep it narrow and pseudonymous |
| Anything containing personal data | as short as the law and the purpose allow | and document why |

Three controls worth having before you need them:

- **Separate the audit stream from the application stream.** Different retention, different access control, and the audit stream is deliberately minimal: who, what, when, on which object id.
- **Access to logs is itself audited.** "Who read this" matters exactly as much for the log platform as for the database.
- **Know what your aggregator retains after you delete.** Backups, cold storage and the vendor's own retention are part of your answer whether you planned for them or not.

## Verifying

Redaction is configuration, which means it breaks silently. Assert it.

```ts title="test/logging.e2e-spec.ts"
import { Test } from '@nestjs/testing'
import { Logger as PinoNestLogger } from 'nestjs-pino'
import request from 'supertest'
import { AppModule } from '../src/app.module.js'

describe('logs do not leak credentials', () => {
  let app: import('@nestjs/common').INestApplication
  let lines: string[]

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = moduleRef.createNestApplication({ bufferLogs: true })
    app.useLogger(app.get(PinoNestLogger))

    // Capture the real stream rather than mocking the logger: the bug this
    // suite exists to catch is in the serializer, not in the call site.
    lines = []
    const write = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      lines.push(String(chunk))
      return write(chunk as string, ...(rest as []))
    }) as typeof process.stdout.write

    await app.init()
  })

  afterAll(() => app.close())

  const output = () => lines.join('\n')

  it('never writes a submitted password', async () => {
    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'dana@example.test', password: 'Summer2024!' })

    expect(output()).not.toContain('Summer2024!')
  })

  it('redacts the authorization header', async () => {
    await request(app.getHttpServer())
      .get('/me')
      .set('authorization', 'Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.PAYLOAD.SIGNATURE')

    expect(output()).not.toContain('PAYLOAD.SIGNATURE')
    expect(output()).toContain('[REDACTED]')
  })

  it('redacts Set-Cookie on the way out', async () => {
    const response = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'dana@example.test', password: 'Summer2024!' })

    const sid = /sid=([^;]+)/.exec(response.headers['set-cookie']?.[0] ?? '')?.[1]
    expect(sid).toBeTruthy()
    expect(output()).not.toContain(sid as string)
  })

  it('redacts a token in a query string', async () => {
    await request(app.getHttpServer()).get('/reports/export?api_key=sk_live_51H7mQ2eZvKYlo2C')
    expect(output()).not.toContain('sk_live_51H7mQ2eZvKYlo2C')
  })

  it('does not log query parameters on a failed database call', async () => {
    await request(app.getHttpServer())
      .post('/users')
      .send({ email: 'dana@example.test', password: 'Summer2024!' })   // duplicate

    expect(output()).not.toContain('$argon2')
    expect(output()).not.toContain('Summer2024!')
  })

  it('carries a correlation id and not an email address', async () => {
    const response = await request(app.getHttpServer())
      .get('/me')
      .set('authorization', `Bearer ${await signInAsDana(app)}`)

    expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/)
    expect(output()).not.toContain('dana@example.test')
  })
})
```

The generic version of that suite is one test: run your whole end-to-end suite with a stdout capture, and assert that a set of known sentinel values — a password, a token, an email, a card number, all seeded into your fixtures — never appear anywhere in the captured output. It catches the leak you have not thought of yet, which is the only kind that matters.

## Production considerations

- **Redact at the source, not in the aggregator.** A pipeline rule protects one destination; anything that reads stdout directly — a sidecar, a crash dump, a developer running `docker logs` — sees the raw line.
- **Set log levels from configuration and keep `debug` off in production.** Most leaks are debug lines that were never meant to survive the sprint.
- **Turn off ORM query logging in production.** TypeORM's `logging: ['query']` prints the parameter array, which is every value you were protecting. See [SQL injection](sql-injection.md).
- **Log authentication *outcomes*, never authentication *inputs*.** "login failed, user u-771, reason bad_password" is the useful line.
- **Alert on the redaction working.** A sudden drop in `[REDACTED]` occurrences usually means a serializer was replaced, not that the traffic changed.
- **Treat `originalname`, user agents and custom headers as untrusted text.** They are rendered in dashboards and terminals; a control character or an ANSI escape in a log line is a real, if unglamorous, injection.
- **Keep the audit stream separate and minimal.** Different retention, different access control, and no free-form payloads.
- **Cap the size of what you log.** `ConsoleLogger`'s `maxStringLength` defaults to 10000 and does not apply in `json` mode — truncate large fields yourself before logging them.
- **Test the logging path in CI.** It is configuration, and configuration regresses silently.

## Common mistakes

- **Interpolating data into the message string.** There is no key left for a redactor to find; this defeats every control below it.
- **`JSON.stringify(dto)` in a log line.** The whole payload, including the password.
- **Logging the whole request or response object.** `req.headers` contains `Authorization` and `Cookie`; `res.headers` contains `Set-Cookie`.
- **A redact path that is not anchored at the root.** `headers.authorization` matches nothing under `pino-http`; it is `req.headers.authorization`.
- **`req.headers.Authorization` with a capital A.** Paths are case sensitive and Node lowercases header names.
- **`res.headers.set-cookie` without brackets.** A hyphenated key needs `["set-cookie"]`.
- **Assuming a bare `password` path matches at any depth.** It matches the top level only; add the nested paths.
- **Relying on `redact` while still logging whole bodies.** The next field somebody adds is not on your list.
- **Keeping pino's default `err` serializer.** It copies every enumerable property, including TypeORM's `parameters` and an HTTP client's `config.headers`.
- **A token in a query string.** Your access log, the proxy's, the CDN's, the browser history and the `Referer` header.
- **Logging an email address as the correlation key.** Use an opaque id; it is what makes retention and erasure tractable.
- **ORM query logging left on in production.** The parameter array is the data.
- **Redacting only in the log pipeline.** Anything reading stdout sees the original.
- **`debug` level in production.** The leak is almost always a debug line.
- **No test for any of this.** Redaction is configuration; configuration breaks quietly.

## Related topics

- [Logging without leaking PII](../security/logging-without-leaking-pii.md) — the framework-independent treatment, with more redaction examples and the retention argument in full.
- [Logging](../nestjs-libraries/logging.md) — `LoggerModule`, `PinoLogger`, `LoggerErrorInterceptor` and transports.
- [Exception filters](../nestjs-request-handling/exception-filters.md) — the other place an error message is disclosed, this time to the client.
- [Authentication and session security](authentication-and-session-security.md) — what an authentication log line should and should not contain.
- [JWT pitfalls](jwt-pitfalls.md) — why a token in a log is a live credential.
- [Secrets and config validation](secrets-and-config.md) — the startup configuration dump, and redacting connection strings.
- [SQL injection](sql-injection.md) — ORM query logging and the parameter array.
- [Authorization and IDOR](authorization-and-idor.md) — logging denied access without logging the record.
- [File upload security](file-upload-security.md) — why `originalname` is untrusted text in a log line.
- [Observability](../nestjs-production/observability.md) — correlation ids as part of a trace, and what belongs in a span.
- [Interceptors](../nestjs-request-handling/interceptors.md) — where the correlation interceptor runs.
