---
title: OpenAPI with Swagger
description: Generating an OpenAPI document with @nestjs/swagger 12.0.1 — DocumentBuilder, SwaggerModule.setup, the @Api* decorators, the CLI plugin that infers types from DTOs, and why the UI does not belong in production.
status: current
updated: 2026-09-11
---

`@nestjs/swagger` is **12.0.1**. It reads the metadata your controllers and DTOs already carry, builds an OpenAPI document from it, and optionally serves Swagger UI over it. The value is not the pretty page — it is that the specification is derived from the code, so it cannot drift.

## Why it exists

A hand-written OpenAPI file is a second source of truth. It is correct on the day it is written and wrong within a month, because nothing fails when a route changes and the YAML does not.

Deriving the document from decorators means the two move together. It also means the document is only as good as the metadata: TypeScript types are erased at runtime, so a DTO with no `@ApiProperty` produces an empty schema unless you turn the CLI plugin on. That trade-off is the whole page.

```bash
npm install @nestjs/swagger@12.0.1
```

`@nestjs/swagger` 12.0.1 peers on `@nestjs/common` and `@nestjs/core` `^12.0.0`, plus `class-validator` and `class-transformer`, and declares `engines: ^20.19.0 || >=22.12.0`. It bundles `swagger-ui-dist` 5.32.14, so you do not install the UI separately.

## Building and serving the document

```ts title="src/main.ts"
import { NestFactory } from '@nestjs/core'
import { ConfigService } from '@nestjs/config'
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger'
import { AppModule } from './app.module.js'

async function bootstrap() {
  const app = await NestFactory.create(AppModule)
  const config = app.get(ConfigService)

  app.setGlobalPrefix('api')

  if (config.get('ENABLE_API_DOCS') === 'true') {
    const documentConfig = new DocumentBuilder()
      .setTitle('Billing API')
      .setDescription('Invoices, payments and reporting.')
      .setVersion('2.4.0')
      .addServer('https://api.example.com', 'production')
      .addBearerAuth(
        { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        'access-token',
      )
      .addTag('invoices', 'Creating, reading and voiding invoices')
      .build()

    const document = () => SwaggerModule.createDocument(app, documentConfig, {
      operationIdFactory: (controllerKey, methodKey) => `${controllerKey}_${methodKey}`,
    })

    SwaggerModule.setup('docs', app, document, {
      jsonDocumentUrl: 'docs/openapi.json',
      yamlDocumentUrl: 'docs/openapi.yaml',
      customSiteTitle: 'Billing API',
      swaggerOptions: { persistAuthorization: true },
    })
  }

  await app.listen(config.getOrThrow<number>('PORT'))
}

bootstrap()
```

`DocumentBuilder` is a fluent builder for everything that is not derived from a route: title, description, version, servers, tags, contact, license, and the security schemes. `build()` returns the document minus its `paths`; `SwaggerModule.createDocument()` fills those in by walking the application's routes.

Passing a **factory** to `setup()` rather than an already-built document defers the work until the first request to `/docs`, which keeps it off the boot path.

`setGlobalPrefix('api')` and Swagger interact through two separate options, and they default in opposite directions:

| Option | Lives on | Default | Effect |
| --- | --- | --- | --- |
| `ignoreGlobalPrefix` | `SwaggerDocumentOptions` (`createDocument`) | `false` | `false` keeps the prefix on the operation paths; `true` strips it |
| `useGlobalPrefix` | `SwaggerCustomOptions` (`setup`) | falsy | serve the docs route itself under the prefix |

So out of the box the documented paths carry `/api` and the UI does not. Check one path by hand after wiring it up — the failure mode is a document in which every "Try it out" 404s, and nothing warns you.

### `SwaggerModule.setup` options worth knowing

| Option | Effect |
| --- | --- |
| `ui` | serve Swagger UI at the path; set `false` for a spec-only deployment |
| `raw` | `true`, `false`, or an array of `'json'` / `'yaml'` — which raw documents are served |
| `jsonDocumentUrl` / `yamlDocumentUrl` | where the raw spec lives; default `<path>-json` and `<path>-yaml` |
| `useGlobalPrefix` | serve the docs under the application's global prefix |
| `swaggerOptions` | passed to Swagger UI itself — `persistAuthorization`, `tagsSorter`, `docExpansion` |
| `customSiteTitle`, `customCss`, `customfavIcon` | branding |
| `patchDocumentOnRequest` | rewrite the document per request, e.g. per-tenant server URLs |

`ui: false` with `raw: ['json']` is the right shape for a CI job that pulls the spec to run contract tests, or for an internal gateway that renders documentation itself.

## Annotating responses and payloads

Routes get documented from their decorators; everything a route can *return* has to be declared, because Nest cannot infer a union of status codes from a method body.

```ts title="src/invoices/invoices.controller.ts"
import { Body, Controller, Get, Param, Post } from '@nestjs/common'
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger'
import { InvoiceDto } from './dto/invoice.dto.js'
import { CreateInvoiceDto } from './dto/create-invoice.dto.js'

@ApiTags('invoices')
@ApiBearerAuth('access-token')
@Controller('invoices')
export class InvoicesController {
  @Get(':id')
  @ApiOperation({ summary: 'Fetch one invoice', description: 'Scoped to the calling tenant.' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: InvoiceDto })
  @ApiNotFoundResponse({ description: 'No such invoice in this tenant.' })
  findOne(@Param('id') id: string): Promise<InvoiceDto> {
    return this.invoices.findOne(id)
  }

  @Post()
  @ApiCreatedResponse({ type: InvoiceDto })
  create(@Body() body: CreateInvoiceDto): Promise<InvoiceDto> {
    return this.invoices.create(body)
  }
}
```

`@ApiBearerAuth('access-token')` references the name given to `addBearerAuth(...)` in the builder. If the names do not match, the "Authorize" button appears and does nothing — silently.

`ApiResponse` is the general form (`@ApiResponse({ status: 409, description: '…' })`); the package also exports a named shortcut for essentially every HTTP status — `ApiOkResponse`, `ApiCreatedResponse`, `ApiBadRequestResponse`, `ApiUnauthorizedResponse`, `ApiForbiddenResponse`, `ApiNotFoundResponse`, `ApiConflictResponse`, `ApiTooManyRequestsResponse`, and the rest.

`DocumentBuilder.addGlobalResponse(...)` declares the ones every route shares, so `401` and `429` are stated once rather than on two hundred handlers.

### DTOs

```ts title="src/invoices/dto/create-invoice.dto.ts"
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'
import { IsISO8601, IsInt, IsOptional, IsString, Min } from 'class-validator'

export class CreateInvoiceDto {
  @ApiProperty({ example: 'ACME Corp', maxLength: 200 })
  @IsString()
  customerName!: string

  @ApiProperty({ description: 'Amount in minor units.', minimum: 1, example: 12500 })
  @IsInt()
  @Min(1)
  amountMinor!: number

  @ApiPropertyOptional({ format: 'date', example: '2026-10-01' })
  @IsOptional()
  @IsISO8601()
  dueDate?: string
}
```

`@ApiProperty` carries the schema: `type`, `format`, `example`, `enum`, `minimum`, `maxLength`, `isArray`, `nullable`, `deprecated`. `@ApiPropertyOptional` is the same thing with `required: false`. `@ApiHideProperty` removes a field from the schema — use it for anything internal that happens to live on a response class.

:::warning
`@ApiProperty()` on a response DTO is documentation, not enforcement. It does not filter the object you return. A field you forgot to exclude is still serialized to the client even though the schema does not mention it. Shaping the response is [Serialization](../nestjs-validation/serialization.md)'s job, and it is a security control, not a cosmetic one.
:::

## The CLI plugin

Writing `@ApiProperty()` on every field is tedious and, worse, forgettable — and a forgotten one produces a silently incomplete schema. The plugin reads the TypeScript AST at build time and generates the metadata from the types themselves.

```json title="nest-cli.json"
{
  "$schema": "https://json.schemastore.org/nest-cli",
  "collection": "@nestjs/schematics",
  "sourceRoot": "src",
  "compilerOptions": {
    "deleteOutDir": true,
    "plugins": [
      {
        "name": "@nestjs/swagger",
        "options": {
          "dtoFileNameSuffix": [".dto.ts", ".entity.ts"],
          "controllerFileNameSuffix": [".controller.ts"],
          "classValidatorShim": true,
          "introspectComments": true
        }
      }
    ]
  }
}
```

What it derives, and from what:

| Generated | Source |
| --- | --- |
| property `type` and `isArray` | the TypeScript type annotation |
| `required: false` | a `?` on the property |
| `default` | a property initializer |
| `enum` | a TypeScript `enum` type |
| `minimum`, `maxLength`, `format`, … | `class-validator` decorators, when `classValidatorShim` is on |
| operation `summary` and property `description` | JSDoc comments, when `introspectComments` is on |

| Option | Default | Notes |
| --- | --- | --- |
| `dtoFileNameSuffix` | `['.dto.ts', '.entity.ts']` | files the plugin treats as DTOs |
| `controllerFileNameSuffix` | `['.controller.ts']` | same for controllers |
| `classValidatorShim` | `true` | translate `class-validator` rules into schema constraints |
| `classTransformerShim` | `false` | honour `@Exclude` / `@Expose`; `'exclusive'` respects an `@Exclude()` on the class |
| `introspectComments` | `false` | JSDoc becomes descriptions |
| `dtoKeyOfComment` / `controllerKeyOfComment` | `'description'` / `'description'` | which schema key a comment fills |
| `parameterProperties` | | include constructor parameter properties |
| `skipAutoHttpCode` | | do not infer the success status code |
| `skipDefaultValues` | | do not emit `default` from initializers |
| `autoFillEnumName` | | derive `enumName` from the enum's type name |

:::warning The plugin needs the Nest compiler
The plugin runs as a TypeScript transformer that `nest build` and `nest start` install. A build that invokes `tsc` directly, or an ESM project bundling with a different tool, does not run it — and the symptom is a document full of empty schemas rather than an error.

For those builds, `SwaggerModule.loadPluginMetadata()` loads a metadata file the plugin emitted earlier. If you cannot run the plugin at all, write `@ApiProperty()` by hand and accept the tedium. The Nest 12 CLI is **12.0.0** and needs Node **22.12+** (via `@nestjs/schematics@12`) even though the app itself runs on Node 20.19+; see [Installation and the CLI](../nestjs/installation-and-cli.md).
:::

Explicit `@ApiProperty()` always wins over the plugin's inference, so you can let it do the boring 90% and override the interesting parts.

## Security considerations

**Do not serve the UI in production by default.** The document is a complete map of your attack surface: every route, every parameter, every field name, and the exact shape of a valid payload. Handing that to an anonymous visitor saves an attacker the entire reconnaissance phase.

The switch belongs in validated configuration, defaulting to off:

```ts title="src/main.ts"
const docsEnabled =
  config.get('NODE_ENV') !== 'production' || config.get('ENABLE_API_DOCS') === 'true'

if (docsEnabled) {
  SwaggerModule.setup('docs', app, documentFactory)
}
```

If you do need it in production — a public API where the docs *are* the product — then publish deliberately: put it behind authentication or an allow-list, serve it from a separate path, and make sure it exposes only routes intended for external callers.

**`@ApiExcludeEndpoint()` and `@ApiExcludeController()` hide a route from the document. They do not protect it.** Hiding an admin route is not access control; it is only a reduction in how easily it is found. The guard is what protects it — see [Authorization](authorization.md).

**Examples end up in the document verbatim.** A realistic `@ApiProperty({ example: '…' })` containing a real customer name, a real token, or a real internal identifier is now public. Use obviously synthetic values.

**A `500` response description must not carry internals.** "Database connection to pg-primary-3 refused" in an example is an infrastructure map.

**`persistAuthorization: true` stores the token the user pasted in browser storage.** Convenient on a developer machine, a liability on a shared one. Do not set it for a publicly reachable UI.

**The "Try it out" button issues real requests against whatever `addServer()` names.** If the only server listed is production, somebody reading the docs will eventually `DELETE` something real. List the sandbox server first, or omit production entirely.

**Swagger UI is a bundled third-party asset** — `swagger-ui-dist` 5.32.15 here. It is another dependency in the audit surface of a route you are exposing. See [Dependency auditing](../nestjs-security/dependency-auditing.md).

**The document leaks even without the UI.** `jsonDocumentUrl` is the same information in a more convenient form. Gate the whole feature, not just the HTML page.

## Production considerations

**Build the document lazily.** Passing the factory to `setup()` means the route scan happens on first request rather than at boot, which keeps startup fast on a large application.

**Emit the spec in CI and diff it.** A build step that writes `openapi.json` and fails the pipeline on an unreviewed change gives you a contract review for free, and it catches an accidentally exposed route before deployment does.

**Version the document with the deployment.** `setVersion()` should read your release version, not a literal somebody updates by hand. Consumers use it to know what they are looking at.

**`operationIdFactory` stabilizes client generation.** Generated SDKs name methods after `operationId`; the default derives it from the controller and method, so renaming a method renames somebody's generated client function. Pin the factory and be deliberate about renames.

**Swagger and [versioning](../nestjs-request-handling/versioning.md) interact.** With URI versioning, each version produces its own paths in one document. If your consumers want one document per version, build several with `include` restricted to the relevant modules.

**Serving the UI costs memory.** `swagger-ui-dist` is several megabytes of static assets. On a small container, that is worth knowing before you enable it everywhere.

**Keep the docs route out of the access log and the rate limiter's way.** It is noisy and it is not an API call — see [Logging](logging.md) and [Rate limiting with Throttler](throttler.md).

## Common mistakes

- **Serving `/docs` publicly in production without deciding to.** The complete attack surface, documented, for free.
- **Gating the UI but not `jsonDocumentUrl`.** The raw spec is the same leak.
- **Expecting the plugin to run under a plain `tsc` build.** It is a Nest CLI transformer; without it every schema is empty and nothing errors.
- **A DTO with no `@ApiProperty` and no plugin.** The schema is `{}` and the documentation is worthless.
- **`@ApiBearerAuth('x')` with no matching `addBearerAuth(..., 'x')`.** The Authorize button does nothing and says nothing.
- **Treating `@ApiProperty` as serialization.** It documents the shape; it does not filter the response.
- **`@ApiExcludeEndpoint()` as access control.** Hidden is not protected.
- **Real data in `example` values.** Customer names, tokens and internal ids, published.
- **Listing only the production server.** Somebody will press "Try it out" on a destructive route.
- **`persistAuthorization: true` on a public UI.** Tokens left in browser storage.
- **Forgetting that `setGlobalPrefix` and the document's paths are configured separately.** A document in which every path 404s.
- **Never regenerating the spec in CI.** The drift you moved to decorators to avoid comes back through the copy somebody committed.

## Related topics

- [DTOs](../nestjs-request-handling/dtos.md) — the classes the schema is derived from.
- [class-validator and class-transformer](../nestjs-validation/class-validator.md) — the decorators `classValidatorShim` reads.
- [Serialization](../nestjs-validation/serialization.md) — actually shaping the response, which `@ApiProperty` does not do.
- [Versioning](../nestjs-request-handling/versioning.md) — how versioned routes appear in the document.
- [Authorization](authorization.md) — protecting the routes the document advertises.
- [Installation and the CLI](../nestjs/installation-and-cli.md) — the CLI the plugin needs, and its Node floor.
- [Dependency auditing](../nestjs-security/dependency-auditing.md) — the bundled UI is part of your surface.
- [Rate limiting with Throttler](throttler.md) — exempting or limiting the docs route.
- [API documentation](../express-libraries/api-documentation.md) — the Express equivalent, with `swagger-ui-express` and Zod-derived schemas.
