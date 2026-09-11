---
title: When plain Express is better
description: The honest case for staying on Express 5 — small services, single-purpose APIs, serverless cold starts, teams without TypeScript, and the situations where dependency injection is pure ceremony.
status: current
updated: 2026-09-11
---

Nest is the right default for a long-lived product API with several people on it. It is the wrong default for a large number of real services, and choosing it for them is not a harmless over-engineering — it costs a build step, a per-request pipeline, a framework upgrade cadence, and a layer of indirection between the URL and the code that answers it. This page argues the other side properly, so that choosing Express is a decision you can defend rather than one you apologize for.

## The case, stated plainly

Express 5 is a mature, actively maintained HTTP layer with one concept in it: an ordered list of functions that take `(req, res, next)`. Everything else you use with it — validation, authentication, logging, an ORM — is a library you chose, and can replace, independently.

That is not a lack of architecture. It is architecture that lives in your repository instead of in a framework's release notes. For a service whose shape is already clear, that is the stronger position.

## Small services and single-purpose APIs

A service with fewer than about ten endpoints does not have a structure problem. It has one router file, one service module, and a `db.js`. Adding modules, providers, a container and a decorator vocabulary on top of that is not organizing it; it is spreading it across three times as many files so that the container has something to resolve.

The whole of a real service, laid out the way [Layered architecture](../express/layered-architecture.md) describes:

```js title="src/app.js"
import express from 'express'
import helmet from 'helmet'
import { createUsersRouter } from './users/users.router.js'
import { errorHandler, notFound } from './middleware/errors.js'

export function createApp({ users }) {
  const app = express()
  app.disable('x-powered-by')
  app.set('trust proxy', 1)
  app.use(helmet())
  app.use(express.json({ limit: '100kb' }))
  app.use('/users', createUsersRouter(users))
  app.use(notFound)
  app.use(errorHandler)
  return app
}
```

Eleven lines, and every behavior of the application is visible in them, in execution order. There is no equivalent file in a Nest application — the closest thing, `main.ts`, does not tell you which guards run, because those are declared on the classes they guard.

For a service this size that is a real advantage, not nostalgia. The first question anyone asks about an unfamiliar service is "what happens to a request", and here the answer fits on a screen.

**Where the line is.** The moment two or three of these are true, the calculus flips: more than ten endpoints, more than three people, cross-cutting rules repeated on every route, or a second entry point (a worker, a consumer) that needs the same business logic. Until then, the ceremony has no payoff to amortize.

## Webhook receivers, proxies and gateways

Some services have no business rules at all. A Stripe webhook receiver verifies a signature, writes a row, and returns 200. A gateway forwards a request upstream and translates an error shape. A health aggregator polls three URLs.

There is nothing to isolate into a service layer, nothing to inject, and nothing that will ever need a second implementation. A DI container in that codebase is a component that can fail — at bootstrap, in a test runner configuration, in a Docker image — in exchange for nothing.

Raw-body handling is a concrete example of the asymmetry. In Express you mount a parser scoped to the route:

```js
app.post('/webhooks/stripe', express.raw({ type: 'application/json' }), (req, res) => {
  const event = verifySignature(req.body, req.get('stripe-signature'))
  queue.add('stripe-event', event)
  res.sendStatus(204)
})
```

That is the entire feature. The Nest version needs the application created with `rawBody: true`, a controller, a module, and `@Req()` or `@Body()` handling that opts out of the normal pipeline — all to reach the same `Buffer`.

## Serverless and cold starts

Nest builds the complete provider graph before it serves a request. On a long-running server this happens once and nobody notices. On a function that scales to zero, it happens on every cold start, and it is additive to everything else the runtime already has to do.

The cost is milliseconds, not seconds — do not let anyone tell you Nest is unusable in Lambda, because it plainly is not. But it is milliseconds you do not spend with a bare handler, multiplied by your cold-start rate, and it grows with the size of your module graph rather than with the work the request actually needs.

A handler with no framework at all:

```js title="handler.js"
import { getUser } from './users.js'

export async function handler(event) {
  const user = await getUser(event.pathParameters.id)
  if (!user) return { statusCode: 404, body: JSON.stringify({ error: 'not found' }) }
  return { statusCode: 200, body: JSON.stringify(user) }
}
```

There is no application to bootstrap, so there is nothing to keep warm. If your latency budget is stated in a contract and your traffic is spiky, this is the correct shape, and wrapping it in a framework — either framework — is a cost with no matching benefit.

:::note
The general advice also applies to functions: keep the module graph small, initialize database pools outside the handler, and measure rather than assume. What is specific to Nest is that the graph is built eagerly and you cannot make it lazy for free — [Lazy-loaded modules](../nestjs-advanced/lazy-loaded-modules.md) exist precisely because of this, and they are an optimization you have to apply deliberately.
:::

## Teams without TypeScript

This is the most decisive item on the list, and the one most often waved away.

Nest does not merely *support* TypeScript. It depends on decorator metadata emitted by the TypeScript compiler and read at runtime through `reflect-metadata`. Constructor parameter types are not documentation in a Nest project — they are the wiring. Consequences a team new to TypeScript will hit in week one:

- Every environment needs a build step. There is no `node src/main.js` equivalent during development.
- `experimentalDecorators` and `emitDecoratorMetadata` must be set in every tsconfig that compiles the application, including the one the test runner uses.
- `import type { SomeService }` for an injected class silently breaks resolution, because the import is erased and the container receives `undefined`.
- Container failures surface as multi-line messages about module imports, which are unreadable until you already understand the module graph.

Express asks for none of that. A team can ship JavaScript today, add `// @ts-check` and JSDoc types next quarter, and migrate file by file after that — with the application running the whole time.

:::best-practice
Do not adopt TypeScript *and* a DI framework in the same quarter. They are two independent learning curves, and combining them means every problem has two candidate causes. Take TypeScript first, on Express, where the types are optional and the runtime does not depend on them.
:::

## When dependency injection is ceremony

DI earns its keep when dependencies are deep, shared and worth substituting. It is overhead when they are none of those things.

Compare the two ways to make a service testable. Express, with a factory:

```js title="src/users/users.service.js"
export function createUsersService({ repository, clock }) {
  return {
    async findById(id) {
      const user = await repository.findById(id)
      if (!user) return null
      return { ...user, fetchedAt: clock.now() }
    },
  }
}
```

A test passes fakes directly. There is no container, no token, no module, and no decorator — and the substitution seam is exactly as good as Nest's for a graph this shallow.

Nest's advantage appears when the thing you want to replace is **four levels down**. `overrideProvider(Clock).useValue(fixedClock)` reaches every consumer in the graph in one line; the factory version means threading `clock` through four constructors, which is the work the container exists to remove.

So the question is not "do I want testable code" — both are testable. It is "how deep is my graph, and how often do I substitute something in the middle of it". For most small services the honest answers are "two levels" and "never".

:::warning
The strongest signal that you chose wrong is a Nest module whose `providers` array holds one service that injects nothing. The container is resolving a graph with no edges. That is pure ceremony, and it is worth noticing before you have forty of them.
:::

## Precise control over the middleware order

Nest's pipeline is fixed: middleware, guards, interceptors, pipes, handler, interceptors, filters. That fixed order is a feature — it is why every Nest codebase behaves the same — until the day you need something to run between two of the stages.

In Express, order is the array. Anything can go anywhere, and the file that lists it is the specification:

```js
app.use(rawBodyCapture)        // before any parser
app.use(express.json())
app.use(tenantResolver)        // after parsing, before auth, because it reads the body
app.use(authenticate)
app.use('/api', routes)
```

`tenantResolver` sits between body parsing and authentication. In Nest that position does not exist as a named stage: middleware runs before routing is resolved, and guards run after. You can express it, but you are choosing the least-wrong stage rather than the right one.

## What you give up

An honest page has to argue against itself. Staying on Express costs you these, and they are real:

| You give up | What it means in practice |
| --- | --- |
| Automatic transitive DI | Adding a dependency to a leaf service means editing everything that constructs it. |
| One uniform test seam | Each module decides how it is substituted, and the conventions drift. |
| Enforced structure | Your layout holds exactly as long as code review holds. New joiners copy whatever they opened first. |
| Decorator-generated OpenAPI | You maintain the schema by hand or generate it from Zod; either way it is a second job. |
| First-party modules | Config validation, health probes, schedules and queues are packages you integrate yourself. |
| Guards and interceptors | Per-route authorization and response shaping are middleware you order correctly, every time. |
| A shared vocabulary | "Where does this go?" is answered by your documentation, not by the framework. |

None of these is fatal for a small service, and every one of them compounds in a large one. That asymmetry is the entire decision.

## A decision you can defend

Write the reasoning down when you choose Express, because the question will come back:

1. **Name the endpoint count and the team size.** "Nine endpoints, two developers" is a defensible reason. "It felt lighter" is not.
2. **Name the cross-cutting concerns you actually have.** If the answer is "auth and request logging", middleware covers both.
3. **Name the second entry point, if any.** A worker or consumer that shares business rules is the strongest argument for Nest that exists.
4. **Write down the layering you are committing to,** and enforce it in review. This is the part Nest would otherwise do for you, and skipping it is how the decision goes wrong.
5. **Keep the escape hatch honest.** Business rules in plain functions and classes, HTTP concerns in routers. Then [Migrating incrementally](migrating-incrementally.md) stays cheap if the situation changes.

The service that regrets choosing Express is almost never the one that was too small. It is the one that grew and never revisited the decision.

## Common mistakes

- **Treating "Express is simpler" as self-evident.** It is simpler only if you keep it simple. An Express app with a hand-rolled container and decorator router is more complex than Nest, and worse supported.
- **Skipping the layering because there is no framework enforcing it.** Business logic in route handlers is the actual cause of most "we should have used Nest" post-mortems, and it is a discipline problem, not a framework one.
- **Choosing Express and then adding every Nest feature one package at a time.** Three or four of those and you have paid Nest's cost without its coherence.
- **Assuming serverless rules out Nest entirely.** It does not. It makes the bootstrap cost visible, which is a reason to measure, not a prohibition.
- **Using "the team does not know TypeScript" as a permanent answer.** It is a strong argument today and a weak one in a year. Revisit it rather than inheriting it.
- **Believing the choice is one-way.** Nest mounts inside an existing Express application, so routes can move over one at a time.
- **Re-deciding this every sprint.** Pick, write down why, and revisit on a trigger — a team-size change, a second entry point, a rewrite — not on a mood.

## Related topics

- [The comparison](comparison.md) — the same decision, dimension by dimension.
- [Migrating incrementally](migrating-incrementally.md) — the escape hatch, and how to keep it cheap.
- [How Nest uses Express](how-nest-uses-express.md) — proof that the two are not separate worlds.
- [Layered architecture](../express/layered-architecture.md) — the structure to commit to when no framework enforces it.
- [Setup and project structure](../express/setup-and-project-structure.md) — the `app.js` / `server.js` split this page assumes.
- [Middleware](../express/middleware.md) — ordering as a first-class design tool.
- [Introduction and when to choose Nest](../nestjs/introduction.md) — the opposing case, argued by the other side.
- [Injection scopes](../nestjs/injection-scopes.md) — what the container does per request, when you do adopt one.
- [Lazy-loaded modules](../nestjs-advanced/lazy-loaded-modules.md) — the answer to Nest's eager bootstrap in serverless.
