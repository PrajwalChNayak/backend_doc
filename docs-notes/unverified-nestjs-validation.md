# Unverified / deliberately omitted — Validation and Serialization

Pass: the five remaining pages in `content/nestjs-validation/`
(`standard-schema-with-zod`, `choosing-an-approach`, `unknown-properties`,
`transforming-payloads`, `serialization`), written 2026-09-11.
`validation-pipe.md` and `class-validator.md` were written in an earlier pass
and were not modified.

Method: every option, decorator, default and behavioral claim on these pages was
read out of the published type declarations **and the compiled JavaScript**
inside packages unpacked with `npm pack`:

| Package | Version | What was read |
| --- | --- | --- |
| `@nestjs/common` | 12.0.1 | `pipes/standard-schema-validation.pipe.{d.ts,js}`, `pipes/validation.pipe.{d.ts,js}`, `serializer/class-serializer.interceptor.{d.ts,js}`, `serializer/standard-schema-serializer.interceptor.{d.ts,js}`, `serializer/standard-schema-serializer.interfaces.d.ts`, `serializer/decorators/serialize-options.decorator.d.ts`, `decorators/http/route-params.decorator.d.ts`, `interfaces/external/class-transform-options.interface.d.ts` |
| `@standard-schema/spec` | 1.1.0 | `dist/index.d.ts` — `StandardSchemaV1.Issue`, `.Options`, `.Result` |
| `class-transformer` | 0.5.1 | `cjs/TransformOperationExecutor.js` — the implicit-conversion branch |
| `zod` | 4.5.4 | `strictObject` / `looseObject` signatures, `toJSONSchema`, `prettifyError` |
| `valibot` | 1.4.2 | `strictObject`, `pipe`, `email`, `minLength`, `maxLength`, `minValue`, `maxValue`, `integer`, `optional`, `InferOutput` |
| `arktype` | 2.2.3 | `~standard` on the base type, `.infer`, `.onUndeclaredKey()`, the `string.email` / `number.integer` keywords |

Anything not confirmed that way is listed below and does **not** appear in the
pages.

---

## Omitted — could not be verified

| Item | Why it was left out |
| --- | --- |
| First-party `@nestjs/swagger` support for a Standard Schema | Nothing in `@nestjs/swagger@12.0.1` reads a `StandardSchemaV1`; its metadata path is `@ApiProperty()` plus the CLI plugin over class DTOs. `standard-schema-with-zod.md` and `choosing-an-approach.md` therefore say the OpenAPI document must be generated from the schema (`z.toJSONSchema()`, or the `@asteasolutions/zod-to-openapi` 9.1.0 / `zod-openapi` 6.0.2 packages already verified in CONTRIBUTING §1.3) and do not claim a Swagger integration exists. |
| A `@nestjs/mapped-types`-style composition helper for schemas | `PartialType` / `PickType` / `OmitType` copy `class-validator` and `@nestjs/swagger` metadata. There is no schema equivalent shipped by Nest, so the pages use each library's own composition (`.partial()`, `.pick()`, `.omit()`) implicitly rather than naming a Nest helper. |
| A `schema` option on `@Headers()` | `ParameterDecoratorOptions` (`{ schema?, pipes? }`) is accepted by `@Body()`, `@Query()` and `@Param()`. `Headers` is declared as `(property?: string) => ParameterDecorator` only. The pages therefore never show a header schema. |
| Dependency injection into a Standard Schema refinement | `StandardSchemaValidationPipe` resolves the schema from parameter metadata; there is no container hook comparable to `class-validator`'s `useContainer()`. `choosing-an-approach.md` states the absence and recommends moving the lookup into the service. |
| Exact wording of library error messages in the sample 400 bodies | The Zod strings (`"Invalid email address"`, `"Too small: expected string to have >=1 characters"`, `"Unrecognized key: \"role\""`) and the class-validator string (`"property role should not exist"`) are illustrative of the shape, not transcribed from a run. The **structure** around them is verified: `StandardSchemaValidationPipe` builds `` `${issue.path.map(String).join('.')}: ${issue.message}` `` and passes the array to `HttpErrorByCode[status]`. |
| Any performance number | `choosing-an-approach.md` argues the *shape* of the cost (instance construction + metadata lookup versus a precomputed schema plan) and explicitly tells the reader to measure. No benchmark was run, so none is quoted. |
| `@nestjs/observe` / route-conflict interaction with validation | Out of scope for this section and not exercised by any validation API. |

---

## Verified here, worth recording for other authors

- **`stripProtoKeys` exists on both pipes.** `StandardSchemaValidationPipe.transform()` calls it *before* `~standard.validate()`, and `ValidationPipe.transform()` calls it before `plainToInstance`. It `delete`s `__proto__`, `prototype` and `constructor`, recurses through arrays and object values, and bails out on typed arrays and on instances of `Date`, `RegExp`, `Error`, `Map`, `Set`, `WeakMap`, `WeakSet`. **It mutates the value in place** — noted on `standard-schema-with-zod.md` and `unknown-properties.md` because it affects raw-body signature verification.

- **`StandardSchemaSerializerInterceptor` maps the schema over array *elements*.** `serialize()` does `Promise.all(response.map(item => this.transformToPlain(item, …)))`. A response schema must describe one item; wrapping it in `z.array()` fails on every element. Documented on `serialization.md`.

- **A serialization mismatch is a 500, not a 400.** `transformToPlain()` throws `new Error('Serialization failed: ' + issues.map(i => i.message).join(', '))` — a plain `Error`, not an `HttpException`. Hence the page's advice to use `z.object()` rather than `z.strictObject()` for responses.

- **`@SerializeOptions()` is one decorator with one metadata key** (`class_serializer:options`), read by both `ClassSerializerInterceptor` and `StandardSchemaSerializerInterceptor` via `reflector.getAllAndOverride([handler, class])`. The class serializer spreads it over its defaults (`{...defaultOptions, ...contextOptions}`); the Standard Schema serializer resolves `contextOptions?.schema ?? defaultOptions.schema` and the same for `validateOptions`.

- **`ValidationPipe.transformPrimitive()` is much narrower than "transform converts params".** It returns early unless `metadata.data` is set (so a *named* `@Param('id')` / `@Query('page')`, never a bare `@Param()`), then only for `type === 'param' | 'query'`, then only for the `Number`, `Boolean` and `String` metatypes. `Number` is `+value` (so `NaN` is passed through to the handler), `Boolean` is `value === true || value === 'true'`, and both return `undefined` unchanged. Documented on `transforming-payloads.md`.

- **`ValidationPipe.toValidate()` skips `String`, `Boolean`, `Number`, `Array`, `Object`, `Buffer` and `Date` metatypes.** The existing `validation-pipe.md` table lists five of those; `Buffer` and `Date` are also skipped. This is what makes the two pipes safe to register together — a `z.infer` type alias erases to `Object`.

- **`validateOptions` is typed differently on the two Standard Schema APIs.** `Record<string, unknown>` on the pipe, `StandardSchemaV1.Options` on the serializer. The spec defines exactly one member on `Options`: `libraryOptions?: Record<string, unknown>`.

- **`StandardSchemaV1.Issue.path` may hold either a `PropertyKey` or a `{ key }` object.** The pipe's default formatter calls `String()` on each segment, so a library reporting object segments yields `[object Object]` in the default message. `standard-schema-with-zod.md` shows an `exceptionFactory` that reads `segment.key`.

- **`z.prettifyError()` accepts a `StandardSchemaV1.FailureResult`**, so `z.prettifyError({ issues })` works directly on the pipe's `exceptionFactory` argument. `z.treeifyError` / `z.flattenError` require a real `$ZodError` and do not.

- **`class-transformer`'s implicit conversion is literally `String(value)` / `Number(value)` / `Boolean(value)`** on the reflected `design:type`, applied on the plain-to-class path only, and only when no `@Type()` is registered for the property. `null` and `undefined` are returned unchanged. This is the mechanism behind the three worked failures on `transforming-payloads.md` (`String(4001) === '4001'`, `Boolean('false') === true`, `Number('') === 0`).

---

## Found in the published types but not documented on any page yet

Flagged for the coordinator — these are verified, and currently missing from the
section:

| API | Where | Note |
| --- | --- | --- |
| `ValidationPipeOptions.errorFormat: 'list' \| 'grouped'` | `pipes/validation.pipe.d.ts` | New in 12.x. `'grouped'` changes the response `message` from `string[]` to `Record<string, string[]>`, which breaks exception filters that assume an array. It is **not** in the options table on the existing `validation-pipe.md`, which this pass did not modify. Worth adding there. |
| `ValidationPipeOptions.validatorPackage` / `transformerPackage` | same file | Lets you supply your own `class-validator` / `class-transformer` instances. Niche; omitted deliberately. |
| `ClassSerializerInterceptorOptions.transformerPackage` | `serializer/class-serializer.interceptor.d.ts` | Same idea on the serializer. Omitted deliberately. |
| `ClassTransformOptions.version` / `targetMaps` | `interfaces/external/class-transform-options.interface.d.ts` | Present in the interface; left out of the `transformOptions` table on `transforming-payloads.md` as rarely useful in a Nest context. |
