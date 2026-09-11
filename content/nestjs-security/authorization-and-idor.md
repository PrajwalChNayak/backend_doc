---
title: Authorization and IDOR
description: Why a NestJS guard cannot do object-level authorization, the IDOR exploit it fails to stop, and the service-layer fix that scopes every query by owner — with nested resources, write paths and a supertest proof.
status: current
updated: 2026-09-11
---

Broken object-level authorization is the most exploited API vulnerability in the world, and Nest has a specific way of producing it: the framework gives you a beautiful place to put authorization checks, and that place runs before the resource exists. A guard answers "may this caller attempt this operation". It structurally cannot answer "does this caller own record 1042", and the gap between those two questions is where the breach happens.

This is the framework-independent problem described in [IDOR and broken object-level authorization](../security/broken-object-level-authorization.md). What follows is why the Nest pipeline makes it easy to get wrong, and exactly where the check belongs instead.

## The threat

An authenticated user changes an identifier in a URL and reads, edits or deletes another user's data. There is no malformed input, no injection, no bypassed login. The request is well-formed and authenticated; the application simply never asked whether this caller is entitled to *this object*.

It is cheap to find (increment a number), cheap to exploit (a `for` loop), and total (every record of every user). OWASP lists it as `API1:2023`, first, and it has stayed first across editions because frameworks keep making authentication easy and object-level authorization manual.

## Why a guard cannot do it

Guards run at a fixed point in the [request lifecycle](../nestjs/request-lifecycle.md): after routing has resolved the handler, before pipes parse the body, and — the part that matters — **before any of your code has touched the database**. A guard receives an `ExecutionContext`. From it, it can read the JWT claims your authentication guard put on `request.user`, the route metadata, and the raw path parameters. That is the entire universe available to it.

`request.params.id` is a string the caller chose. Comparing it to anything in the token tells you nothing about a row.

:::danger A guard that authorizes nothing
```ts vulnerable title="DO NOT COPY — src/orders/guards/order-owner.guard.ts"
import { Injectable } from '@nestjs/common'
import type { CanActivate, ExecutionContext } from '@nestjs/common'

@Injectable()
export class OrderOwnerGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest()
    // There is no order here. Only a string from the URL and a token.
    // This checks that the caller is logged in and the URL is well-formed.
    return Boolean(request.user) && typeof request.params.id === 'string'
  }
}
```
:::

The obvious repair — make the guard load the order — is worse than it looks:

- The guard fetches the row, then the handler fetches it again. Two round trips, and under a concurrent write the two reads can disagree, so you authorized a version of the record you did not act on.
- The guard has become a data-access layer with no transaction around it, and it lives in `common/guards/` where nobody expects a query.
- It only works for routes whose object identifier is a path parameter. A body-driven operation, a batch endpoint, or a nested resource needs a different guard each time, and each one is a new place to forget.

Guards are the right home for **function-level** authorization — roles, scopes, feature flags, "may an admin call this at all". That is `API5:2023`, and it is a real control. It is just a different one.

> **Guards decide what a user may attempt. Services decide what a user may touch.**

## The exploit

An orders API. Authentication works, the roles guard works, the endpoint is a complete data breach.

:::danger IDOR through a path parameter
```ts vulnerable title="DO NOT COPY — src/orders/orders.controller.ts"
import { Controller, Get, Param, UseGuards } from '@nestjs/common'
import { AuthGuard } from '../common/guards/auth.guard.js'
import { OrdersService } from './orders.service.js'

@Controller('orders')
@UseGuards(AuthGuard)
export class OrdersController {
  private readonly orders: OrdersService

  constructor(orders: OrdersService) {
    this.orders = orders
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    // The guard proved someone is logged in. Nothing proved it is this order's owner.
    return this.orders.findOne(id)
  }
}
```

```ts vulnerable title="DO NOT COPY — src/orders/orders.service.ts"
@Injectable()
export class OrdersService {
  findOne(id: string) {
    return this.repo.findOne({ where: { id } })
  }
}
```
:::

A valid token belonging to user B, and a number:

```bash
curl -s -H 'authorization: Bearer <user-B token>' localhost:3000/orders/1042
```

```json title="200 OK — user A's order"
{
  "id": 1042,
  "userId": "a-11",
  "totalCents": 48900,
  "email": "victim@example.test",
  "shippingAddress": "12 Rue de la Paix, 75002 Paris",
  "last4": "4242"
}
```

And then the loop, which is the actual incident:

```bash
for id in $(seq 1 5000); do
  curl -s -H 'authorization: Bearer <user-B token>' "localhost:3000/orders/$id"
done > everything.json
```

Every response is a 200. Nothing in your logs distinguishes this from a customer refreshing a page, unless you are alerting on per-token request rates.

## The fix: scope the query, do not check afterwards

Put the owner in the `WHERE` clause. The authoritative check lives in the service or the repository — the layer that already knows how to load the object — and it is expressed as *part of the read*, not as a comparison after it.

```ts good title="src/orders/orders.service.ts"
import { Injectable, NotFoundException } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { Repository } from 'typeorm'
import { Order } from './order.entity.js'

@Injectable()
export class OrdersService {
  private readonly repo: Repository<Order>

  constructor(@InjectRepository(Order) repo: Repository<Order>) {
    this.repo = repo
  }

  async findOneForUser(id: string, userId: string): Promise<Order> {
    // Ownership is part of the query. There is no window between read and check,
    // and no code path that can forget the second half.
    const order = await this.repo.findOne({ where: { id, userId } })
    if (!order) {
      throw new NotFoundException('Order not found', { errorCode: 'ORDER_NOT_FOUND' })
    }
    return order
  }
}
```

```ts good title="src/orders/orders.controller.ts"
import { Controller, Get, Param, ParseUUIDPipe, UseGuards } from '@nestjs/common'
import { AuthGuard } from '../common/guards/auth.guard.js'
import { CurrentUser } from '../common/decorators/current-user.decorator.js'
import { OrdersService } from './orders.service.js'

@Controller('orders')
@UseGuards(AuthGuard)
export class OrdersController {
  private readonly orders: OrdersService

  constructor(orders: OrdersService) {
    this.orders = orders
  }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string, @CurrentUser('id') userId: string) {
    // The caller identity is a required argument. You cannot call this wrong.
    return this.orders.findOneForUser(id, userId)
  }
}
```

The other ORMs say the same thing:

| ORM | Scoped read |
| --- | --- |
| TypeORM | `repo.findOne({ where: { id, userId } })` |
| Prisma | `prisma.order.findFirst({ where: { id, userId } })` |
| Mongoose | `model.findOne({ _id: id, userId }).lean()` |
| Drizzle | `db.select().from(orders).where(and(eq(orders.id, id), eq(orders.userId, userId)))` |
| raw `pg` | `'SELECT … FROM orders WHERE id = $1 AND user_id = $2'` |

:::warning Prisma's `findUnique` cannot take a non-unique filter
`prisma.order.findUnique({ where: { id, userId } })` is a type error unless `(id, userId)` is a declared compound unique. The correct scoped read is `findFirst`, which accepts arbitrary filters and returns `null` when nothing matches. Reaching for `findUnique` and then comparing `order.userId` afterwards is exactly the fetch-then-check shape this page is about.
:::

### Why not fetch-then-check

```ts vulnerable title="DO NOT COPY — src/orders/orders.service.ts"
async findOne(id: string, userId: string) {
  const order = await this.repo.findOne({ where: { id } })
  if (!order) throw new NotFoundException()
  if (order.userId !== userId) throw new ForbiddenException()  // three problems
  return order
}
```

It *works*, and it is still the wrong shape:

1. **The two branches have different response codes**, which makes the endpoint an existence oracle. `404` means no such order; `403` means the order exists and belongs to somebody else. An attacker enumerating ids now has a map of which records exist.
2. **The check is a separate statement, so it can be skipped.** The next method somebody adds — `findOneWithItems`, `findOneForPdf` — copies the fetch and not the comparison. Scoping the query makes the omission impossible to express: there is no `findOneForUser` without a `userId` argument.
3. **The row you authorized is not necessarily the row you act on.** Under a concurrent transfer of ownership, the read and the subsequent write can see different states. A single scoped statement, or a scoped `UPDATE … WHERE`, has no such window.

Make ownership a *parameter of the operation*, not a post-condition of it.

## 404, not 403

Return `404 Not Found` when the caller is not entitled to the object. Not `403 Forbidden`.

`403` is a true statement — you are forbidden — and it leaks. It confirms the record exists, which is enough on its own for order counts, user-id ranges, "is this email registered", and internal document numbering. `404` gives the attacker the same response for "does not exist" and "not yours", which is exactly as much information as an unauthenticated stranger deserves.

| Situation | Status |
| --- | --- |
| no or invalid credentials | 401 |
| authenticated, may not call this **endpoint** at all (role/scope) | 403 |
| authenticated, may call the endpoint, not entitled to this **object** | **404** |
| authenticated, entitled, the object genuinely does not exist | **404** |

The distinction is object versus function. An `/admin/*` route a normal user calls is a `403`: the endpoint is not for them and hiding that fact protects nothing. `GET /orders/1042` belonging to someone else is a `404`: the endpoint is theirs, the object is not, and the object's existence is the secret.

:::best-practice
Make the 404 identical in body, headers and timing to a genuine miss. A `403`-shaped body behind a 404 status, an `X-Order-Exists` debug header, or a measurably slower response for real records all restore the oracle you just removed.
:::

## Write paths: the `userId` in the body

Reads are the half everybody tests. Writes are the half that gets exploited, because the identifier can arrive in the body instead of the URL.

:::danger The owner taken from the payload
```ts vulnerable title="DO NOT COPY — src/orders/orders.controller.ts"
@Patch(':id')
update(@Param('id') id: string, @Body() body: UpdateOrderDto) {
  // Whatever `body` says about ownership is what gets written.
  return this.orders.update(id, body)
}
```
:::

Two distinct attacks come out of that:

```bash
# 1 — edit someone else's order
curl -s -X PATCH localhost:3000/orders/1042 \
  -H 'authorization: Bearer <user-B token>' -H 'content-type: application/json' \
  -d '{"shippingAddress":"attacker@somewhere"}'
```

```bash
# 2 — steal it outright, by rewriting the owner column
curl -s -X PATCH localhost:3000/orders/1042 \
  -H 'authorization: Bearer <user-B token>' -H 'content-type: application/json' \
  -d '{"userId":"b-99"}'
```

```json title="200 OK — order 1042 now belongs to the attacker"
{ "id": 1042, "userId": "b-99", "totalCents": 48900 }
```

The second one is mass assignment and IDOR at the same time, and it needs two independent fixes:

**One — the owner must not be a writable field.** `whitelist: true` plus a DTO that does not declare `userId` means the key never reaches your service. See [Validation as a security control](validation-as-a-control.md).

```ts good title="src/orders/dto/update-order.dto.ts"
import { IsOptional, IsString, MaxLength } from 'class-validator'

// No userId. No id. No status. Only what this operation may change.
export class UpdateOrderDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  shippingAddress?: string
}
```

**Two — the write itself is scoped.** A scoped `UPDATE` is a single statement whose affected-row count *is* the authorization result:

```ts good title="src/orders/orders.service.ts"
import { Injectable, NotFoundException } from '@nestjs/common'

@Injectable()
export class OrdersService {
  async updateForUser(id: string, userId: string, patch: UpdateOrderDto): Promise<Order> {
    // The WHERE clause carries the ownership check. Zero rows affected means
    // "not found or not yours", which is the same answer to the caller.
    const result = await this.repo.update({ id, userId }, patch)
    if (result.affected === 0) {
      throw new NotFoundException('Order not found', { errorCode: 'ORDER_NOT_FOUND' })
    }
    return this.findOneForUser(id, userId)
  }

  async removeForUser(id: string, userId: string): Promise<void> {
    const result = await this.repo.delete({ id, userId })
    if (result.affected === 0) {
      throw new NotFoundException('Order not found', { errorCode: 'ORDER_NOT_FOUND' })
    }
  }
}
```

Creates need the same discipline in the other direction: the owner is assigned **from the token**, never copied from the payload.

```ts good title="src/orders/orders.service.ts"
create(userId: string, dto: CreateOrderDto): Promise<Order> {
  // userId comes from the verified token. The DTO has no say in it.
  return this.repo.save(this.repo.create({ ...dto, userId }))
}
```

:::warning `repo.save()` with a full entity is an update
TypeORM's `save()` performs an `UPDATE` when the object carries a primary key. An entity built from a request body that happens to include `id` therefore writes to whatever row that id names — with no `WHERE user_id`. Use `repo.update(scopedCriteria, patch)` for edits, and keep `save()` for entities you loaded through a scoped read.
:::

## Nested resources

`GET /orders/1042/items/77` has two identifiers and two chances to get it wrong. The common failure is checking the parent and then loading the child by its own id:

:::danger A parent check that the child ignores
```ts vulnerable title="DO NOT COPY"
async findItem(orderId: string, itemId: string, userId: string) {
  await this.ordersService.findOneForUser(orderId, userId) // checks the parent…
  return this.itemsRepo.findOne({ where: { id: itemId } }) // …and then ignores it
}
```

`GET /orders/<my own order>/items/77` returns item 77 from *any* order, because the parent that was validated is not the parent the child belongs to.
:::

Scope the child by both keys in one query:

```ts good title="src/orders/order-items.service.ts"
async findItemForUser(orderId: string, itemId: string, userId: string) {
  const item = await this.itemsRepo.findOne({
    where: {
      id: itemId,
      order: { id: orderId, userId }, // the join carries the ownership predicate
    },
  })
  if (!item) throw new NotFoundException('Item not found', { errorCode: 'ITEM_NOT_FOUND' })
  return item
}
```

The same rule covers **referenced** ids in a payload. `POST /orders` with `{"addressId":"…","paymentMethodId":"…"}` must verify that both of those belong to the caller before the order is created — otherwise a user charges somebody else's saved card or ships to an address they do not own. Every foreign key that arrives from a client is an object-level authorization decision.

```ts good title="src/orders/orders.service.ts"
async create(userId: string, dto: CreateOrderDto) {
  // Each referenced id is re-fetched scoped to the caller. Nothing is trusted
  // just because it was in the body of an authenticated request.
  const [address, paymentMethod] = await Promise.all([
    this.addresses.findOneForUser(dto.addressId, userId),
    this.paymentMethods.findOneForUser(dto.paymentMethodId, userId),
  ])
  return this.repo.save(this.repo.create({ userId, address, paymentMethod, items: dto.items }))
}
```

## Multi-tenancy is the same problem with a bigger blast radius

In a tenant-scoped application the predicate is `tenantId` rather than `userId`, and a missed one exposes another company's data rather than another person's. Two things make it more tractable than per-user ownership:

- **The predicate is uniform.** Every tenant-owned table has the same column, so a repository base class or a query helper can enforce it in one place.
- **The database can enforce it.** PostgreSQL row-level security with a session variable set per request means a query that forgets the predicate returns zero rows instead of everything. It is the only control on this page that survives a developer mistake.

Neither removes the need for the scoped query; both turn "someone forgot" from a breach into a bug.

## Unguessable ids are a mitigation, not a control

Switching from `1042` to a UUID makes enumeration impractical. It does not make the endpoint authorized. Ids leak constantly — in emails, in shared links, in referrer headers, in support tickets, in a former employee's browser history, in the response body of a *different* endpoint that lists them. The moment one leaks, an unscoped query serves it.

Use unpredictable identifiers, because they raise the cost of discovery. Then write the `WHERE` clause anyway.

## Where CASL fits

Attribute-based rules — "a manager may read any order in their region, a user may read their own" — outgrow a two-column `WHERE`. `@casl/ability` **7.0.1** models those rules as data and can produce a filter from an ability, which keeps the check inside the query rather than after it.

The important property to preserve when you adopt it: the ability must be **applied to the query**, not used to filter results in memory after loading them. An ability check that runs on a loaded array is fetch-then-check with more ceremony, and it still reads rows the caller may not see. The library integration is covered in [Authorization](../nestjs-libraries/authorization.md).

## Function-level authorization still needs a guard

Object-level and function-level are separate checks, and satisfying one says nothing about the other. `API5:2023` is the case where the endpoint itself is not for this caller:

```ts good title="src/app.module.ts"
import { Module } from '@nestjs/common'
import { APP_GUARD } from '@nestjs/core'
import { AuthGuard } from './common/guards/auth.guard.js'
import { RolesGuard } from './common/guards/roles.guard.js'

@Module({
  providers: [
    // Declaration order is execution order: authentication must populate
    // request.user before the roles guard reads it.
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}
```

A `@Roles('admin')` decorator with no registered `RolesGuard` is inert metadata and the route is open to everyone authenticated. Nothing warns you. See [Guards](../nestjs-request-handling/guards.md).

## Verifying

The test that matters is the one that proves user B gets a 404 for user A's resource — and, separately, that user A still gets a 200 for their own, because "scope everything to nothing" also passes a badly written test.

```ts title="test/idor.e2e-spec.ts"
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { AppModule } from '../src/app.module.js'
import { seedTwoUsersWithOrders } from './fixtures/orders.fixture.js'

describe('object-level authorization on /orders', () => {
  let app: import('@nestjs/common').INestApplication
  let tokenA: string
  let tokenB: string
  let orderOfA: string

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = moduleRef.createNestApplication()
    await app.init()
    ;({ tokenA, tokenB, orderOfA } = await seedTwoUsersWithOrders(app))
  })

  afterAll(() => app.close())

  it('lets the owner read their own order', () =>
    request(app.getHttpServer())
      .get(`/orders/${orderOfA}`)
      .set('authorization', `Bearer ${tokenA}`)
      .expect(200))

  it("returns 404 — not 403 — for another user's order", async () => {
    const response = await request(app.getHttpServer())
      .get(`/orders/${orderOfA}`)
      .set('authorization', `Bearer ${tokenB}`)
      .expect(404)

    // The body must not confirm the order exists.
    expect(JSON.stringify(response.body)).not.toContain(orderOfA)
  })

  it("refuses to update another user's order", () =>
    request(app.getHttpServer())
      .patch(`/orders/${orderOfA}`)
      .set('authorization', `Bearer ${tokenB}`)
      .send({ shippingAddress: 'attacker' })
      .expect(404))

  it('ignores a userId in the body', async () => {
    await request(app.getHttpServer())
      .patch(`/orders/${orderOfA}`)
      .set('authorization', `Bearer ${tokenB}`)
      .send({ userId: 'b-99' })
      .expect(400) // forbidNonWhitelisted: userId is not on the DTO

    // And the order is still A's.
    await request(app.getHttpServer())
      .get(`/orders/${orderOfA}`)
      .set('authorization', `Bearer ${tokenA}`)
      .expect(200)
  })

  it("refuses to delete another user's order", () =>
    request(app.getHttpServer())
      .delete(`/orders/${orderOfA}`)
      .set('authorization', `Bearer ${tokenB}`)
      .expect(404))
})
```

Write this once per owned resource, not once per application. A helper that takes a route template and two tokens and asserts the whole matrix — read, update, delete, and the nested children — turns a per-endpoint discipline into a suite that fails when somebody adds an endpoint and forgets.

:::warning
Run it against a real database. A mocked repository returns whatever the test told it to, so a mocked IDOR test asserts that your mock was configured correctly. See [Testing with a database](../nestjs-databases/testing-with-a-database.md).
:::

## Production considerations

- **Make the caller identity a required argument.** `findOneForUser(id, userId)` cannot be called incorrectly; `findOne(id)` with an ownership check inside it can be replaced by a colleague who needs "the same thing but without the check, just for this admin screen".
- **Do not add an unscoped method for internal callers.** The queue consumer and the admin tool are exactly the code paths that later get exposed through an endpoint. If an admin genuinely reads any order, that is a separate, explicitly named method with its own role guard and its own audit log entry.
- **Log denied object access.** A scoped query returning zero rows is indistinguishable from a typo once, and is an enumeration attempt when it happens four hundred times in a minute. Log the caller, the resource type and the identifier — never the record. See [Safe logging](safe-logging.md).
- **Rate-limit by subject, not only by IP.** Enumeration from a single valid token is invisible to an IP-keyed limiter behind a mobile carrier NAT. See [Rate limiting and abuse](rate-limiting.md).
- **Consider database-level enforcement for tenant data.** PostgreSQL row-level security makes the missing predicate return nothing rather than everything.
- **Audit for the shape, not for the bug.** Grep for repository calls whose `where` has a single `id` key in any service that handles owned resources. It is a fast review pass and it finds this class reliably.

## Common mistakes

- **Putting ownership in a guard.** It runs before the row is loaded and only knows the token and the raw path parameter.
- **Making the guard load the row.** Two queries, a consistency window, and a data layer in `common/guards/`.
- **Fetch-then-check instead of a scoped query.** The check is skippable, the codes leak existence, and the read can race the write.
- **Returning 403 for somebody else's object.** It confirms the object exists. Return 404.
- **Returning 404 for a role failure.** The opposite mistake: a normal user hitting `/admin/*` should get a 403, because the endpoint's existence is not the secret.
- **Checking the parent and loading the child by its own id.** Scope the child by both keys in one query.
- **Trusting foreign keys in a payload.** `addressId` and `paymentMethodId` are object-level authorization decisions too.
- **Letting `userId` be a writable DTO field.** Mass assignment and IDOR in the same request.
- **`repo.save(entityBuiltFromBody)`.** With a primary key present it is an unscoped `UPDATE`.
- **Relying on a UUID.** Unguessable is not unauthorized; ids leak.
- **Applying a CASL ability to results already loaded.** That is fetch-then-check with extra steps.
- **`@Roles('admin')` with no registered guard.** Inert metadata, open route.
- **Testing only the happy path.** Both assertions are needed: the owner gets 200, the stranger gets 404.
- **Mocking the repository in the IDOR test.** It proves the mock works.

## Related topics

- [IDOR and broken object-level authorization](../security/broken-object-level-authorization.md) — the framework-independent treatment, with more query shapes.
- [Guards](../nestjs-request-handling/guards.md) — what a guard is good for, and why it stops short of this.
- [The request lifecycle](../nestjs/request-lifecycle.md) — where guards run relative to the handler and the database.
- [Validation as a security control](validation-as-a-control.md) — the whitelist that keeps `userId` out of the body.
- [Whitelisting and unknown properties](../nestjs-validation/unknown-properties.md) — the mass-assignment half of the write-path attack.
- [Authorization](../nestjs-libraries/authorization.md) — CASL abilities and policy-based access control on top of guards.
- [Authentication](../nestjs-libraries/authentication.md) — how `request.user` gets populated in the first place.
- [OWASP API Top 10 in Nest](owasp-api-top-10.md) — API1 and API5 in the wider list.
- [SQL injection](sql-injection.md) — the other reason the `WHERE` clause deserves attention.
- [Rate limiting and abuse](rate-limiting.md) — bounding enumeration by subject.
- [Safe logging](safe-logging.md) — recording denied access without recording the data.
- [Testing with a database](../nestjs-databases/testing-with-a-database.md) — making the suite above meaningful.
- [End-to-end tests](../nestjs-testing/e2e-tests.md) — the fixture and token helpers this test assumes.
