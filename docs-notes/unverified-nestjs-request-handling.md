# Unverified / deliberately omitted — NestJS Request Handling

Pass: `content/nestjs-request-handling/` (guards, interceptors, pipes,
exception-filters, custom-decorators, dtos, versioning, file-uploads),
written 2026-09-11.

Method: every decorator, option and default used on these pages was read from
the published type declarations and compiled JavaScript inside
`@nestjs/common@12.0.1`, `@nestjs/core@12.0.1`,
`@nestjs/platform-express@12.0.1`, `@nestjs/mapped-types@12.0.0`,
`@nestjs/swagger@12.0.1` and `multer@2.2.0`, unpacked with `npm pack`. Anything
that could not be confirmed that way is listed below and does **not** appear in
the pages.

---

## Omitted — could not be verified

| Item | Why it was left out |
| --- | --- |
| `limits.fieldNestingDepth`, `limits.fieldArrayIndexLimit` | Documented for multer 2.3.0 on `content/express-libraries/file-uploads.md`, but the `MulterOptions` interface published in `@nestjs/platform-express@12.0.1` declares only `fieldNameSize`, `fieldSize`, `fields`, `fileSize`, `files`, `parts` and `headerPairs`. Nest pins multer **2.2.0**. Rather than claim an option that is not in the typed surface Nest ships, `file-uploads.md` documents the seven that are. |
| Exact multer error-code → status mapping in a Nest `@Catch(MulterError)` filter | The `MulterError` codes themselves are verified in the Part 1 page, but no Nest-specific `MulterError` filter exists in `@nestjs/platform-express@12.0.1`, so the Nest page describes the approach and cross-links the Part 1 table instead of inventing a filter class name. |
| A `ParseFilePipe` option to iterate a `FileFieldsInterceptor` record | `ParseFilePipe.validateFilesOrFile()` only branches on `Array.isArray(value)`; there is no option that makes it walk a field-map. The page documents the resulting failure and shows per-field validation instead. |
| `@nestjs/throttler` version on the 12.x line | Confirmed in CONTRIBUTING §11.1 to be **6.5.0**. Pages cross-link it with the correct version and leave the configuration to `nestjs-libraries/throttler.md`. |
| Route conflict diagnostics: the exact application-option key | `RouteConflictPolicy`, `RouteConflictPolicyLevel` and `RouteResolutionStrategy` are exported types with verified shapes (CONTRIBUTING §11.4), but `versioning.md` quotes only those type declarations and points at `nestjs/routing-and-path-syntax.md` for how they are wired into `NestFactory.create()`, which is that page's author's call. |

---

## Verified here, worth recording for other authors

These were read directly out of the 12.0.1 packages during this pass and are
not currently written down in CONTRIBUTING Part 2.

- **`errorCode` never reaches the response body on its own.** `HttpException`
  stores it (`initErrorCode()`), and `HttpException.createBody()` accepts a
  fourth `errorCode` argument — but no subclass passes it, and
  `BaseExceptionFilter` does not read it. A custom filter reading
  `exception.errorCode` is the only way clients see it.
- **`BaseExceptionFilter` unknown-error body** is exactly
  `{ statusCode: 500, message: 'Internal server error' }`
  (`MESSAGES.UNKNOWN_EXCEPTION_MESSAGE` in `@nestjs/core/constants.js`), and
  unknown errors are logged unless they extend `IntrinsicException` —
  which `HttpException` does.
- **`@nestjs/common@12.0.1` depends on `file-type@22.0.2`.** `FileTypeValidator`
  dynamically imports it and validates magic numbers **by default**;
  `skipMagicNumbersValidation`, `fallbackToMimetype` and `overrideMimeType` all
  default to `false`.
- **`FileTypeValidator` needs `file.buffer`.** With disk storage it returns
  `false` unless `fallbackToMimetype` or `skipMagicNumbersValidation` is set.
- **A string `fileType` is matched with `String#match`**, i.e. coerced to a
  RegExp (there is an exact-equality shortcut first). Anchored `RegExp` values
  are the safe form.
- **`MaxFileSizeValidator` is strictly less-than** (`file.size < maxSize`), and
  its `message` option is marked `@deprecated` in favour of `errorMessage`.
- **`ParseFilePipe.fileIsRequired` defaults to `true`**; `errorHttpStatusCode`
  defaults to 400.
- **`ParseFilePipe` breaks with `FileFieldsInterceptor`** — the record of
  field-name → file array is passed whole to each validator, so
  `MaxFileSizeValidator` fails every request.
- **`IFile` is not exported from the `@nestjs/common` root.**
  `pipes/file/index.d.ts` re-exports the validators and the pipe but not
  `interfaces/index.js`, so a custom `FileValidator` should declare its own
  narrow file shape.
- **`@nestjs/platform-express@12.0.1` also exports `NoFilesInterceptor`**
  alongside the four documented file interceptors.
- **`ValidationPipe` and `StandardSchemaValidationPipe` both have
  `validateCustomDecorators`, default `false`.** Only the Standard Schema one is
  called out in CONTRIBUTING §11.4; the class-validator pipe has had it too.
- **`PartialType(classRef, { skipNullProperties })`**: the default (`true`)
  applies `@IsOptional()`, which skips `null` as well as `undefined`;
  `false` applies a validate-if-defined rule, so `null` is rejected.
- **`@nestjs/swagger@12.0.1` exports its own type helpers** plus a
  `DeepPartialType` that `@nestjs/mapped-types@12.0.0` does not have.
- **`multer@2.2.0` ships no type declarations**; `Express.Multer.File` needs
  `@types/multer` (currently 2.2.0), a dev dependency.
- **`ParseUUIDPipe` accepts versions `'3' | '4' | '5' | '7'`** in v12.
- **`enableVersioning()` with no argument defaults to
  `{ type: VersioningType.URI }`**; `UriVersioningOptions.prefix` is
  `string | false` (default `'v'`), and a `CUSTOM` extractor's array is ordered
  highest version first.
