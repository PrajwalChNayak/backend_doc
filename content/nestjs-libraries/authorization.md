---
title: Authorization
description: Role guards with SetMetadata and Reflector, a typed @Roles() decorator, and attribute-based rules with @casl/ability 7.0.1 — plus why object-level checks never belong in a guard.
status: current
updated: 2026-09-11
---

Authorization answers "may this principal do this thing to this resource". Nest gives you a clean place for the first two thirds of that question — the guard — and no place at all for the third. Getting the split right is the difference between an access-control system and a decoration.

## The two halves, and why they live in different places

| Question | Answer at | Knows about |
| --- | --- | --- |
| May an *admin* call `DELETE /invoices/:id` at all? | a guard | the token, the route, route metadata |
| May *this* admin delete *invoice 4711*? | the service or the query | the loaded row, the tenant, the owner |

A guard runs before the resource is loaded. It sees `request.params.id` — a string the caller chose — and nothing else. It is structurally incapable of answering the second question, and a guard that tries either fetches the row itself (so the handler fetches it again, and the two can disagree under concurrent writes) or checks nothing while looking like it does.

```ts vulnerable title="DO NOT COPY — this guard authorizes nothing"
@Injectable()
export class InvoiceOwnerGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest()
    // There is no invoice here. Only a string the caller typed.
    return typeof request.params.id === 'string'
  }
}
```

The correct shape pushes the ownership predicate into the read itself, so there is no window between "load" and "check":

```ts good title="src/invoices/invoices.service.ts"
import { Injectable, NotFoundException } from '@nestjs/common'
import { InvoiceRepository } from './invoice.repository.js'

@Injectable()
export class InvoicesService {
  private readonly repo: InvoiceRepository

  constructor(repo: InvoiceRepository) {
    this.repo = repo
  }

  async findOneFor(actor: { id: string; tenantId: string }, invoiceId: string) {
    const invoice = await this.repo.findScoped(invoiceId, actor.tenantId)
    if (!invoice || invoice.ownerId !== actor.id) {
      // 404, not 403: a 403 confirms the invoice exists.
      throw new NotFoundException('Invoice not found', { errorCode: 'INVOICE_NOT_FOUND' })
    }
    return invoice
  }
}
```

```ts title="src/invoices/invoice.repository.ts"
// The tenant is part of the WHERE clause, not a post-hoc comparison.
findScoped(id: string, tenantId: string) {
  return this.pool.query('SELECT * FROM invoices WHERE id = $1 AND tenant_id = $2', [id, tenantId])
}
```

**Guards decide what a user may attempt; services decide what a user may touch.** Everything below is about the first half. The second half — including why the response should be 404 rather than 403, and how a missing tenant predicate becomes a cross-tenant data leak — is [Authorization and IDOR](../nestjs-security/authorization-and-idor.md), and [Guards](../nestjs-request-handling/guards.md) covers the mechanics of the guard stage itself.

## Role-based access with `SetMetadata` and `Reflector`

The smallest thing that works, and the right default for a handful of coarse roles.

```ts title="src/auth/decorators/roles.decorator.ts"
import { SetMetadata } from '@nestjs/common'

export const ROLES_KEY = 'roles'

export type Role = 'viewer' | 'editor' | 'admin'

export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles)
```

Typing the argument as a union rather than `string[]` is the cheapest win on this page: `@Roles('adminn')` becomes a compile error instead of a route nobody can reach.

```ts title="src/auth/guards/roles.guard.ts"
import { ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common'
import type { CanActivate, ExecutionContext } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { ROLES_KEY } from '../decorators/roles.decorator.js'
import type { Role } from '../decorators/roles.decorator.js'

@Injectable()
export class RolesGuard implements CanActivate {
  private readonly reflector: Reflector

  constructor(reflector: Reflector) {
    this.reflector = reflector
  }

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ])

    if (!required || required.length === 0) return true

    const { user } = context.switchToHttp().getRequest()
    if (!user) {
      throw new UnauthorizedException('Not authenticated', { errorCode: 'NOT_AUTHENTICATED' })
    }

    const granted = required.some((role) => user.roles?.includes(role))
    if (!granted) {
      throw new ForbiddenException('Insufficient role', { errorCode: 'INSUFFICIENT_ROLE' })
    }
    return true
  }
}
```

```ts title="src/invoices/invoices.controller.ts"
import { Controller, Delete, Get, Param, UseGuards } from '@nestjs/common'
import { RolesGuard } from '../auth/guards/roles.guard.js'
import { Roles } from '../auth/decorators/roles.decorator.js'

@Controller('invoices')
@UseGuards(RolesGuard)
@Roles('viewer')
export class InvoicesController {
  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.invoices.findOneFor(this.actor, id)
  }

  @Delete(':id')
  @Roles('admin')
  remove(@Param('id') id: string) {
    return this.invoices.remove(this.actor, id)
  }
}
```

### `getAllAndOverride` versus `getAllAndMerge`

The array order is the precedence order, and **the first target with a defined value wins**. `[getHandler(), getClass()]` therefore means the method-level `@Roles('admin')` above *replaces* the controller-level `@Roles('viewer')` rather than adding to it.

| Method | Result for controller `['viewer']` + method `['admin']` |
| --- | --- |
| `getAllAndOverride` | `['admin']` — narrower, which is what you want |
| `getAllAndMerge` | `['viewer', 'admin']` — a viewer can now delete |

Choosing the wrong one is a silent privilege bug in whichever direction you picked. Use `getAllAndOverride` unless you have a specific reason to accumulate.

:::warning
`RolesGuard` reads `request.user`, so an authentication guard must have run first. With `APP_GUARD` providers that means declaration order: authentication first, authorization second. The guard above throws `UnauthorizedException` when `user` is missing precisely so the ordering bug surfaces as a 401 rather than as "everything is forbidden".
:::

### A typed decorator without a string key

`Reflector.createDecorator()` builds the decorator and the metadata key together, so the read-back is typed with no generic:

```ts title="src/auth/decorators/roles.decorator.ts"
import { Reflector } from '@nestjs/core'

export type Role = 'viewer' | 'editor' | 'admin'

export const Roles = Reflector.createDecorator<Role[]>({ key: 'roles' })
```

```ts
const required = this.reflector.getAllAndOverride(Roles, [context.getHandler(), context.getClass()])
```

Pass `{ key: 'roles' }` when anything outside your code reads the raw key — an OpenAPI plugin, an introspection tool, a CI audit script. Without it `createDecorator()` generates a random key, which is fine when the key is nobody else's business.

## Permissions instead of roles

Roles stop scaling at about the point somebody asks for "an editor who can also export". The fix is not more roles; it is to check **permissions** at the route and resolve roles to permissions once.

```ts title="src/auth/permissions.ts"
export const PERMISSIONS = [
  'invoice:read',
  'invoice:write',
  'invoice:delete',
  'report:export',
] as const

export type Permission = (typeof PERMISSIONS)[number]

export const ROLE_PERMISSIONS: Record<string, readonly Permission[]> = {
  viewer: ['invoice:read'],
  editor: ['invoice:read', 'invoice:write', 'report:export'],
  admin: ['invoice:read', 'invoice:write', 'invoice:delete', 'report:export'],
}
```

Routes then declare `@RequirePermissions('invoice:delete')`, and adding "an editor who can also export" is one line in the table rather than a new role threaded through forty controllers. The guard is the same shape as `RolesGuard`, reading a different key.

## Attribute-based rules with CASL

Roles and permissions are per-route. The moment a rule depends on the *resource* — "an editor may update an invoice, but only a draft one, and only in their own tenant" — you want conditions, and that is what `@casl/ability` **7.0.1** is for.

:::warning
Install the **scoped** package. The unscoped `casl` package on npm is deprecated with the notice that it was split into separate packages. `@casl/ability` is the one that is maintained.
:::

```bash
npm install @casl/ability@7.0.1
```

### Defining an ability

```ts title="src/auth/ability.factory.ts"
import { Injectable } from '@nestjs/common'
import { AbilityBuilder, createMongoAbility } from '@casl/ability'
import type { MongoAbility } from '@casl/ability'
import type { AuthenticatedUser } from './auth.types.js'

export type Action = 'manage' | 'create' | 'read' | 'update' | 'delete'
export type Subject = 'Invoice' | 'Report' | 'User' | 'all'
export type AppAbility = MongoAbility<[Action, Subject]>

@Injectable()
export class AbilityFactory {
  createForUser(user: AuthenticatedUser): AppAbility {
    const { can, cannot, build } = new AbilityBuilder<AppAbility>(createMongoAbility)

    if (user.roles.includes('admin')) {
      can('manage', 'all', { tenantId: user.tenantId })
    } else {
      can('read', 'Invoice', { tenantId: user.tenantId })
      can('update', 'Invoice', { tenantId: user.tenantId, status: 'draft' })
      can('create', 'Invoice', { tenantId: user.tenantId })
      cannot('delete', 'Invoice').because('Only an administrator can delete an invoice')
    }

    return build()
  }
}
```

`createMongoAbility` gives you the MongoDB-query conditions matcher, which is what makes `{ tenantId: user.tenantId, status: 'draft' }` a rule rather than a comment. `'manage'` and `'all'` are CASL's built-in wildcards for *any action* and *any subject*.

### Checking a rule

```ts title="src/invoices/invoices.service.ts"
import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common'
import { subject } from '@casl/ability'
import { AbilityFactory } from '../auth/ability.factory.js'
import { InvoiceRepository } from './invoice.repository.js'
import type { AuthenticatedUser } from '../auth/auth.types.js'

@Injectable()
export class InvoicesService {
  private readonly abilities: AbilityFactory
  private readonly repo: InvoiceRepository

  constructor(abilities: AbilityFactory, repo: InvoiceRepository) {
    this.abilities = abilities
    this.repo = repo
  }

  async update(actor: AuthenticatedUser, id: string, patch: Record<string, unknown>) {
    const invoice = await this.repo.findScoped(id, actor.tenantId)
    if (!invoice) {
      throw new NotFoundException('Invoice not found', { errorCode: 'INVOICE_NOT_FOUND' })
    }

    const ability = this.abilities.createForUser(actor)
    if (!ability.can('update', subject('Invoice', invoice))) {
      throw new ForbiddenException('Cannot update this invoice', { errorCode: 'INVOICE_NOT_UPDATABLE' })
    }

    return this.repo.update(id, patch)
  }
}
```

The `subject('Invoice', invoice)` call is not optional ceremony. CASL has to know which subject type a plain object is, and a POJO from a database driver carries no class. Pass a bare object and every conditional rule silently fails to match — a check that always says "no", or worse, one that matches a `'all'` rule and always says "yes".

Note where the check lives: **in the service, after the row is loaded**. That is the same rule as the top of this page. CASL does not change it; it just gives you a language for expressing the condition.

### A guard for the route-level half

CASL is still useful at the route level for the coarse check, which lets you reject before the handler allocates anything:

```ts title="src/auth/guards/policies.guard.ts"
import { ForbiddenException, Injectable, SetMetadata } from '@nestjs/common'
import type { CanActivate, ExecutionContext } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { AbilityFactory } from '../ability.factory.js'
import type { Action, Subject } from '../ability.factory.js'

export const POLICY_KEY = 'policy'

export const CheckPolicy = (action: Action, subject: Subject) =>
  SetMetadata(POLICY_KEY, { action, subject })

@Injectable()
export class PoliciesGuard implements CanActivate {
  private readonly reflector: Reflector
  private readonly abilities: AbilityFactory

  constructor(reflector: Reflector, abilities: AbilityFactory) {
    this.reflector = reflector
    this.abilities = abilities
  }

  canActivate(context: ExecutionContext): boolean {
    const policy = this.reflector.getAllAndOverride<{ action: Action; subject: Subject } | undefined>(
      POLICY_KEY,
      [context.getHandler(), context.getClass()],
    )
    if (!policy) return true

    const { user } = context.switchToHttp().getRequest()
    const ability = this.abilities.createForUser(user)

    // Subject TYPE only — there is no instance here, by design.
    if (!ability.can(policy.action, policy.subject)) {
      throw new ForbiddenException('Not permitted', { errorCode: 'NOT_PERMITTED' })
    }
    return true
  }
}
```

Checking against the subject *type* (`'Invoice'`) rather than an instance is exactly right for a guard: it asks "could this user ever update any invoice", which is answerable without loading one. CASL evaluates a type-only check as "is there at least one matching rule", so a user with no update rule at all is rejected here and a user with a conditional rule falls through to the service check.

### Filtering lists

An ability tells you whether a *given* row is allowed. A list endpoint needs the inverse — the query that returns only allowed rows — and CASL does not do that on its own. The `@casl/ability/extra` entry point ships these helpers, and none of them is a query builder:

| Export | What it does |
| --- | --- |
| `packRules` / `unpackRules` | compress a rule set, for sending it to a client |
| `permittedFieldsOf` | which fields of a subject an action may touch |
| `rulesToFields` | default field values implied by the rules |
| `rulesToAST` | the matching rules as a condition tree |
| `rulesToCondition` | fold those rules into one conditions object |

Translating rules into a database query is the job of a separate ORM adapter package, and the translation is inherently lossy: a rule the adapter cannot express is dropped from the filter rather than failing loudly, which turns an authorization rule into a no-op. For a list endpoint, write the predicate yourself — `WHERE tenant_id = $1 AND owner_id = $2` is something a reviewer can check, and it is the same predicate the single-row read already uses.

## Choosing between the three

| | Roles | Permissions | CASL |
| --- | --- | --- | --- |
| Rule lives in | a decorator | a decorator plus one table | a factory function |
| Depends on the resource | no | no | yes |
| Good for | 2–4 coarse roles | many routes, few actors | ownership, tenancy, state machines |
| Cost | none | one lookup table | a dependency and a mental model |
| Guard can enforce it fully | yes | yes | only the type-level half |

Start with roles. Move to permissions when the role list grows a suffix. Add CASL when the answer genuinely depends on the row — and keep the row-level check in the service either way.

## Security considerations

**A guard never authorizes an object.** It runs before the row exists. Every ownership and tenancy check belongs in the service or, better, in the `WHERE` clause.

**Return 404 for a resource the caller may not see.** A 403 confirms the id exists, which is an enumeration oracle across tenants. Reserve 403 for "you are authenticated, the thing exists, and you may not do this" — for example a viewer hitting a delete route.

**Fail closed.** Missing metadata should mean "no special requirement", but missing *user* must mean rejection. A guard that reads `user.roles?.includes(...)` on an undefined `user` returns `false` — which is the safe direction, but only by accident. Throw explicitly.

**Order the global guards.** Authentication before authorization. Reversed, the authorization guard reads an empty `request.user` on every request.

**Do not trust role claims that came from the client.** A `roles` array in a JWT is only as fresh as the token. Re-read from the database for anything destructive, or use a token version — see [Authentication](authentication.md).

**`getAllAndMerge` where you meant `getAllAndOverride`** widens access silently. There is no error and no log line.

**Audit `@Public()` and any other opt-out.** One forgotten decorator is an open endpoint that works perfectly for everyone.

**Log authorization denials** with the actor, the action and the resource id — they are the signal that somebody is probing. Never log the resource body. See [Safe logging](../nestjs-security/safe-logging.md).

**Mass assignment is an authorization bug.** A `PATCH` that accepts `{ "role": "admin" }` bypasses every guard on this page. Whitelist the payload — see [Whitelisting and unknown properties](../nestjs-validation/unknown-properties.md).

## Production considerations

**Building an ability per request costs something.** `AbilityFactory.createForUser` allocates a rule set on every call. For a request that checks several times, build it once and hang it on the request — a request-scoped provider, or a property set by the authentication guard.

**Permission tables belong in code, not in the database, until they do not.** A constant map deploys atomically with the routes that use it. A database-backed permission table needs caching, cache invalidation, and a plan for what happens when the lookup fails — and "fail open" is never the answer.

**Changing a role must take effect quickly.** If roles come from the token, a demotion is invisible until `exp`. Decide the acceptable staleness deliberately and document it; fifteen minutes of residual admin is a real risk in some systems and irrelevant in others.

**Test the negative cases.** Authorization tests that only assert "an admin can" prove nothing. Assert that an editor *cannot* delete, that tenant A cannot read tenant B, and that an unauthenticated request gets a 401 — see [Testing guards, pipes and interceptors](../nestjs-testing/testing-the-pipeline.md).

**Guards run on every request to the route, including ones a later guard rejects.** Keep the expensive work out of them; a database round trip per guard per request adds up quickly.

**Make the authorization model reviewable.** One file that lists roles, permissions and the mapping between them is something a security reviewer can read in five minutes. The same rules scattered across decorators are not.

## Common mistakes

- **Doing ownership checks in a guard.** It has the path parameter, not the row.
- **Returning 403 where 404 is correct.** Confirms existence across a tenant boundary.
- **`getAllAndMerge` instead of `getAllAndOverride`.** A method-level `@Roles('viewer')` then adds to the controller's `@Roles('admin')` rather than narrowing it.
- **Registering `RolesGuard` before the authentication guard.** `request.user` is undefined and every request is forbidden — or, with a `?.` chain, silently allowed if the roles list is empty.
- **`@UseGuards(new RolesGuard())`.** An instance bypasses the container, so `Reflector` is never injected.
- **Passing a plain object to `ability.can()`.** Without `subject()`, CASL cannot detect the subject type and conditional rules do not match.
- **Installing the unscoped `casl` package.** It is deprecated on npm; use `@casl/ability`.
- **Typing `@Roles(...roles: string[])`.** A typo becomes an unreachable route instead of a compile error.
- **Trusting a `roles` claim indefinitely.** A revoked role stays live until the token expires.
- **Building the ability once at startup.** Rules depend on the user; a cached global ability authorizes everyone as whoever logged in first.
- **Treating `cannot()` as a comment.** It is a real rule and it overrides a preceding `can()` — order matters in `AbilityBuilder`.
- **No negative tests.** The suite passes while every user can delete everything.
- **Forgetting that a whitelisting failure defeats all of this.** An unvalidated `role` field in a request body is a privilege escalation no guard sees.

## Related topics

- [Guards](../nestjs-request-handling/guards.md) — the pipeline stage, binding scopes, and why `return false` is always 403.
- [Authorization and IDOR](../nestjs-security/authorization-and-idor.md) — the object-level half, with a working exploit and the 404-versus-403 argument.
- [Authentication](authentication.md) — establishing the principal these rules apply to.
- [Custom decorators](../nestjs-request-handling/custom-decorators.md) — `applyDecorators()` for guard-plus-metadata combinations and `@CurrentUser()`.
- [Whitelisting and unknown properties](../nestjs-validation/unknown-properties.md) — stopping mass assignment from bypassing every rule here.
- [Testing guards, pipes and interceptors](../nestjs-testing/testing-the-pipeline.md) — exercising the negative cases.
- [Safe logging](../nestjs-security/safe-logging.md) — what an authorization denial should and should not record.
- [OWASP API Top 10 in Nest](../nestjs-security/owasp-api-top-10.md) — broken object-level and function-level authorization in context.
- [IDOR and broken object-level authorization](../security/broken-object-level-authorization.md) — the framework-independent version.
