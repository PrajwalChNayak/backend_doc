---
title: File uploads
description: Multipart uploads in NestJS 12 with the bundled multer 2.2.0 — the four file interceptors, multer limits, ParseFilePipe validators, and a custom validator that sniffs magic bytes.
status: current
updated: 2026-09-11
---

An upload endpoint lets an anonymous caller write bytes to your infrastructure and usually hands back a URL that serves those bytes again. Nest wraps multer in four interceptors and gives you `ParseFilePipe` to validate what arrives, but every decision that matters — how large, what type, where it lands, who can read it back — is still yours.

## What is already installed

`@nestjs/platform-express@12.0.1` depends on **`multer@2.2.0`**. You do not install multer, and you do not add `@types/multer`-driven middleware by hand; the interceptors below are the supported surface.

:::deprecated
**multer 1.x is end of life and deprecated on npm.** The final 1.x release, `1.4.5-lts.2`, carries the registry deprecation notice *"Multer 1.x is impacted by a number of vulnerabilities, which have been patched in 2.x."* There is no supported 1.x line and no backport branch.

Nest 12 pins 2.2.0, so a fresh project is fine. Run `npm ls multer` anyway — a transitive 1.x from some other package is the case that bites, and the advisories apply to it just the same.
:::

Nest also depends on **`file-type@22.0.2`** in `@nestjs/common@12.0.1`, which is what makes the built-in `FileTypeValidator` able to check magic numbers rather than trusting the client. That is new enough to be worth saying out loud: in Nest 12 the built-in type validator is a real content check by default.

:::note
`multer@2.2.0` ships no type declarations, so the `Express.Multer.File` type used throughout this page needs the ambient definitions:

```bash
npm install --save-dev @types/multer@2
```

It is a dev dependency — nothing about it reaches the runtime — and `@types/multer` is at 2.2.0, matching the bundled multer.
:::

## The four interceptors

All four come from `@nestjs/platform-express` and are functions returning an interceptor class.

| Interceptor | Signature | Handler reads |
| --- | --- | --- |
| `FileInterceptor` | `(fieldName, localOptions?)` | `@UploadedFile()` → one file |
| `FilesInterceptor` | `(fieldName, maxCount?, localOptions?)` | `@UploadedFiles()` → an array |
| `FileFieldsInterceptor` | `(uploadFields: MulterField[], localOptions?)` | `@UploadedFiles()` → a record keyed by field name |
| `AnyFilesInterceptor` | `(localOptions?)` | `@UploadedFiles()` → an array of every file on every field |

There is a fifth, `NoFilesInterceptor(localOptions?)`, which parses a multipart form's text fields and rejects any file. It is the right choice for a form that is multipart only because a browser made it so.

```ts title="src/avatars/avatars.controller.ts"
import { Controller, Post, UploadedFile, UseInterceptors } from '@nestjs/common'
import { FileInterceptor } from '@nestjs/platform-express'
import { memoryStorage } from 'multer'

@Controller('avatars')
export class AvatarsController {
  @Post()
  @UseInterceptors(
    FileInterceptor('avatar', {
      storage: memoryStorage(),
      limits: { fileSize: 2 * 1024 * 1024, files: 1, fields: 4, parts: 8 },
    }),
  )
  upload(@UploadedFile() file: Express.Multer.File) {
    return { size: file.size }
  }
}
```

```ts title="src/documents/documents.controller.ts"
import { Controller, Post, UploadedFiles, UseInterceptors } from '@nestjs/common'
import { FileFieldsInterceptor, FilesInterceptor } from '@nestjs/platform-express'

@Controller('documents')
export class DocumentsController {
  @Post('batch')
  @UseInterceptors(FilesInterceptor('files', 5, { limits: { fileSize: 5 * 1024 * 1024, files: 5 } }))
  batch(@UploadedFiles() files: Express.Multer.File[]) {
    return { count: files.length }
  }

  @Post('application')
  @UseInterceptors(
    FileFieldsInterceptor(
      [
        { name: 'passport', maxCount: 1 },
        { name: 'proofOfAddress', maxCount: 2 },
      ],
      { limits: { fileSize: 5 * 1024 * 1024, files: 3 } },
    ),
  )
  application(@UploadedFiles() files: { passport?: Express.Multer.File[]; proofOfAddress?: Express.Multer.File[] }) {
    return { passport: files.passport?.length ?? 0 }
  }
}
```

`MulterField` is `{ name: string; maxCount?: number }`. Declare `maxCount` on every field — omitting it means unbounded for that field, bounded only by the global `limits.files`.

:::danger
`AnyFilesInterceptor()` accepts every file on every field name. Use it only when the field names are genuinely unknown at design time, and even then pair it with `limits.files`. A route that accepts arbitrary field names is a route whose validation you cannot write, because you do not know what you are validating.
:::

## Options

`MulterOptions` in `@nestjs/platform-express@12.0.1` — these are the fields the published interface declares, so they are the ones to rely on:

| Option | Meaning |
| --- | --- |
| `storage` | the multer storage engine (`memoryStorage()` / `diskStorage()`) |
| `dest` | a destination directory, as a shorthand for disk storage |
| `limits` | the size and count caps below |
| `fileFilter` | `(req, file, cb)` — accept or reject a part before its bytes are read |
| `preservePath` | keep the client's full path in `originalname` (default `false`) |
| `defParamCharset` | charset for part header values such as `filename` (default `'latin1'`) |

### `limits` — every default that matters is unbounded

| Key | Default | Set it to |
| --- | --- | --- |
| `fileSize` | Infinity | the largest file you actually accept, in bytes |
| `files` | Infinity | the number of files the route expects |
| `fields` | Infinity | the number of non-file fields |
| `parts` | Infinity | `fields + files + 1`, at minimum |
| `fieldNameSize` | 100 bytes | leave it |
| `fieldSize` | 1 MB | as small as your largest text field needs |
| `headerPairs` | 2000 | 20 is plenty for a real form |

```ts
const limits = {
  fileSize: 5 * 1024 * 1024,
  files: 1,
  fields: 5,
  parts: 8,
  fieldSize: 16 * 1024,
  headerPairs: 20,
}
```

Limits are enforced **while parsing**, so an over-sized upload is aborted mid-stream rather than after you have absorbed it. Leaving `fields` and `parts` unset is the denial-of-service hole people miss: a client can send a million tiny text parts and keep the process parsing indefinitely without ever exceeding `fileSize`.

:::warning
`limits.fileSize` is not a request-size limit. `fileSize: 5MB` with `files: 10` still permits a 50 MB request. Cap the whole body at the proxy as well — `client_max_body_size` in nginx — and make the proxy's read timeout longer than a legitimate slow upload.
:::

### Registering options once

`MulterModule` keeps the configuration out of every controller and lets it come from the config service.

```ts title="src/uploads/uploads.module.ts"
import { Module } from '@nestjs/common'
import { ConfigModule, ConfigService } from '@nestjs/config'
import { MulterModule } from '@nestjs/platform-express'
import { memoryStorage } from 'multer'

@Module({
  imports: [
    MulterModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        storage: memoryStorage(),
        limits: {
          fileSize: config.get<number>('UPLOAD_MAX_BYTES') ?? 5 * 1024 * 1024,
          files: 1,
          fields: 5,
          parts: 8,
        },
      }),
    }),
  ],
})
export class UploadsModule {}
```

`MulterModule.register()` takes the options directly; `registerAsync()` takes `useFactory`, `useClass` or `useExisting` (a class implementing `MulterOptionsFactory`). Options passed to an individual interceptor override the module's.

### Memory or disk

| | `memoryStorage()` | `diskStorage()` / `dest` |
| --- | --- | --- |
| Bytes land in | `file.buffer` | a file on disk, path in `file.path` |
| `file.buffer` present | yes | **no** |
| Right for | small files you immediately validate, re-encode or forward to object storage | larger files you will move or keep on this host |
| Fails by | exhausting heap — `fileSize × concurrency` is your real RAM requirement | filling the disk, and leaving orphans when a later step throws |
| Cleanup | automatic | **yours** — multer does not delete the file if your handler throws |

Memory storage is the better default here for one Nest-specific reason: **`FileTypeValidator` needs `file.buffer`**. With disk storage there is no buffer, so the magic-number check cannot run — see below.

## Validating with `ParseFilePipe`

`ParseFilePipe` runs a list of `FileValidator`s against the uploaded file and throws when one fails.

```ts title="src/avatars/avatars.controller.ts"
import {
  Controller,
  FileTypeValidator,
  MaxFileSizeValidator,
  ParseFilePipe,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common'
import { FileInterceptor } from '@nestjs/platform-express'
import { memoryStorage } from 'multer'

@Controller('avatars')
export class AvatarsController {
  @Post()
  @UseInterceptors(
    FileInterceptor('avatar', {
      storage: memoryStorage(),
      limits: { fileSize: 2 * 1024 * 1024, files: 1, fields: 4, parts: 8 },
    }),
  )
  upload(
    @UploadedFile(
      new ParseFilePipe({
        fileIsRequired: true,
        validators: [
          new MaxFileSizeValidator({ maxSize: 2 * 1024 * 1024 }),
          new FileTypeValidator({ fileType: /^image\/(png|jpeg|webp)$/ }),
        ],
      }),
    )
    file: Express.Multer.File,
  ) {
    return this.avatars.store(file)
  }
}
```

`ParseFileOptions`, verified against the 12.0.1 declarations:

| Option | Default | Meaning |
| --- | --- | --- |
| `validators` | `[]` | the validators to run, in order |
| `fileIsRequired` | **`true`** | throw when no file arrived |
| `errorHttpStatusCode` | `400` | the status thrown on failure |
| `exceptionFactory` | builds from the status | `(error: string) => any` |

There is also a fluent builder, if you prefer it:

```ts
import { ParseFilePipeBuilder } from '@nestjs/common'

const avatarPipe = new ParseFilePipeBuilder()
  .addMaxSizeValidator({ maxSize: 2 * 1024 * 1024 })
  .addFileTypeValidator({ fileType: /^image\/(png|jpeg|webp)$/ })
  .build({ fileIsRequired: true })
```

### `MaxFileSizeValidator`

`{ maxSize: number, errorMessage?: string | ((ctx) => string) }`. The older `message` option is marked deprecated in the type declarations — use `errorMessage`.

The comparison is **strictly less than**: a file of exactly `maxSize` bytes fails. Size it accordingly, and keep `limits.fileSize` at the same value so an over-sized upload is aborted during parsing rather than buffered and then rejected.

### `FileTypeValidator`

```ts
interface FileTypeValidatorOptions {
  fileType: string | RegExp
  errorMessage?: string | ((ctx: FileTypeValidatorContext) => string)
  skipMagicNumbersValidation?: boolean   // default false
  fallbackToMimetype?: boolean           // default false
  overrideMimeType?: boolean             // default false
}
```

By default it reads the file's magic numbers with `file-type` and matches the **detected** MIME type, not the client's. Three consequences worth knowing before you ship:

- **No buffer, no check.** With disk storage `file.buffer` is absent, so validation fails outright unless you set `fallbackToMimetype: true` (which trusts the client's string) or `skipMagicNumbersValidation: true` (which does the same, explicitly). Use memory storage when you want the real check.
- **Formats without a signature fail.** CSV, plain text and SVG have no magic number, so `file-type` detects nothing and the validator rejects them. `fallbackToMimetype: true` is the escape hatch, and it is exactly as trustworthy as the client.
- **`overrideMimeType: true` rewrites `file.mimetype`** to the detected value. That is usually what you want to store, because it is the only type string in the object that you derived rather than received.

:::warning
A string `fileType` is matched with `String#match`, which coerces the string to a regular expression. That makes it a *substring* match — `fileType: 'image/png'` also accepts a MIME type that merely contains it — and it makes MIME types with regex metacharacters unreliable (the `+` in `image/svg+xml`). Pass an anchored `RegExp` instead: `/^image\/(png|jpeg|webp)$/`.
:::

### `ParseFilePipe` and `FileFieldsInterceptor` do not mix

This one is load-bearing and not obvious. `ParseFilePipe` validates a single file or iterates an array. With `FileFieldsInterceptor` the value is a **record** of field name to array, and the pipe passes that whole record to each validator. `MaxFileSizeValidator` then checks `'size' in record`, finds nothing, and fails the request — so the endpoint rejects every upload, with a confusing message about the expected size.

Validate per field instead:

```ts title="src/documents/documents.controller.ts"
import { BadRequestException, Controller, Post, UploadedFiles, UseInterceptors } from '@nestjs/common'
import { FileFieldsInterceptor } from '@nestjs/platform-express'
import { assertAcceptable } from './file-checks.js'

@Controller('documents')
export class DocumentsController {
  @Post('application')
  @UseInterceptors(
    FileFieldsInterceptor(
      [{ name: 'passport', maxCount: 1 }, { name: 'proofOfAddress', maxCount: 2 }],
      { limits: { fileSize: 5 * 1024 * 1024, files: 3, fields: 6, parts: 12 } },
    ),
  )
  async application(
    @UploadedFiles() files: Record<string, Express.Multer.File[] | undefined>,
  ) {
    const passport = files.passport?.[0]
    if (!passport) throw new BadRequestException('passport is required', { errorCode: 'FILE_REQUIRED' })

    for (const file of [passport, ...(files.proofOfAddress ?? [])]) {
      await assertAcceptable(file)
    }
    return this.documents.store(files)
  }
}
```

## A custom validator that sniffs the real bytes

The two things a client tells you about a file's type are both worthless: `file.mimetype` is copied from the multipart part's `Content-Type`, which the client writes, and the extension in `file.originalname` is a string the client chose. `image/png` on a shell script costs nothing.

`FileTypeValidator` already checks magic numbers, so write your own when you need something it does not do: a closed allow-list that also yields the extension you will store, and a hard rejection of anything `file-type` cannot identify.

```ts title="src/uploads/magic-bytes.validator.ts"
import { FileValidator } from '@nestjs/common'

// The shape ParseFilePipe hands a validator. Nest's own `IFile` is not exported
// from the package root, so declare the narrow shape you actually read.
export interface UploadedFileLike {
  mimetype: string
  size: number
  buffer?: Buffer
}

// Sniffed MIME -> the extension we will use. Nothing outside this map is stored.
const ALLOWED = new Map([
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp'],
  ['application/pdf', '.pdf'],
])

export interface MagicBytesOptions {
  allowed?: Map<string, string>
}

export class MagicBytesValidator extends FileValidator<MagicBytesOptions> {
  private detected?: string

  async isValid(file?: UploadedFileLike): Promise<boolean> {
    if (!file || !file.buffer) return false

    const { fileTypeFromBuffer } = await import('file-type')
    const result = await fileTypeFromBuffer(file.buffer)
    this.detected = result?.mime

    const allowed = this.validationOptions.allowed ?? ALLOWED
    if (!result || !allowed.has(result.mime)) return false

    // The only type string we will ever store is the one we derived.
    file.mimetype = result.mime
    return true
  }

  buildErrorMessage(): string {
    const allowed = [...(this.validationOptions.allowed ?? ALLOWED).keys()].join(', ')
    return `Unsupported file type${this.detected ? ` (${this.detected})` : ''}; allowed: ${allowed}`
  }
}
```

```ts title="src/uploads/file-checks.ts"
import { UnsupportedMediaTypeException } from '@nestjs/common'
import { MagicBytesValidator } from './magic-bytes.validator.js'
import type { UploadedFileLike } from './magic-bytes.validator.js'

const validator = new MagicBytesValidator({})

export async function assertAcceptable(file: UploadedFileLike): Promise<void> {
  if (!(await validator.isValid(file))) {
    throw new UnsupportedMediaTypeException(validator.buildErrorMessage(), {
      errorCode: 'UNSUPPORTED_FILE_TYPE',
    })
  }
}
```

`FileValidator` is an abstract class exported from `@nestjs/common` with `validationOptions` on `this`, an `isValid()` that may return a promise, and a `buildErrorMessage()`. Its internal file type is `{ mimetype: string; size: number; buffer?: Buffer }` — deliberately narrow, so a validator works for both Express and Fastify — but that interface is not re-exported from the package root, so declare the shape yourself as above rather than reaching into a deep import path.

Two limits of magic-byte sniffing, stated plainly by `file-type`'s own documentation:

- **It is a hint, not a guarantee.** Magic bytes say "this begins like a PNG", not "this is a valid, safe PNG". A polyglot file can be a valid GIF *and* a valid HTML document at once.
- **It only covers binary formats.** SVG, CSV and plain text have no signature. If you accept SVG, sanitize it and serve it with `Content-Disposition: attachment` — it is XML that can contain `<script>`.

For images the strongest control available is to **re-encode**: decode the upload with `sharp` **0.35.4** and write out a fresh file. Whatever was hidden in the metadata or appended after the image data does not survive a decode, and you get EXIF stripping — including GPS coordinates — for free.

## Never let the client name the file

`file.originalname` is a client-supplied string, and it has been the source of two decades of path traversal. An `originalname` of `../../../../etc/cron.d/pwn` escapes the directory; multer's `preservePath` option, when enabled, keeps the client's path segments and does not sanitize them.

```ts title="src/uploads/uploads.service.ts"
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Injectable } from '@nestjs/common'
import type { UploadedFileLike } from './magic-bytes.validator.js'

const EXTENSIONS = new Map([
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp'],
  ['application/pdf', '.pdf'],
])

@Injectable()
export class UploadsService {
  private readonly dir = process.env.UPLOAD_DIR ?? '/var/lib/app/uploads'

  // `file.mimetype` here is the SNIFFED value, rewritten by the validator.
  async store(file: UploadedFileLike & { originalname: string; buffer: Buffer }) {
    const ext = EXTENSIONS.get(file.mimetype) ?? ''
    const filename = `${randomUUID()}${ext}`
    const dest = path.join(this.dir, filename)

    // Belt and braces: the resolved path must still be inside the directory.
    if (path.relative(this.dir, dest).startsWith('..')) throw new Error('path_escape')

    await writeFile(dest, file.buffer, { flag: 'wx' })   // fail if it already exists

    return this.repo.insert({
      filename,
      mimeType: file.mimetype,
      size: file.size,
      displayName: file.originalname,   // stored as DATA, never as a path
    })
  }
}
```

The name comes from you; the extension comes from the sniffed type; the client's name is a `display_name` column, escaped on output.

## Serving uploads back

`StreamableFile` is the supported way to return bytes from a handler, and the headers are what stop a stored file from executing in your origin.

```ts title="src/uploads/uploads.controller.ts"
import { createReadStream } from 'node:fs'
import path from 'node:path'
import { Controller, Get, NotFoundException, Param, ParseUUIDPipe, Res, StreamableFile } from '@nestjs/common'
import type { Response } from 'express'
import { CurrentUser } from '../common/decorators/current-user.decorator.js'

@Controller('files')
export class FilesController {
  @Get(':id')
  async download(
    @Param('id', new ParseUUIDPipe({ version: '7' })) id: string,
    @CurrentUser('id') userId: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StreamableFile> {
    // Ownership is checked against the loaded row, in the service. Not in a guard.
    const record = await this.uploads.findOwnedBy(userId, id)
    if (!record) throw new NotFoundException('Not found', { errorCode: 'FILE_NOT_FOUND' })

    response.setHeader('X-Content-Type-Options', 'nosniff')
    response.setHeader('Content-Security-Policy', "default-src 'none'; sandbox")

    return new StreamableFile(createReadStream(path.join(this.dir, record.filename)), {
      type: record.mimeType,                                  // the sniffed type, from the database
      disposition: `attachment; filename="${encodeURIComponent(record.displayName)}"`,
      length: record.size,
    })
  }
}
```

Why each piece is there:

- **`nosniff`** stops the browser second-guessing your `Content-Type` and executing something you declared as an octet-stream.
- **`Content-Disposition: attachment`** makes the browser download rather than render, which neutralizes stored XSS in an uploaded HTML or SVG file.
- **The `Content-Type` is the value you sniffed at upload time**, read back from your own database — never from the request and never from the extension.
- **Ownership is checked in the service against the loaded row.** An unguessable UUID is not an access control, and a guard cannot do this check — it runs before the record is loaded. See [Guards](guards.md).

**Store outside anything that is served statically.** If uploads land in a directory `ServeStaticModule` or your web server maps to a URL, an attacker chooses the path of a file on your host. On any stack that can execute from that directory, that is remote code execution. Better still: put the bytes in object storage and keep nothing on the application host.

:::danger
Serving user uploads from your API's own origin means any script that does execute runs with your origin's cookies. Put uploads on a separate domain — a dedicated `usercontent.example.net`, not just a different path — when you can. `Content-Disposition: attachment` plus a restrictive CSP is the mitigation when you cannot.
:::

The full exploit narrative — polyglots, double extensions, content-type confusion and the path from upload to code execution — is in [File upload security](../nestjs-security/file-upload-security.md).

## Common patterns

### `fileFilter` rejects a part before its bytes arrive

```ts
FileInterceptor('avatar', {
  storage: memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024, files: 1 },
  fileFilter(_req, file, cb) {
    // A cheap pre-filter only. The client controls both of these strings,
    // so the real check still happens after the bytes land.
    cb(null, /^image\//.test(file.mimetype))
  },
})
```

`fileFilter` sees only the part headers, so it can save you from reading 2 MB you were always going to reject. It is not a security control — it reads exactly the values the client wrote.

### Large files: take your server off the data path

Buffering a 2 GB video into heap or onto the app host's disk is the wrong shape. Issue a short-lived presigned upload URL and let the client `PUT` straight to object storage: the server picks the key, pins `ContentType` and `ContentLength`, sets a five-minute expiry, and marks the record usable only after it has inspected the object. The Express version of this, with working `@aws-sdk/client-s3` code, is in [File uploads](../express-libraries/file-uploads.md) and applies unchanged inside a Nest service.

### Mapping multer errors

Multer signals limit violations with a `MulterError` carrying a `code`. Without a mapping they surface as a generic 500 and the client learns nothing — `LIMIT_FILE_SIZE` in particular should be a **413**, which is actionable. A `@Catch()` filter on `MulterError` is the place for that; see [Exception filters](exception-filters.md), and the full code table in [File uploads](../express-libraries/file-uploads.md).

### Rate limit upload routes separately

An upload costs orders of magnitude more than a normal request. Give the route its own throttle rather than letting it share the global one. See [Rate limiting with Throttler](../nestjs-libraries/throttler.md).

### Testing the failure paths

Four cases are worth an end-to-end test each: an over-size file, a file on an undeclared field, a `.png` that is really a script, and a filename containing `../`. All four are cheap to write with `supertest` and all four have shipped broken in real services. See [End-to-end tests](../nestjs-testing/e2e-tests.md).

## Common mistakes

- **Running multer 1.x anywhere in the tree.** End of life, npm-deprecated, with known advisories. Nest 12 pins 2.2.0 — check transitive dependencies.
- **Leaving `limits` unset.** `fileSize`, `files`, `fields` and `parts` all default to Infinity; a million tiny parts is a denial of service that never trips a size cap.
- **Setting `fileSize` but not `files` or `parts`.** Ten files at the limit each, or an endless stream of parts.
- **Using `AnyFilesInterceptor()` because it is convenient.** Every field name becomes acceptable, so there is nothing left to validate against.
- **Omitting `maxCount` on a `FileFieldsInterceptor` field.** That field is unbounded.
- **Combining `ParseFilePipe` with `FileFieldsInterceptor`.** The pipe hands the whole record to each validator and every request fails. Validate per field.
- **Expecting `FileTypeValidator` to sniff magic bytes with disk storage.** There is no `file.buffer`, so it fails unless you opt back into trusting the client's MIME string.
- **Passing a plain string `fileType`.** It is coerced to a regular expression, so it matches substrings. Use an anchored `RegExp`.
- **Trusting `file.mimetype` or the extension in `originalname`.** Both are client-written strings.
- **Deriving the stored extension from the client's filename** instead of from the sniffed type.
- **Using `originalname` as a path component.** Traversal, collisions and NUL bytes. Generate a UUID and keep the client's name as data.
- **Saving uploads into a statically served directory.** Upload-to-RCE.
- **Serving uploads without `nosniff` and `Content-Disposition: attachment`.** Stored XSS with your origin's cookies.
- **Authorizing a download in a guard.** It runs before the record is loaded; check ownership in the service, and return 404 rather than 403.
- **Forgetting that `MaxFileSizeValidator` is strictly less-than.** A file of exactly `maxSize` bytes is rejected.
- **Leaving orphans behind with disk storage.** Multer does not delete the file when your handler throws.

## Related topics

- [File upload security](../nestjs-security/file-upload-security.md) — the exploits this page's rules exist to prevent.
- [File uploads](../express-libraries/file-uploads.md) — multer in plain Express: `MulterError` codes, presigned uploads, virus scanning.
- [Interceptors](interceptors.md) — what the four file interceptors are, and `StreamableFile` on the way out.
- [Pipes](pipes.md) — `ParseFilePipe` beside the other built-in pipes.
- [Exception filters](exception-filters.md) — mapping `MulterError` to a 413 instead of a 500.
- [Guards](guards.md) — why download authorization cannot live in one.
- [DTOs](dtos.md) — validating the text fields that accompany the file.
- [Rate limiting with Throttler](../nestjs-libraries/throttler.md) — bounding the most expensive endpoint you own.
- [Configuration](../nestjs/configuration.md) — getting `UPLOAD_DIR` and size limits out of the code.
- [End-to-end tests](../nestjs-testing/e2e-tests.md) — exercising the four failure paths.
- [File upload security](../security/file-upload-security.md) — polyglots, double extensions and the path to code execution.
- [Streams and buffers](../node/streams-and-buffers.md) — what `memoryStorage()` is actually holding.
