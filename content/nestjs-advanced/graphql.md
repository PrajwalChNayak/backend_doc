---
title: GraphQL
description: Building a GraphQL API with @nestjs/graphql 14 and the Apollo driver — code-first and schema-first, the GraphiQL default, graphql-ws subscriptions, resolvers versus services, DataLoader for N+1, and complexity limits as a real abuse control.
status: current
updated: 2026-09-11
---

`@nestjs/graphql` is a schema builder and a request pipeline, not a GraphQL server. The server is a **driver** — normally `ApolloDriver` from `@nestjs/apollo`, wrapping `@apollo/server`. Nest's contribution is that a resolver is an ordinary provider: it lives in a module, injects services through the container, and passes through the same guards, interceptors, pipes and filters your controllers do.

:::warning Versions here are not on the 12.x line
`@nestjs/graphql` and `@nestjs/apollo` are both at **14.0.0**, not 12.x. Writing `@nestjs/graphql@12` installs a version that predates the GraphiQL default and the `graphql-ws` switch documented below.
:::

## Why it exists

GraphQL earns its complexity in one situation: several clients, each needing a different shape of the same data, changing faster than you want to ship endpoints for. It costs you a query planner you did not write, a cache you cannot key on a URL, and an attack surface where a single request can ask for arbitrarily deep data.

If you have one first-party client and a REST API that fits it, GraphQL is a tax. [OpenAPI with Swagger](../nestjs-libraries/swagger.md) gets you typed clients without any of this.

## Installation

```bash
npm install @nestjs/graphql@14 @nestjs/apollo@14 @apollo/server@5 @as-integrations/express5 graphql@16
```

The driver loads `@as-integrations/express5` at runtime — that is the Apollo integration for Express 5, which is what `@nestjs/platform-express@12` bundles. Under the Fastify adapter the equivalent is `@as-integrations/fastify` (3.1.0); see [The Fastify adapter](fastify-adapter.md).

| Package | Version |
| --- | --- |
| `@nestjs/graphql` | 14.0.0 |
| `@nestjs/apollo` | 14.0.0 |
| `@apollo/server` | 5.5.1 |
| `@as-integrations/express5` | 1.1.2 |
| `graphql-ws` | 6.2.1 (a direct dependency of `@nestjs/graphql@14` — you do not install it) |
| `graphql` | see the note below |

:::warning Pin `graphql@16` with the Apollo driver
`graphql`'s npm `latest` tag is **17.0.2**, and `@nestjs/graphql@14.0.0` accepts `^16.11.0 || ^17.0.0`. But `@apollo/server@5.5.1` still declares `peerDependencies: { graphql: "^16.11.0" }` — it has not widened to 17. Installing `graphql@17` next to the Apollo driver produces a peer-dependency conflict that you would have to `--force` past.

Use the `latest-16` release, **16.14.2**, until Apollo widens the range. This is one of the few places in this handbook where the newest published version is not the one to install.
:::

## Code-first

In code-first you write TypeScript classes, and the SDL is generated from them at boot. This is the default for new Nest projects, and it is the right choice when the schema is an output of your domain model rather than a contract negotiated with another team.

```ts title="src/orders/order.model.ts"
import { Field, ID, Int, ObjectType } from '@nestjs/graphql'

@ObjectType()
export class Order {
  @Field(() => ID)
  id: string

  @Field()
  reference: string

  @Field(() => Int)
  totalCents: number

  @Field({ nullable: true })
  note?: string
}
```

The `() => Type` thunk is not decoration. TypeScript's emitted metadata cannot distinguish `number` from `Int` or `Float`, and it cannot see inside an array — so `@Field()` alone is enough for `string` and `boolean`, and everything else needs the explicit return type.

```ts title="src/app.module.ts"
import { Module } from '@nestjs/common'
import { GraphQLModule } from '@nestjs/graphql'
import { ApolloDriver, type ApolloDriverConfig } from '@nestjs/apollo'
import { join } from 'node:path'
import { OrdersModule } from './orders/orders.module.js'

@Module({
  imports: [
    GraphQLModule.forRoot<ApolloDriverConfig>({
      driver: ApolloDriver,
      autoSchemaFile: join(process.cwd(), 'src/schema.gql'),
      sortSchema: true,
      path: '/graphql',
    }),
    OrdersModule,
  ],
})
export class AppModule {}
```

`autoSchemaFile` writes the generated SDL to disk. Commit that file: it is the only artifact that makes a schema change visible in a diff, and a code review is the last place a breaking field removal can be caught cheaply. Pass `autoSchemaFile: true` to keep the schema in memory instead, which is faster and gives you nothing to review.

`sortSchema: true` orders the generated SDL lexicographically so the diff reflects real changes rather than the order your decorators happened to run in.

### Resolvers

```ts title="src/orders/orders.resolver.ts"
import { Args, ID, Mutation, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql'
import { Order } from './order.model.js'
import { OrderLine } from './order-line.model.js'
import { OrdersService } from './orders.service.js'
import { CreateOrderInput } from './create-order.input.js'

@Resolver(() => Order)
export class OrdersResolver {
  private readonly orders: OrdersService

  constructor(orders: OrdersService) {
    this.orders = orders
  }

  @Query(() => [Order], { name: 'orders' })
  findAll() {
    return this.orders.findAll()
  }

  @Query(() => Order, { name: 'order', nullable: true })
  findOne(@Args('id', { type: () => ID }) id: string) {
    return this.orders.findOne(id)
  }

  @Mutation(() => Order)
  createOrder(@Args('input') input: CreateOrderInput) {
    return this.orders.create(input)
  }

  @ResolveField(() => [OrderLine])
  lines(@Parent() order: Order) {
    return this.orders.linesFor(order.id)
  }
}
```

Inputs are their own decorator, because GraphQL has separate input and output type systems:

```ts title="src/orders/create-order.input.ts"
import { Field, InputType, Int } from '@nestjs/graphql'
import { IsInt, Length, Min } from 'class-validator'

@InputType()
export class CreateOrderInput {
  @Field()
  @Length(3, 64)
  reference: string

  @Field(() => Int)
  @IsInt()
  @Min(1)
  totalCents: number
}
```

`class-validator` decorators work here exactly as they do on an HTTP DTO, provided a `ValidationPipe` is in the pipeline. Register it with `APP_PIPE` so it covers both surfaces — see [The ValidationPipe](../nestjs-validation/validation-pipe.md).

## Schema-first

In schema-first the `.graphql` files are the source of truth and the TypeScript types are generated from them. Choose it when the schema is a contract that is agreed before the implementation, or when a non-TypeScript service also serves part of it.

```ts title="src/app.module.ts"
import { Module } from '@nestjs/common'
import { GraphQLModule } from '@nestjs/graphql'
import { ApolloDriver, type ApolloDriverConfig } from '@nestjs/apollo'
import { join } from 'node:path'

@Module({
  imports: [
    GraphQLModule.forRoot<ApolloDriverConfig>({
      driver: ApolloDriver,
      typePaths: ['./**/*.graphql'],
      definitions: {
        path: join(process.cwd(), 'src/graphql.types.ts'),
        outputAs: 'class',
      },
    }),
  ],
})
export class AppModule {}
```

`typePaths` is a glob of SDL files; `definitions` generates the matching TypeScript. `outputAs: 'class'` is worth setting because interfaces are erased at runtime and classes can carry validation decorators.

| | Code-first | Schema-first |
| --- | --- | --- |
| Source of truth | TypeScript classes | `.graphql` files |
| Schema drift | impossible — generated | possible — two places to edit |
| Review surface | the generated `schema.gql` diff | the SDL you wrote |
| Suits | one team owning both sides | a contract agreed across teams |
| Non-TS consumers of the schema | fine, once the file is committed | fine |

Pick one per project. A codebase with both is a codebase where nobody can answer "where is this field defined".

## GraphiQL is the default IDE

`@nestjs/graphql@14` removed the old GraphQL Playground. **GraphiQL is enabled automatically whenever `NODE_ENV` is not `production`**, and the `graphiql` option controls it explicitly.

```ts
import { GraphQLModule } from '@nestjs/graphql'
import { ApolloDriver, type ApolloDriverConfig } from '@nestjs/apollo'

GraphQLModule.forRoot<ApolloDriverConfig>({
  driver: ApolloDriver,
  autoSchemaFile: true,
  graphiql: {
    headers: { 'x-tenant': 'local-dev' },
    shouldPersistHeaders: true,
  },
  introspection: process.env.NODE_ENV !== 'production',
})
```

`graphiql` accepts `true`/`false` or an options object with `url`, `headers`, `shouldPersistHeaders`, `isHeadersEditorEnabled` and `inputValueDeprecation`.

:::deprecated
The `playground` option still exists on `ApolloDriverConfig`, but its own type declaration describes it as a *"deprecated boolean alias for GraphiQL"*. `playground: true` now enables GraphiQL, not the removed Playground IDE. Migrate to `graphiql` so the option name matches what actually renders.
:::

:::danger
Introspection and a browsable IDE on a production endpoint hand an attacker your full schema, including the fields you forgot to guard. `introspection` defaults to `true` unless `NODE_ENV` is `production`, which is a default that depends on an environment variable being set correctly in every deployment — verify it rather than assume it. Set both `introspection` and `graphiql` from explicit configuration; see [Secrets and config validation](../nestjs-security/secrets-and-config.md).
:::

## Subscriptions over graphql-ws

Subscriptions are off by default. One option turns them on:

```ts
import { GraphQLModule } from '@nestjs/graphql'
import { ApolloDriver, type ApolloDriverConfig } from '@nestjs/apollo'

GraphQLModule.forRoot<ApolloDriverConfig>({
  driver: ApolloDriver,
  autoSchemaFile: true,
  subscriptions: {
    'graphql-ws': true,
  },
})
```

`SubscriptionConfig` has exactly one key, `'graphql-ws'`, which takes `true` or an options object exposing `path`, `connectionInitWaitTimeout`, `onConnect`, `onDisconnect`, `onClose`, `onSubscribe` and `onNext`.

:::deprecated
The older `subscriptions-transport-ws` protocol is gone. That package's last release (0.11.0) carries the npm notice *"no longer maintained"*, and `@nestjs/graphql@14` has no option for it — `graphql-ws` 6.2.1 is a direct dependency and the only supported transport. A client still speaking the old protocol will fail to connect; upgrade the client library alongside the server.
:::

A resolver publishes and subscribes through a pub/sub implementation. `graphql-subscriptions` (3.0.0) ships an in-memory one:

```ts title="src/orders/orders.resolver.ts"
import { Args, ID, Mutation, Resolver, Subscription } from '@nestjs/graphql'
import { PubSub } from 'graphql-subscriptions'
import { Order } from './order.model.js'

const pubSub = new PubSub()

@Resolver(() => Order)
export class OrdersResolver {
  @Subscription(() => Order, { name: 'orderUpdated' })
  orderUpdated() {
    return pubSub.asyncIterableIterator('orderUpdated')
  }

  @Mutation(() => Order)
  async markShipped(@Args('id', { type: () => ID }) id: string) {
    const order = await this.orders.markShipped(id)
    await pubSub.publish('orderUpdated', { orderUpdated: order })
    return order
  }
}
```

:::warning
The in-memory `PubSub` is per process. With two replicas behind a load balancer, a subscriber on instance A never sees an event published on instance B, and the bug looks like "subscriptions work locally and half the time in staging". The fix is the same as for [WebSockets](websockets.md): a shared backend, published to and read from by every instance.
:::

Authentication happens at connection time, not per message. `onConnect` receives the `connectionParams` the client sent and can reject the socket:

```ts
import { GraphQLModule } from '@nestjs/graphql'
import { ApolloDriver, type ApolloDriverConfig } from '@nestjs/apollo'

GraphQLModule.forRoot<ApolloDriverConfig>({
  driver: ApolloDriver,
  autoSchemaFile: true,
  subscriptions: {
    'graphql-ws': {
      connectionInitWaitTimeout: 5000,
      onConnect: (context: any) => {
        const token = context.connectionParams?.authorization
        if (!isValidToken(token)) {
          throw new Error('Unauthorized')
        }
        context.extra.user = decodeToken(token)
      },
    },
  },
})
```

Two properties of this that matter: a WebSocket has no `Authorization` header you can rely on from a browser, so the token arrives in `connectionParams`; and the connection outlives the token's expiry, so long-lived subscriptions need a revocation check of their own. [JWT pitfalls](../nestjs-security/jwt-pitfalls.md) covers the second one.

## Resolvers versus services

A resolver is a controller. It exists to translate between the transport's vocabulary and your domain's, and it should contain no rules.

| Belongs in the resolver | Belongs in the service |
| --- | --- |
| `@Args()` binding and argument shape | business rules |
| mapping a domain object to a GraphQL model | database access |
| `@ResolveField()` wiring | authorization decisions |
| DataLoader lookups for this request | anything a REST controller would also need |

The test: if you added a REST endpoint for the same operation tomorrow, everything you would have to copy out of the resolver was in the wrong place. [Providers and services](../nestjs/providers-and-services.md) is the general version of this rule.

Guards, interceptors and filters work in resolvers, but the argument host is different — GraphQL has no `req`/`res` pair at the field level. Convert it:

```ts title="src/common/guards/gql-auth.guard.ts"
import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common'
import { GqlExecutionContext } from '@nestjs/graphql'

@Injectable()
export class GqlAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    const ctx = GqlExecutionContext.create(context)
    const request = ctx.getContext().req
    return Boolean(request?.user)
  }
}
```

`GqlExecutionContext` also exposes `getRoot()`, `getArgs()` and `getInfo()`. Note that guards on `@ResolveField()` are **off by default** — set `fieldResolverEnhancers: ['guards', 'interceptors', 'filters']` in the module options if you need them there, and be aware that means the guard runs once per parent object rather than once per request.

## The N+1 problem

This is the failure mode GraphQL is famous for, and it is structural rather than accidental. A query for 50 orders with their customers calls the `customer` field resolver 50 times, which is 50 round trips the client never asked for.

```text
query { orders(first: 50) { id customer { name } } }

→ SELECT … FROM orders LIMIT 50
→ SELECT … FROM customers WHERE id = $1      ×50
```

`DataLoader` (2.2.3) fixes it by batching every lookup made within one tick into a single call:

```ts title="src/orders/customer.loader.ts"
import { Injectable, Scope } from '@nestjs/common'
import DataLoader from 'dataloader'
import { CustomersService } from '../customers/customers.service.js'
import { Customer } from '../customers/customer.model.js'

@Injectable({ scope: Scope.REQUEST })
export class CustomerLoader {
  readonly byId: DataLoader<string, Customer | null>

  constructor(customers: CustomersService) {
    this.byId = new DataLoader<string, Customer | null>(async (ids) => {
      const rows = await customers.findByIds([...ids])
      const index = new Map(rows.map((row) => [row.id, row]))
      return ids.map((id) => index.get(id) ?? null)
    })
  }
}
```

```ts title="src/orders/orders.resolver.ts"
import { Parent, ResolveField, Resolver } from '@nestjs/graphql'
import { Customer } from '../customers/customer.model.js'
import { CustomerLoader } from './customer.loader.js'
import { Order } from './order.model.js'

@Resolver(() => Order)
export class OrdersResolver {
  private readonly loader: CustomerLoader

  constructor(loader: CustomerLoader) {
    this.loader = loader
  }

  @ResolveField(() => Customer, { nullable: true })
  customer(@Parent() order: Order) {
    return this.loader.byId.load(order.customerId)
  }
}
```

Two details decide whether this actually works:

- **The loader must be request-scoped.** A DataLoader caches by key for its own lifetime. A singleton loader would serve one user stale data that another user's request loaded — a correctness bug and, when the objects are authorization-sensitive, a data-leak bug. `Scope.REQUEST` costs you a new instance per request; that is the price, and it is the right one. See [Injection scopes](../nestjs/injection-scopes.md).
- **The batch function must return results in the order of the keys it was given**, with a placeholder for misses. Returning the raw query result reorders rows and silently attaches the wrong customer to the wrong order.

The query-shape half of the problem — what your ORM should be doing instead — is in [Avoiding N+1](../nestjs-orms/avoiding-n-plus-one.md).

## Depth and complexity limits are an abuse control

A REST endpoint has a fixed cost. A GraphQL endpoint's cost is chosen by the caller, and a recursive schema lets one small request ask for an amount of data that grows exponentially:

```text
query {
  orders { customer { orders { customer { orders { customer { name } } } } } }
}
```

Rate limiting does not save you here — that is one request. You need a cost ceiling evaluated before execution.

```bash
npm install graphql-query-complexity@2
```

```ts title="src/common/plugins/complexity.plugin.ts"
import { Plugin } from '@nestjs/apollo'
import { GraphQLSchemaHost } from '@nestjs/graphql'
import type { ApolloServerPlugin, BaseContext, GraphQLRequestListener } from '@apollo/server'
import { GraphQLError } from 'graphql'
import { fieldExtensionsEstimator, getComplexity, simpleEstimator } from 'graphql-query-complexity'

@Plugin()
export class ComplexityPlugin implements ApolloServerPlugin {
  private readonly schemaHost: GraphQLSchemaHost

  constructor(schemaHost: GraphQLSchemaHost) {
    this.schemaHost = schemaHost
  }

  async requestDidStart(): Promise<GraphQLRequestListener<BaseContext>> {
    const maxComplexity = 100
    const { schema } = this.schemaHost

    return {
      async didResolveOperation({ request, document }) {
        const complexity = getComplexity({
          schema,
          operationName: request.operationName,
          query: document,
          variables: request.variables,
          estimators: [fieldExtensionsEstimator(), simpleEstimator({ defaultComplexity: 1 })],
        })

        if (complexity > maxComplexity) {
          throw new GraphQLError(`Query is too complex: ${complexity}. Maximum: ${maxComplexity}`)
        }
      },
    }
  }
}
```

Register `ComplexityPlugin` as a provider in the module that imports `GraphQLModule`. `@Plugin()` is a class decorator from `@nestjs/apollo`; the driver discovers annotated providers itself.

Fields that are genuinely expensive declare their own cost, which `fieldExtensionsEstimator()` picks up:

```ts title="src/orders/orders.resolver.ts"
import { Args, Int, Query, Resolver } from '@nestjs/graphql'
import type { ComplexityEstimatorArgs } from '@nestjs/graphql'
import { Order } from './order.model.js'

@Resolver(() => Order)
export class OrdersResolver {
  @Query(() => [Order], {
    complexity: (options: ComplexityEstimatorArgs) => options.args.first * options.childComplexity,
  })
  orders(@Args('first', { type: () => Int }) first: number) {
    return this.ordersService.findAll(first)
  }
}
```

`complexity` is also a valid `@Field()` option, so a single expensive field can be priced without touching the query that reaches it.

Depth limiting is the cruder sibling — reject any query nested more than N levels deep. It is a useful backstop, but note that `graphql-depth-limit` on npm is at 1.1.0 and was last published in 2022; if you want a depth rule, write it as a `validationRules` entry or fold the same idea into the complexity estimator above rather than adopting an unmaintained dependency.

:::best-practice
Turn on three controls together, because each covers what the others miss:

1. **Complexity limit** — caps what one request can cost.
2. **Rate limit** on the `/graphql` path — caps how many requests arrive. See [Rate limiting and abuse](../nestjs-security/rate-limiting.md).
3. **`introspection: false` in production** — stops the schema being enumerated to find the expensive fields in the first place.

Then measure the complexity of your real clients' largest legitimate query and set the ceiling above it, not at a round number you guessed.
:::

## Errors

By default the Apollo driver maps `HttpException` subclasses to Apollo errors — `autoTransformHttpErrors` defaults to `true`. So a `NotFoundException` thrown in a service reaches the client as a GraphQL error rather than as a crash, and your existing service code needs no GraphQL-specific handling.

Two related options are worth knowing before you debug a confusing status code:

| Option | Default | Effect |
| --- | --- | --- |
| `autoTransformHttpErrors` | `true` | registers an interceptor mapping `HttpException` to Apollo errors |
| `preserveHttpStatusForExecutionErrors` | `true` | keeps the `{ data, errors }` shape by resetting execution-error HTTP status to 200 |

A GraphQL response is almost always HTTP 200 with an `errors` array. Monitoring that alerts on 5xx will not see a GraphQL API failing; alert on the `errors` array instead. [Observability](../nestjs-production/observability.md) has the general case.

## Common mistakes

- **Installing `@nestjs/graphql@12`.** The current line is 14. You get a version without the GraphiQL default and without the `graphql-ws` switch.
- **Installing `graphql@17` with the Apollo driver.** `@apollo/server@5.5.1` still declares `^16.11.0`. Pin `graphql@16.14.2`.
- **Leaving `introspection` on in production.** It is only off by default when `NODE_ENV` is exactly `production`. Set it from validated configuration.
- **Shipping GraphQL without a complexity limit.** One request can cost unbounded work. Rate limiting does not help; it is one request.
- **A singleton DataLoader.** Its cache outlives the request and serves one user data loaded for another. Make it `Scope.REQUEST`.
- **A batch function that returns rows in database order.** DataLoader matches results to keys positionally. Reindex and map in key order, with `null` for misses.
- **Business rules in a resolver.** The moment you add a REST endpoint for the same operation you will copy them. Push them into a service.
- **Expecting guards to run on `@ResolveField()`.** They do not, unless `fieldResolverEnhancers` includes `'guards'`.
- **An in-memory `PubSub` behind more than one replica.** Subscribers only see events published by the instance they happen to be connected to.
- **Both code-first and schema-first in one project.** Nobody can then answer where a field is defined.
- **Not committing the generated `schema.gql`.** It is the only place a breaking schema change shows up in a diff.
- **Alerting on HTTP 5xx.** A failing GraphQL API returns 200 with an `errors` array.

## Related topics

- [Avoiding N+1](../nestjs-orms/avoiding-n-plus-one.md) — the query-shape half of the DataLoader story.
- [Rate limiting and abuse](../nestjs-security/rate-limiting.md) — the request-count control that sits next to complexity limits.
- [Injection scopes](../nestjs/injection-scopes.md) — why the loader has to be `Scope.REQUEST`, and what that costs.
- [Guards](../nestjs-request-handling/guards.md) — the class `GqlExecutionContext` adapts.
- [The ValidationPipe](../nestjs-validation/validation-pipe.md) — validating `@InputType()` arguments.
- [Exception filters](../nestjs-request-handling/exception-filters.md) — what `autoTransformHttpErrors` is standing in for.
- [WebSockets](websockets.md) — the same multi-instance fan-out problem, and the Redis answer to it.
- [The Fastify adapter](fastify-adapter.md) — the `@as-integrations/fastify` path.
- [Secrets and config validation](../nestjs-security/secrets-and-config.md) — making `NODE_ENV` a thing you verify, not assume.
- [JWT pitfalls](../nestjs-security/jwt-pitfalls.md) — tokens on a connection that outlives them.
- [OpenAPI with Swagger](../nestjs-libraries/swagger.md) — the REST alternative, with typed clients.
- [Observability](../nestjs-production/observability.md) — why 200-with-errors breaks naive alerting.
