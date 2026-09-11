# Unverified / omitted — `content/nestjs-libraries/`

Author pass: 2026-09-11. Everything on the eleven pages in `content/nestjs-libraries/`
was verified by unpacking the published tarball (`npm pack <pkg>@<version>`) and reading
the shipped `.d.ts` and `.js` files. This file records what was checked and deliberately
left out.

## Versions confirmed against the registry and the unpacked packages

| Package | Version documented | How confirmed |
| --- | --- | --- |
| `@nestjs/throttler` | **6.5.0** | `npm pack @nestjs/throttler@6.5.0`; `package.json` version field. Not on the 12.x line. |
| `@nestjs/observe` | **0.1.8** | `npm pack @nestjs/observe@0.1.8`; pre-1.0. |
| `@nestjs/swagger` | 12.0.1 | unpacked; `engines: ^20.19.0 \|\| >=22.12.0` |
| `@nestjs/terminus` | 12.0.0 | unpacked; `engines: ^20.19.0 \|\| ^22.12.0 \|\| >=24.0.0` |
| `@nestjs/schedule` | 12.0.1 | unpacked; depends on `cron` 4.4.0 |
| `@nestjs/bullmq` | 12.0.0 | unpacked; peer `bullmq ^3 \|\| ^4 \|\| ^5 \|\| ^6` |
| `@nestjs/cache-manager` | 12.0.0 | unpacked; peers `cache-manager >=6`, `keyv >=5` |
| `@nestjs/event-emitter` | 12.0.0 | unpacked; depends on `eventemitter2` 6.4.9 |
| `@nestjs/jwt` | 12.0.1 | unpacked; depends on `jsonwebtoken` 9.0.3 |
| `@nestjs/passport` | 12.0.0 | unpacked; peer `passport ^0.5 \|\| ^0.6 \|\| ^0.7` |
| `nestjs-pino` | 5.1.0 | unpacked; peers `pino ^10`, `pino-http ^11` |
| `@casl/ability` | 7.0.1 | unpacked; `createMongoAbility`, `AbilityBuilder`, `subject`, `ForbiddenError` all present |
| `@nest-lab/throttler-storage-redis` | 1.2.0 | unpacked; peers `@nestjs/throttler >=6.0.0`, `ioredis >=5.0.0` |

## Terminus 12.0.0 — indicators that exist, and the one that does not

Read from `dist/health-indicator/index.d.ts`. The complete exported indicator list is:

`HttpHealthIndicator`, `MongooseHealthIndicator`, `TypeOrmHealthIndicator`,
`MikroOrmHealthIndicator`, `SequelizeHealthIndicator`, `PrismaHealthIndicator`,
`MicroserviceHealthIndicator`, `GRPCHealthIndicator`, `DiskHealthIndicator`,
`MemoryHealthIndicator`, plus `HealthIndicatorService` for custom ones.

**There is no `RedisHealthIndicator` and no Redis check of any kind.** "redis" appears
only in the package's npm `keywords` array, which is marketing metadata, not an export.
The page documents a custom indicator built on `HealthIndicatorService` instead, and
says explicitly that no built-in exists.

## Deliberately omitted as unverifiable or out of scope

- **`@nestjs/observe` decorators.** The package exports no decorator of any kind —
  `dist/index.d.ts` re-exports only `custom-metrics`, `createInstanceDecorator`
  (a factory the module calls internally, not a decorator you apply), the interfaces,
  `observe.constants`, `createObserveModule`, `TracerService`, `TraceSpanDelegate` and
  two type helpers. No `@Trace()`, no `@Span()`, no `@Metric()`. None are documented.
- **`@nestjs/observe` hosted backend details.** The default collector endpoint is
  `https://observe-api.nestjs.com` (overridable with the `endpoint` option or the
  `OBSERVE_ENDPOINT` environment variable) and `appKey`/`appSecret`/`serviceId` are
  required. Pricing, plan availability, retention and the dashboard's feature set are
  not in the package and are not documented on the page.
- **`@nestjs/observe` self-hosting.** `endpoint` is typed as a free-form string, but
  the wire contract it posts to is not a published specification. The page says the
  option exists and stops there rather than implying an OTLP-compatible collector works.
- **Throttler `ttl` unit.** Documented as milliseconds because the package ships
  `seconds()`, `minutes()`, `hours()`, `days()`, `weeks()` helpers in
  `dist/utilities.d.ts` that convert to milliseconds. No claim is made about
  pre-v5 units outside a version note.
- **`@nestjs/schedule` multi-replica locking.** No first-party lock exists in the
  package. The page describes the Redis-lock and queue-based approaches in terms of
  packages documented elsewhere in this handbook rather than naming a specific
  distributed-lock library that has not been version-verified here.
- **`@nestjs/swagger` CLI plugin option list.** `PluginOptions` in
  `dist/plugin/merge-options.d.ts` carries eighteen fields; only the ones with obvious
  documented behaviour are shown. `esmCompatibleWasConfigured`, `readonly`, `outDir`,
  `rootDir` and `pathToSource` are build-tooling internals and are not documented.
