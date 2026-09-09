---
title: API documentation
description: Generating an OpenAPI 3.1 document from Zod schemas with zod-to-openapi and serving it with swagger-ui-express, without opening a hole in your CSP or your API.
status: current
updated: 2026-09-08
---

Hand-written API documentation is wrong within a month. The fix is not discipline — it is to generate the document from the same schemas that validate requests at runtime, so the docs cannot describe a contract the code does not enforce.

## Why generated beats hand-written

A hand-maintained OpenAPI YAML file is a second source of truth. Every change needs two edits, nothing checks that they agree, and the only feedback loop is a client integrating against a spec that lies.

Generating from Zod schemas closes that loop structurally:

- The schema that rejects a bad request is the schema that produced the documented shape. They cannot drift.
- Adding a field to the validator adds it to the docs, in the same commit.
- Removing a field breaks the generation if something still references it.
- The generated document is a build artifact you can diff in CI, so a breaking change to a request body shows up as a reviewable change to the spec.

The remaining gap is descriptions and examples, which nothing can infer. Those go on the schema too, via `.openapi()` or Zod 4's `.meta()`.

## Installation

:::tabs
@tab npm
```bash
npm install @asteasolutions/zod-to-openapi@9 swagger-ui-express@5 zod@4
```
@tab pnpm
```bash
pnpm add @asteasolutions/zod-to-openapi@9 swagger-ui-express@5 zod@4
```
@tab yarn
```bash
yarn add @asteasolutions/zod-to-openapi@9 swagger-ui-express@5 zod@4
```
:::

:::deprecated
The unscoped `zod-to-openapi` package is deprecated. The maintained one is `@asteasolutions/zod-to-openapi`. Version 9 requires **Zod 4** as a peer dependency; if you are still on Zod 3, the last compatible release is 7.3.4 and it is not actively supported.
:::

## Extending Zod

`extendZodWithOpenApi(z)` adds the `.openapi()` method to every Zod schema. Call it exactly once, in a module that runs before any schema is defined.

```js title="src/openapi/zod-extend.js"
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi'
import { z } from 'zod'

extendZodWithOpenApi(z)

export { z }
```

Import `z` from that module everywhere in the project, and the ordering problem takes care of itself.

Zod 4's native `.meta()` is read too, so `z.string().meta({ id: 'Email', description: '…', example: 'a@b.test' })` produces the same result as `.openapi('Email', { … })` for the common cases. Use `.openapi()` when you need parameter-level metadata or schema extension semantics.

## Registering schemas and routes

```js title="src/openapi/registry.js"
import { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi'

export const registry = new OpenAPIRegistry()
```

```js title="src/schemas/user.js"
import { z } from '../openapi/zod-extend.js'
import { registry } from '../openapi/registry.js'

export const User = registry.register(
  'User',
  z.object({
    id: z.uuid().openapi({ example: '0f9c0a1e-2f5a-4a5f-8f5e-2c4d1a9b7e10' }),
    email: z.email().openapi({ example: 'ada@example.com' }),
    displayName: z.string().min(1).max(80),
    createdAt: z.iso.datetime(),
  }),
)

export const CreateUserBody = registry.register(
  'CreateUserBody',
  z.strictObject({
    email: z.email(),
    displayName: z.string().min(1).max(80),
  }),
)

export const ErrorResponse = registry.register(
  'ErrorResponse',
  z.object({
    error: z.string().openapi({ example: 'validation_failed' }),
    issues: z
      .array(z.object({ path: z.string(), code: z.string(), message: z.string() }))
      .optional(),
  }),
)
```

`registry.register(name, schema)` returns the same schema, so the export is still usable for validation. That is the whole trick: one object, two jobs.

```js title="src/schemas/user.js"
registry.registerPath({
  method: 'post',
  path: '/users',
  tags: ['users'],
  summary: 'Create a user',
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: CreateUserBody } },
    },
  },
  responses: {
    201: {
      description: 'The created user.',
      content: { 'application/json': { schema: User } },
    },
    400: {
      description: 'Validation failed.',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    401: { description: 'Missing or invalid token.' },
  },
})
```

`registerPath` accepts `method`, `path`, `responses` and any other OpenAPI operation field: `tags`, `summary`, `description`, `operationId`, `deprecated`, `security`. The `request` object takes `body`, `params`, `query`, `cookies` and `headers`.

:::warning
`path` here is the **OpenAPI** path, which uses `{id}`, not Express's `:id`. `/users/{id}`, not `/users/:id`. Nothing checks this for you — a mismatch produces a document that describes routes your server does not have.

Express 5 wildcards (`/*splat`, `/{*splat}`) have no OpenAPI equivalent at all. Document the concrete paths.
:::

Security schemes are not Zod schemas, so they go through `registerComponent`:

```js title="src/openapi/registry.js"
export const bearerAuth = registry.registerComponent('securitySchemes', 'bearerAuth', {
  type: 'http',
  scheme: 'bearer',
  bearerFormat: 'JWT',
})
```

## Generating the document

```js title="src/openapi/document.js"
import { OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi'
import { registry } from './registry.js'

// Importing the schema modules is what populates the registry.
import '../schemas/user.js'
import '../schemas/order.js'

export function buildOpenApiDocument() {
  const generator = new OpenApiGeneratorV31(registry.definitions)

  return generator.generateDocument({
    openapi: '3.1.0',
    info: {
      title: 'Example API',
      version: process.env.APP_VERSION ?? '1.0.0',
      description: 'Example API generated from Zod schemas.',
    },
    servers: [{ url: 'https://api.example.com' }],
  })
}
```

`OpenApiGeneratorV31` emits OpenAPI 3.1, which uses the 2020-12 JSON Schema dialect — that is why `z.string().nullable()` becomes `type: ['string', 'null']` rather than 3.0's `nullable: true`. Use 3.1 unless a downstream tool forces 3.0 (`OpenApiGeneratorV3`); there is also an `OpenApiGeneratorV32` for the 3.2 document fields.

`generateComponents()` returns just the `components` section if you are integrating with an existing hand-written document.

:::note
A Zod object generates `additionalProperties: true` by default, matching the OpenAPI spec's semantics. Using `z.strictObject()` (or a `catchall`) changes that — another reason to prefer strict objects for request bodies, since the documented contract then matches what the validator enforces.
:::

### Generate it in CI, not only at runtime

```json title="package.json"
{
  "scripts": {
    "openapi": "node scripts/write-openapi.mjs",
    "openapi:check": "node scripts/write-openapi.mjs --check"
  }
}
```

```js title="scripts/write-openapi.mjs"
import fs from 'node:fs/promises'
import { buildOpenApiDocument } from '../src/openapi/document.js'

const json = JSON.stringify(buildOpenApiDocument(), null, 2) + '\n'
const target = new URL('../openapi.json', import.meta.url)

if (process.argv.includes('--check')) {
  const current = await fs.readFile(target, 'utf8').catch(() => '')
  if (current !== json) {
    console.error('openapi.json is out of date — run `npm run openapi`')
    process.exit(1)
  }
} else {
  await fs.writeFile(target, json)
}
```

Committing the generated `openapi.json` and checking it in CI turns every contract change into a visible diff in the pull request. That is worth more than the file itself: reviewers see when a field became required or a response shape changed.

## Serving the UI

```js title="src/routes/docs.js"
import { Router } from 'express'
import swaggerUi from 'swagger-ui-express'
import { buildOpenApiDocument } from '../openapi/document.js'

const document = buildOpenApiDocument() // built once at boot
const router = Router()

// The raw document, for client generators and tooling.
router.get('/openapi.json', (req, res) => res.json(document))

router.use('/docs', swaggerUi.serve, swaggerUi.setup(document, {
  explorer: true,
  swaggerOptions: {
    persistAuthorization: false,
    tryItOutEnabled: false,
  },
}))

export default router
```

`swaggerUi.serve` is the static-asset middleware and `swaggerUi.setup(doc, options)` renders the page. If you serve more than one document from one app, use `swaggerUi.serveFiles(doc, options)` instead of the shared `serve`, or the two instances fight over the same static state.

## The CSP interaction with Helmet

Swagger UI's page contains an **inline `<style>` block** and loads its JavaScript from a separate file that `swaggerUi.serve` provides on the same origin.

Against Helmet's defaults that works: `script-src 'self'` covers the external script, and the default `style-src 'self' https: 'unsafe-inline'` covers the inline styles. If you tightened `style-src` to `'self'` — which the [Helmet page](security-headers-helmet.md) suggests you should — the docs page renders unstyled and looks broken.

Scope the exception to the docs route rather than loosening the policy for the whole application:

```js title="src/app.js"
import helmet from 'helmet'
import docsRouter from './routes/docs.js'

// Strict policy everywhere.
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: { scriptSrc: ["'self'"], styleSrc: ["'self'"], objectSrc: ["'none'"] },
    },
  }),
)

// A narrower policy, only for the documentation UI.
const docsCsp = helmet({
  contentSecurityPolicy: {
    directives: {
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:'],
      objectSrc: ["'none'"],
    },
  },
})

// docsRouter declares '/docs' and '/openapi.json' itself, so mount it at the root
// and apply the narrower CSP to the '/docs' path only.
app.use('/docs', docsCsp)
app.use(docsRouter)
```

Two things to keep in mind:

- The second `helmet()` call overwrites the CSP header for this path because it runs later. Order matters.
- Do **not** add `'unsafe-inline'` to `script-src` for this. Swagger UI does not need it with the default configuration; if you find yourself reaching for it, you have added a `customJsStr` option or similar that inlines a script, and there is a file-based alternative.

## Security considerations

**A public docs UI is a map of your attack surface.** Every endpoint, every parameter, every field name, every enum value, and every error shape, in machine-readable form. It removes the entire reconnaissance phase.

That is not automatically a reason to hide it — a genuinely public API should document itself, and obscurity is not a control. It *is* a reason to make it a deliberate decision rather than a default.

For an internal or partner API, gate it:

```js title="src/routes/docs.js"
const requireDocsAccess = (req, res, next) => {
  if (process.env.DOCS_PUBLIC === 'true') return next()
  if (!req.user) return res.status(404).end() // 404, not 401 — do not confirm it exists
  next()
}

router.use('/docs', requireDocsAccess, swaggerUi.serve, swaggerUi.setup(document))
```

Serving a 404 rather than a 401 avoids confirming that a docs UI exists at that path at all.

**Disable "Try it out" on a document that points at production.** `tryItOutEnabled: false` stops the UI from firing real requests. Otherwise anyone reading the docs can `DELETE /users/{id}` from the browser, with whatever credentials they paste in.

**`persistAuthorization: true` stores entered credentials in the browser's local storage.** Convenient for a developer, and a place where a real API token now lives in plaintext on a shared machine. Leave it off unless the docs are strictly a local development tool.

**Do not document internal endpoints.** Admin routes, debug endpoints, and internal service APIs should not be in the registry that generates the public document. Keep two registries if you need two audiences.

**Examples are published data.** An `.openapi({ example: … })` with a real customer email, a real API key, or a real internal ID ships to everyone who reads the docs. Use obviously synthetic values.

**The docs are not the authorization boundary.** Hiding an endpoint from the document does nothing to protect it. Every route needs its own authentication and authorization regardless of what the spec says — see [IDOR and broken object-level authorization](../security/broken-object-level-authorization.md).

**Rate limit the docs route.** It serves a comparatively large payload and is a cheap target for a bandwidth attack.

**Pin `swagger-ui-dist`.** `swagger-ui-express` pulls the UI assets from `swagger-ui-dist`, so the exact UI version comes from your lockfile. Keep the lockfile committed and audited — see [Dependency auditing](../security/dependency-auditing.md).

## Production considerations

**Build the document once at boot,** not per request. Generation walks every schema; doing it on each `/openapi.json` request is pure waste on a route that returns identical bytes every time.

**Serve `openapi.json` separately from the UI.** Client generators, contract tests and Postman want the JSON, not an HTML page. Some deployments serve the JSON publicly and gate only the UI.

**Version the document with the deploy.** Put the git SHA or release version in `info.version` so a client can tell which build they are looking at.

**Keep the servers list accurate per environment.** A `servers` entry pointing at production inside the staging docs means someone will "try it out" against production.

**Check the generated file in CI.** `npm run openapi:check` fails the build when the committed document does not match the schemas, which is how you notice an accidental contract change during review rather than after release.

**Consider skipping the UI in production entirely** and shipping the JSON only, with the UI available in staging or via a local `npx` command. That removes an HTML surface, a CSP exception and a set of third-party assets from your production image.

**Cache the JSON.** It changes only on deploy, so a long `Cache-Control` with the version in the ETag is safe and cheap.

**Watch the payload size.** A large API generates a document measured in hundreds of kilobytes. Compress it — see [Compression](compression.md) — and do not put it behind a route with an aggressive body-size limit on the response path.

## Common mistakes

- **Calling `extendZodWithOpenApi` after schemas are defined,** or in more than one place with different `z` instances. The `.openapi()` method is missing and nothing explains why.
- **Using the deprecated unscoped `zod-to-openapi`.**
- **Writing Express paths in `registerPath`.** `/users/:id` must be `/users/{id}`.
- **Forgetting to import the schema modules** in the document builder, producing an empty `paths` section.
- **Regenerating the document on every request.**
- **Leaving "Try it out" enabled against production.**
- **`persistAuthorization: true`,** putting real tokens in local storage.
- **Loosening the global CSP to make Swagger UI render** instead of scoping the exception to `/docs`.
- **Adding `'unsafe-inline'` to `script-src` for the docs.** Not required, and it disarms the policy.
- **Publishing internal or admin endpoints** in the same document as the public API.
- **Real data in examples.**
- **Treating an undocumented endpoint as a protected one.**
- **Not checking the generated document in CI,** so contract changes ship unreviewed.

## Related topics

- [Validation](validation.md) — the Zod schemas this page turns into documentation.
- [Security headers with Helmet](security-headers-helmet.md) — the CSP the docs UI collides with.
- [Testing](testing.md) — contract tests that assert the API matches the generated document.
- [Continuous integration](../production/ci.md) — where the `openapi:check` step belongs.
- [Dependency auditing](../security/dependency-auditing.md) — keeping the bundled UI assets current.
- [Compression](compression.md) — serving a large JSON document efficiently.
