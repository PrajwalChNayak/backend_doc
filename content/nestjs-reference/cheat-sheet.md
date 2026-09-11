---
title: Cheat sheet
description: NestJS 12 on one page — bootstrap, module/controller/service skeletons, the request lifecycle order, route syntax, global registration, DTOs, provider forms, testing, CLI commands and the Node floors.
status: current
updated: 2026-09-11
---

Everything you look up twice a week, in tables and skeletons. NestJS `12.0.1` on Express `5.2.1`, Node `24` LTS. Each section links to the page that explains the *why*.

## Node version floors

| To do this | Needs Node |
| --- | --- |
| **Run** a Nest 12 app | v20.19+, v22.12+, or v26+ (`@nestjs/core` declares `>= 20`; `require(esm)` is the real gate) |
| **Use the CLI** — `nest new`, `nest generate`, `nest build`, `nest upgrade` | **v22.22.3+, v24.15+, or v26+** (`@nestjs/schematics@12` declares `>=22.12.0`) |
| This handbook | **Node 24 LTS** — satisfies both |

## Bootstrap

:::tabs
@tab npm
```bash
npm install -g @nestjs/cli@12
nest new orders-api
```
@tab pnpm
```bash
pnpm add -g @nestjs/cli@12
nest new orders-api
```
@tab yarn
```bash
yarn global add @nestjs/cli@12
nest new orders-api
```
:::

`nest new` prompts for the module system: **ESM (with Vitest)** or **CJS (with Jest)**.

```json title="package.json — ESM project"
{
  "type": "module",
  "engines": { "node": ">=24" },
  "scripts": {
    "build": "nest build",
    "start": "nest start",
    "start:dev": "nest start --watch",
    "start:prod": "node dist/main.js",
    "test": "vitest run",
    "test:e2e": "vitest run --config ./vitest.config.e2e.ts"
  }
}
```

```json title="tsconfig.json — ESM project"
{
  "compilerOptions": {
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "resolvePackageJsonExports": true,
    "target": "ES2023",
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true,
    "esModuleInterop": true,
    "declaration": true,
    "sourceMap": true,
    "outDir": "./dist",
    "strict": true,
    "strictPropertyInitialization": false
  }
}
```

For CommonJS, drop `"type": "module"`, use `module: "commonjs"`, and omit the `.js` extensions below. `experimentalDecorators` and `emitDecoratorMetadata` are mandatory either way.

## Versions to pin

| Package | Version |
| --- | --- |
| `@nestjs/core`, `@nestjs/common`, `@nestjs/platform-express`, `@nestjs/testing` | 12.0.1 |
| `@nestjs/cli`, `@nestjs/schematics` | 12.0.0 |
| `@nestjs/config`, `@nestjs/passport`, `@nestjs/mapped-types` | 12.0.0 |
| `@nestjs/jwt`, `@nestjs/swagger`, `@nestjs/schedule`, `@nestjs/microservices` | 12.0.1 |
| `@nestjs/throttler` | **6.5.0** — not on the 12 line |
| `@nestjs/graphql`, `@nestjs/apollo` | **14.0.0** — not on the 12 line |
| `reflect-metadata` / `rxjs` | 0.2.2 / 7.8.2 |
| `class-validator` / `class-transformer` | 0.15.1 / 0.5.1 |
| bundled by `@nestjs/platform-express` | `express` 5.2.1, `multer` 2.2.0, `cors` 2.8.6, `path-to-regexp` 8.4.2 |

## Module

```ts title="src/users/users.module.ts"
import { Module } from '@nestjs/common'
import { UsersController } from './users.controller.js'
import { UsersRepository } from './users.repository.js'
import { UsersService } from './users.service.js'

@Module({
  imports: [],                       // other modules whose exports you need
  controllers: [UsersController],    // HTTP entry points
  providers: [UsersService, UsersRepository],
  exports: [UsersService],           // what importers of this module may inject
})
export class UsersModule {}
```

A provider not listed in some module's `providers` does not exist to the container, no matter how correct the import statement is.

## Controller

```ts title="src/users/users.controller.ts"
import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common'
import { CreateUserDto } from './dto/create-user.dto.js'
import { ListUsersDto } from './dto/list-users.dto.js'
import { UpdateUserDto } from './dto/update-user.dto.js'
import { UsersService } from './users.service.js'

@Controller('users')
export class UsersController {
  private readonly users: UsersService

  constructor(users: UsersService) {
    this.users = users
  }

  @Get()
  list(@Query() query: ListUsersDto) {
    return this.users.list(query)
  }

  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.users.findOne(id)
  }

  @Post()
  create(@Body() dto: CreateUserDto) {
    return this.users.create(dto)   // 201 by default on POST
  }

  @Patch(':id')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateUserDto) {
    return this.users.update(id, dto)
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id', ParseIntPipe) id: number) {
    await this.users.remove(id)
  }
}
```

## Service

```ts title="src/users/users.service.ts"
import { Injectable, NotFoundException } from '@nestjs/common'
import { UsersRepository } from './users.repository.js'

@Injectable()
export class UsersService {
  private readonly repository: UsersRepository

  constructor(repository: UsersRepository) {
    this.repository = repository
  }

  async findOne(id: number) {
    const user = await this.repository.findById(id)
    if (!user) throw new NotFoundException('user not found')
    return user
  }
}
```

## The request lifecycle

```text
request
  1. middleware              Express level; sees req/res/next; no route metadata yet
  2. guards                  return false → 403; throw → your exception
  3. interceptors  (pre)     before next.handle()
  4. pipes                   transform + validate each handler argument
  5. route handler
  6. interceptors  (post)    the RxJS operators after next.handle()
  7. exception filters       anything thrown in 1–6
response
```

Within each stage: **global → controller → method**. Interceptors are the only stage that runs twice.

| Consequence | Why |
| --- | --- |
| A bad body **and** a bad token returns **403**, not 400 | guards run before pipes |
| Middleware cannot know which controller will serve the request | routing is not resolved yet |
| A guard can read `request.body` | body parsing is middleware |
| `@Res()` disables stages 6 and the serialization in them | you took over the response |

## Route path syntax (path-to-regexp 8)

| Construct | Meaning | Example | `params` |
| --- | --- | --- | --- |
| `:name` | one segment | `@Get('books/:id')` | `{ id: '42' }` |
| `*name` | one or more segments, **array** | `@Get('files/*path')` | `{ path: ['a','b.txt'] }` |
| `{ … }` | optional group | `@Get('books{/:id}')` | `{}` when absent |
| `\\` | escape a reserved character | `@Get('\\(draft\\)')` | |
| `:"name"` | non-identifier parameter name | `@Get('r/:"report-id"')` | `params['report-id']` |

| Want | Write |
| --- | --- |
| catch-all including the mount root | `'{*splat}'` |
| catch-all excluding the mount root | `'*splat'` |
| optional extension | `':file{.:ext}'` |
| optional trailing id | `'books{/:id}'` |
| several paths, one handler | `['discussion/:slug', 'page/:slug']` |
| a numeric constraint | `':id'` + `ParseIntPipe` — there is no `RegExp` overload |

`(`, `)`, `[`, `]`, `?`, `+`, `!` are reserved and throw at **bootstrap** unless escaped. Wildcard params are arrays; unmatched params are omitted, not `undefined`.

## `main.ts`

Registration order in this file does not decide pipeline order — that is fixed. What it does decide is that everything below must run **before** `app.listen()`, because `listen()` calls `init()`, which is where routes are registered.

```ts title="src/main.ts"
import compression from 'compression'
import cookieParser from 'cookie-parser'
import helmet from 'helmet'
import { ClassSerializerInterceptor, ValidationPipe, VersioningType } from '@nestjs/common'
import { NestFactory, Reflector } from '@nestjs/core'
import { NestExpressApplication } from '@nestjs/platform-express'
import { AppModule } from './app.module.js'
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter.js'
import { JwtAuthGuard } from './common/guards/jwt-auth.guard.js'
import { TimeoutInterceptor } from './common/interceptors/timeout.interceptor.js'

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: false,
    routeConflictPolicy: { duplicate: 'error', shadow: 'warn' },
  })

  // 1. Express-level settings and middleware.
  app.set('trust proxy', 1)
  app.disable('x-powered-by')
  app.use(helmet())
  app.use(compression())
  app.use(cookieParser(process.env.COOKIE_SECRET))
  app.useBodyParser('json', { limit: '100kb' })

  // 2. Routing shape.
  app.enableCors({ origin: ['https://app.example.com'], credentials: true })
  app.setGlobalPrefix('api', { exclude: ['health', 'metrics'] })
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' })

  // 3. Global enhancers, in pipeline order.
  app.useGlobalGuards(new JwtAuthGuard(app.get(Reflector)))
  app.useGlobalInterceptors(
    new ClassSerializerInterceptor(app.get(Reflector)),
    new TimeoutInterceptor(),
  )
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  )
  app.useGlobalFilters(new AllExceptionsFilter())

  // 4. Process integration.
  app.enableShutdownHooks()

  await app.listen(Number(process.env.PORT ?? 3000))
}

bootstrap()
```

A global enhancer that needs **injected dependencies** cannot be constructed here. Register it as a provider instead:

```ts title="src/app.module.ts"
import { Module, ValidationPipe } from '@nestjs/common'
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core'
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter.js'
import { AuditInterceptor } from './common/interceptors/audit.interceptor.js'
import { RolesGuard } from './common/guards/roles.guard.js'

@Module({
  providers: [
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
    { provide: APP_PIPE, useClass: ValidationPipe },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {}
```

## DTO + ValidationPipe

```ts title="src/users/dto/create-user.dto.ts"
import { IsEmail, IsInt, IsOptional, Length, Min } from 'class-validator'

export class CreateUserDto {
  @IsEmail()
  email!: string

  @Length(1, 80)
  name!: string

  @IsOptional()
  @IsInt()
  @Min(0)
  age?: number
}
```

A DTO must be a **class**. An `interface` is erased at compile time, so `ValidationPipe` receives no metadata and validates nothing — silently.

| `ValidationPipeOptions` | Effect |
| --- | --- |
| `whitelist: true` | strip properties with no validation decorator |
| `forbidNonWhitelisted: true` | 400 instead of stripping |
| `transform: true` | return a real DTO instance, and coerce primitives |
| `transformOptions` | passed to `class-transformer` |
| `disableErrorMessages: true` | omit details from the response |
| `errorHttpStatusCode` | default `HttpStatus.BAD_REQUEST` |
| `exceptionFactory` | build your own error from `ValidationError[]` |
| `errorFormat: 'grouped'` | `message` becomes `Record<string, string[]>` instead of `string[]` |
| `validateCustomDecorators: true` | also validate `createParamDecorator` parameters |

The Standard Schema alternative — Zod, Valibot or ArkType, no DTO class:

```ts title="src/users/users.controller.ts"
import { Body, Controller, Post } from '@nestjs/common'
import { z } from 'zod'
import { UsersService } from './users.service.js'

const CreateUser = z.object({ email: z.email(), name: z.string().min(1).max(80) }).strict()

@Controller('users')
export class UsersController {
  private readonly users: UsersService

  constructor(users: UsersService) {
    this.users = users
  }

  @Post()
  create(@Body({ schema: CreateUser }) dto: z.infer<typeof CreateUser>) {
    return this.users.create(dto)
  }
}
```

Register `new StandardSchemaValidationPipe()` globally for that form. Options: `transform` (default `true`), `validateCustomDecorators` (default `false`), `validateOptions`, `errorHttpStatusCode`, `exceptionFactory`.

## Provider forms

```ts title="src/app.module.ts"
import { Module } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { Pool } from 'pg'
import { MailService } from './mail/mail.service.js'
import { SmtpMailService } from './mail/smtp-mail.service.js'
import { UsersService } from './users/users.service.js'

export const PG_POOL = 'PG_POOL'

@Module({
  providers: [
    // Shorthand: the class is its own token.
    UsersService,

    // useClass — swap the implementation behind a token.
    { provide: MailService, useClass: SmtpMailService },

    // useValue — a constant, a mock, or an object you built elsewhere.
    { provide: 'FEATURE_FLAGS', useValue: { newCheckout: true } },

    // useFactory — anything needing construction, with its own dependencies.
    {
      provide: PG_POOL,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new Pool({ connectionString: config.getOrThrow('DATABASE_URL'), max: 10 }),
    },

    // useExisting — a second name for an existing provider.
    { provide: 'LEGACY_MAILER', useExisting: MailService },
  ],
  exports: [UsersService, MailService, PG_POOL],
})
export class AppModule {}
```

| Token type | Injected with |
| --- | --- |
| a class | `constructor(users: UsersService)` — resolved from the emitted type metadata |
| a string or symbol | `@Inject(PG_POOL) pool: Pool` |
| a circular reference | `@Inject(forwardRef(() => OtherService))` |

An **async** factory is the same shape with an `async` function; Nest awaits it before anything that injects the token is constructed.

## Exceptions

| Throw | Status |
| --- | --- |
| `BadRequestException` | 400 |
| `UnauthorizedException` | 401 |
| `ForbiddenException` | 403 |
| `NotFoundException` | 404 |
| `MethodNotAllowedException` | 405 |
| `NotAcceptableException` | 406 |
| `RequestTimeoutException` | 408 |
| `ConflictException` | 409 |
| `GoneException` | 410 |
| `PayloadTooLargeException` | 413 |
| `UnsupportedMediaTypeException` | 415 |
| `UnprocessableEntityException` | 422 |
| `InternalServerErrorException` | 500 |
| `NotImplementedException` | 501 |
| `BadGatewayException` | 502 |
| `ServiceUnavailableException` | 503 |
| `HttpException(body, status, options?)` | anything |

Default body: `{ message, statusCode }`, plus `error` when a description was given.

:::warning
`new BadRequestException('msg', { errorCode: 'X' })` sets `exception.errorCode` and **nothing else** — no built-in subclass passes it into the body and `BaseExceptionFilter` never reads it. Surface it with the four-argument `HttpException.createBody(message, error, status, errorCode)` or with your own filter. See [NestJS 11 → 12 migration](v11-to-v12-migration.md).
:::

## Testing

```ts title="test/users.service.spec.ts"
import { Test } from '@nestjs/testing'
import { UsersRepository } from '../src/users/users.repository.js'
import { UsersService } from '../src/users/users.service.js'

describe('UsersService', () => {
  let service: UsersService

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [UsersService, UsersRepository],
    })
      .overrideProvider(UsersRepository)
      .useValue({ findById: async () => null })
      .compile()

    service = moduleRef.get(UsersService)
  })

  it('throws when the user is missing', async () => {
    await expect(service.findOne(1)).rejects.toThrow('user not found')
  })
})
```

```ts title="test/users.e2e-spec.ts"
import { ValidationPipe } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { AppModule } from '../src/app.module.js'

describe('users (e2e)', () => {
  let app

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = moduleRef.createNestApplication()
    // main.ts never runs in tests — re-apply every global you rely on.
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }))
    await app.init()
  })

  afterAll(async () => {
    await app.close()
  })

  it('rejects an invalid body', async () => {
    await request(app.getHttpServer()).post('/users').send({ email: 'nope' }).expect(400)
  })
})
```

| Builder method | Replaces |
| --- | --- |
| `.overrideProvider(token).useValue(x)` / `.useClass(C)` / `.useFactory({ factory })` | any provider |
| `.overrideGuard(Guard).useValue({ canActivate: () => true })` | a guard |
| `.overrideInterceptor(I)` / `.overridePipe(P)` / `.overrideFilter(F)` | the matching enhancer |
| `.overrideModule(M).useModule(Fake)` | a whole module |
| `.useMocker(factory)` | every unprovided dependency at once |

## CLI

| Command | Does |
| --- | --- |
| `nest new <name>` | scaffold a project; prompts ESM/Vitest or CJS/Jest |
| `nest g module users` | a `@Module()` class |
| `nest g controller users` | a controller, registered in the nearest module |
| `nest g service users` | an `@Injectable()`, registered as a provider |
| `nest g resource orders` | module + controller + service + DTOs + entity + specs |
| `nest g guard\|interceptor\|pipe\|filter\|middleware <name>` | the matching skeleton |
| `nest build` | `tsc` into `dist/` |
| `nest start --watch` | rebuild and restart on change |
| `nest start --debug` | attach the inspector |
| `nest upgrade --dry-run` | preview the next-major bump |
| `nest deploy` | deploy the built application |
| `nest info` | resolved Node, npm and `@nestjs/*` versions — paste into bug reports |

| Flag (v12) | On | Effect |
| --- | --- | --- |
| `--emit-declarations` | build, start | emit `.d.ts` |
| `--no-type-check` | build, start | transpile without type checking — never for a production artifact |
| `--silent` | build, start | suppress CLI output |
| `--rspackPath <path>` | build, start | use an rspack configuration |
| `--parallel [n]` | build | build monorepo projects in parallel |
| `-d, --dry-run` | new, generate, upgrade | print what would be written |

```json title="nest-cli.json"
{
  "$schema": "https://json.schemastore.org/nest-cli",
  "collection": "@nestjs/schematics",
  "sourceRoot": "src",
  "compilerOptions": {
    "deleteOutDir": true,
    "assets": [{ "include": "mail/templates/**/*.hbs", "watchAssets": true }],
    "includeLibraryAssets": ["shared-mail"]
  }
}
```

`assets` is not optional if you ship templates, `.graphql` documents or `.sql` files — `tsc` only emits what it compiles.

## Common mistakes

- **A DTO declared as an `interface`.** It is erased; `ValidationPipe` validates nothing and says nothing.
- **Globals applied only in `main.ts`.** E2E tests build the app themselves, so re-apply them there or use the `APP_*` tokens.
- **`@Res()` plus a return value.** The return value is discarded and the request hangs.
- **A provider missing from a module's `providers`.** Importing the file is not registering the class.
- **`import type` for an injected class.** The import is erased, so the container receives `undefined`.
- **A global prefix with no `exclude`.** Health and metrics move, and the orchestrator restarts healthy pods.
- **`errorCode` without a filter or the four-argument `createBody`.** A silent no-op.

## Related topics

- [Decorator reference](decorator-reference.md) — every decorator, with its package.
- [Troubleshooting](troubleshooting.md) — the same material indexed by error message.
- [NestJS 11 → 12 migration](v11-to-v12-migration.md) — what changed to make this page current.
- [The request lifecycle](../nestjs/request-lifecycle.md) — the long-form version of the order table.
- [Routing and path syntax](../nestjs/routing-and-path-syntax.md) — the path grammar in full.
- [Dependency injection](../nestjs/dependency-injection.md) — the provider forms, explained.
- [The ValidationPipe](../nestjs-validation/validation-pipe.md) — every option with its failure mode.
- [Cheat sheet](../reference/cheat-sheet.md) — the Express 5 layer underneath.
