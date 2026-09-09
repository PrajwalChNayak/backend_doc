---
title: Introduction and when to choose Nest
description: What NestJS 12 actually is, the module and dependency-injection model it imposes, and an honest account of when it beats plain Express and when it does not.
status: current
updated: 2026-09-09
---

NestJS is an application framework that sits on top of an HTTP platform — Express 5 by default — and replaces "wire it up however you like" with a fixed architecture: modules that declare what they own, providers resolved by a dependency-injection container, and a request pipeline with named stages. Version 12 is the current line: `@nestjs/core` and `@nestjs/common` are **12.0.1**, they ship as ES modules, and `@nestjs/platform-express@12.0.1` bundles `express@5.2.1`.

## What Nest actually is

Three things, and it is worth separating them because you can adopt one without loving the others.

| Layer | What it gives you | What it costs |
| --- | --- | --- |
| **A DI container** | Constructor injection, one instance per module graph, swap any dependency in a test | Decorators, `reflect-metadata`, a real build step |
| **A module system** | An explicit graph of what each feature imports, provides and exports | Boilerplate for small apps; a second mental model on top of ES modules |
| **A request pipeline** | Middleware, guards, interceptors, pipes and exception filters as first-class, composable stages | Indirection — the path from URL to handler is not a single file you can read top to bottom |

Underneath all of it is still Express. Nest builds an Express app, registers your controllers as routes on it, and hands requests to your handlers. That is why every Express 5 rule from Part 1 still applies here — see [How Nest uses Express](../express-vs-nestjs/how-nest-uses-express.md).

## The architecture in one example

A feature is a module. The module owns a controller (HTTP in, HTTP out) and a service (the rules). The controller does not construct the service; it declares that it needs one.

```ts title="src/users/users.module.ts"
import { Module } from '@nestjs/common'
import { UsersController } from './users.controller.js'
import { UsersRepository } from './users.repository.js'
import { UsersService } from './users.service.js'

@Module({
  controllers: [UsersController],
  providers: [UsersService, UsersRepository],
  exports: [UsersService],
})
export class UsersModule {}
```

```ts title="src/users/users.controller.ts"
import { Controller, Get, Param } from '@nestjs/common'
import { UsersService } from './users.service.js'

@Controller('users')
export class UsersController {
  private readonly users: UsersService

  constructor(users: UsersService) {
    this.users = users
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.users.findById(id)
  }
}
```

```ts title="src/users/users.service.ts"
import { Injectable, NotFoundException } from '@nestjs/common'
import { UsersRepository } from './users.repository.js'

@Injectable()
export class UsersService {
  private readonly repository: UsersRepository

  constructor(repository: UsersRepository) {
    this.repository = repository
  }

  async findById(id: string) {
    const user = await this.repository.findById(id)
    if (!user) throw new NotFoundException('user not found')
    return user
  }
}
```

Three files say what four hundred lines of manual wiring would: this controller needs that service, this module publishes that service to whoever imports it, and nothing else can reach it. The container does the construction, so a test can construct the controller with a fake service and never open a socket.

:::note
The constructor above assigns the field explicitly rather than using the `constructor(private readonly users: UsersService)` shorthand. Both are identical to Nest. The reason for the longer form is explained in [Dependency injection](dependency-injection.md) — it is a TypeScript erasability question, not a Nest one.
:::

## Why the DI container is the point

Every other feature is downstream of it. Guards, interceptors and pipes can be classes with injected dependencies because there is a container to resolve them. `@nestjs/config`, `@nestjs/typeorm` and `@nestjs/jwt` are all "a module that provides a token you can inject". Testing works because you can replace a token.

The thing DI buys you that a manual factory function does not is **transitivity**. In a layered Express app you export `createOrderService({ orders, inventory, clock })` and someone has to assemble that call — and update it every time a dependency is added three levels down. Nest resolves the whole graph from the types, so adding a dependency to a leaf service changes exactly one constructor.

That is the trade: you give up an explicit, greppable wiring file and get automatic transitive resolution plus a uniform seam for substitution.

## When to choose Nest over plain Express

Pick Nest when at least two of these are true:

- **The codebase will outlive the team that wrote it.** Nest's structure is not better than a good hand-rolled structure — it is *the same structure in every Nest codebase*, which is what makes a new hire productive in a week.
- **You have more than one entry point.** An HTTP API plus a BullMQ worker plus a cron schedule plus a queue consumer, all needing the same business rules. Nest lets one provider graph serve all of them; see [Microservices and transports](../nestjs-advanced/microservices.md) and [Scheduling](../nestjs-libraries/schedule.md).
- **Cross-cutting concerns are real.** Per-route authorization, tenant scoping, response serialization, audit logging. Guards and interceptors give these a home that middleware ordering cannot.
- **You want OpenAPI generated from the code.** `@nestjs/swagger` reads your decorators and DTOs; the plain-Express equivalent is maintaining a schema by hand or generating it from Zod.
- **The team already thinks in TypeScript classes.** Nest is unpleasant if you prefer plain functions and modules.

## When not to choose it

Be honest about these; picking Nest for the wrong app is the most common way teams end up fighting it.

| Situation | Why Nest hurts |
| --- | --- |
| A service with fewer than ~10 endpoints and one developer | The module/controller/service ceremony outweighs the payoff. Plain Express with [layered architecture](../express/layered-architecture.md) is less code and just as testable. |
| Cold-start-sensitive serverless | Nest builds the whole DI graph at bootstrap. That is milliseconds, not seconds — but it is milliseconds you do not spend with a bare handler, on every cold start. |
| A proxy, gateway or webhook receiver | There are no business rules to isolate. The framework is pure overhead. |
| A team new to DI *and* to TypeScript | Two learning curves at once. Nest's errors when the container cannot resolve a token are hard to read until you understand modules. |
| You need `node file.ts` with no build step | Nest depends on legacy decorators and `emitDecoratorMetadata`. Node's type stripping cannot execute them — see [Native TypeScript support](../node/native-typescript-support.md). Nest projects always have a build step. |
| You want to control the middleware order precisely | Nest imposes an order: middleware, guards, interceptors, pipes, handler. That is a feature until the day you need something to run between two of them. |

:::warning
"We might need it later" is not a reason. Migrating Express to Nest incrementally is genuinely feasible — [Migrating incrementally](../express-vs-nestjs/migrating-incrementally.md) shows how — so the option stays open. Adopting a framework for hypothetical scale costs you today and may buy you nothing.
:::

## What Nest does not do

It is not a full-stack framework and it is not an ORM. It does not give you a data layer, a template engine you must use, an authentication implementation, or an opinion about your database. `@nestjs/typeorm` is a thin module that puts TypeORM's objects into the container; the ORM's behavior, and its failure modes, are unchanged. Everything you learned in [Databases](../databases/choosing-a-database.md) and [ORMs and query builders](../orms/when-to-use-an-orm.md) transfers directly.

It also does not make your app faster. Nest adds a per-request layer of interceptor and pipe execution on top of Express. For almost every API that cost is invisible next to a database round trip, but it is a cost, not a saving. If throughput is the constraint, [the Fastify adapter](../nestjs-advanced/fastify-adapter.md) is the lever, not Nest itself.

## Common mistakes

- **Choosing Nest for "structure" and then writing fat controllers.** The framework does not enforce where business rules live. A controller that queries the database is exactly as bad here as in Express.
- **Assuming Nest replaces Express knowledge.** Route paths, `req.body` semantics, static-file dotfile rules and body-parser limits are all Express 5 behavior. You still need it.
- **Expecting Nest to run under `node --experimental-strip-types`.** Legacy decorators emit runtime calls; stripping cannot. Use the CLI build.
- **Adding Nest to an existing Express app "for the DI".** If DI is all you want, a factory function and an explicit composition root give you the same testing seam with none of the framework.
- **Treating `@Injectable()` as documentation.** It is what makes a class resolvable. A provider without it fails at bootstrap, not at request time — which is good, but only if you read the error.
- **Believing the module graph is optional.** A provider that is not listed in some module's `providers` array does not exist as far as the container is concerned, no matter how correct the import statement is.

## Related topics

- [The comparison](../express-vs-nestjs/comparison.md) — the same decision, laid out feature by feature.
- [When plain Express is better](../express-vs-nestjs/when-plain-express-is-better.md) — the counter-case, in detail.
- [How Nest uses Express](../express-vs-nestjs/how-nest-uses-express.md) — what the adapter actually does with your controllers.
- [Installation and the CLI](installation-and-cli.md) — getting a project on disk, and the Node floor the CLI needs.
- [Modules](modules.md) — the graph this page keeps referring to.
- [Dependency injection](dependency-injection.md) — providers, tokens and why testing is the real payoff.
- [Layered architecture](../express/layered-architecture.md) — the structure Nest formalizes, explained without a framework.
- [Native TypeScript support](../node/native-typescript-support.md) — why decorators mean a build step.
