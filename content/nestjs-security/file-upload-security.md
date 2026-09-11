---
title: File upload security
description: Exploiting a NestJS 12 upload endpoint — unbounded multer 2.2.0 limits, MIME spoofing, path traversal through originalname and stored XSS — with ParseFilePipe, a magic-byte FileValidator and the two ParseFilePipe traps verified against the shipped source.
status: current
updated: 2026-09-11
---

An upload endpoint lets an unauthenticated stranger write bytes to your infrastructure, and usually hands back a URL that serves those bytes to other people. Nest wraps multer in four interceptors and gives you `ParseFilePipe` to validate what arrives, but every default that matters is unbounded, the built-in type validator has two specific failure modes, and nothing stops you from using the client's filename as a path.

The attack mechanics — decompression bombs, SVG as an XSS vector, SSRF through "upload from URL", why an extension check is not a type check — are in [File upload security](../security/file-upload-security.md). The API tour is [File uploads](../nestjs-request-handling/file-uploads.md). This page is what an attacker does to a Nest 12 upload endpoint and what stops them.

## What is installed, and what must not be

`@nestjs/platform-express@12.0.1` bundles **multer 2.2.0** — read from its own `dependencies`, not assumed:

```json title="node_modules/@nestjs/platform-express/package.json"
{ "dependencies": { "cors": "2.8.6", "express": "5.2.1", "multer": "2.2.0",
  "path-to-regexp": "8.4.2", "tslib": "2.8.1" } }
```

`@nestjs/common@12.0.1` additionally depends on **`file-type@22.0.2`**, which is what lets the built-in `FileTypeValidator` inspect magic numbers instead of trusting the client.

:::deprecated multer 1.x is end of life
`multer@1.4.5-lts.2` carries this npm deprecation notice verbatim:

> Multer 1.x is impacted by a number of vulnerabilities, which have been patched in 2.x. You should upgrade to the latest 2.x version.

Never install it, never pin it, and check what you actually resolved — a transitive dependency can pull it in behind your back:

```bash
npm ls multer
```

```text
api@1.0.0
└─┬ @nestjs/platform-express@12.0.1
  └── multer@2.2.0
```

Anything other than a 2.x here is a finding. See [Dependency auditing](dependency-auditing.md).
:::

## The threat

Four distinct outcomes, from one endpoint:

| Attack | What the attacker gains |
| --- | --- |
| Unbounded size or count | the process out of memory, or the disk full — a whole-service outage for the price of one `curl` |
| MIME spoofing | an executable, a script or an HTML page stored where you expected an image |
| Path traversal via the filename | a write to a path you did not choose — `.env`, a config file, a web-root script |
| Stored content served back on your origin | an XSS with your cookies, on your domain, triggered by other users |

## Unbounded size and count

### The exploit

The default Nest upload endpoint. Nothing is wrong with the code except everything it does not say.

:::danger Every limit unset
```ts vulnerable title="DO NOT COPY — src/uploads/uploads.controller.ts"
import { Controller, Post, UploadedFile, UseInterceptors } from '@nestjs/common'
import { FileInterceptor } from '@nestjs/platform-express'
import type { Express } from 'express'

@Controller('uploads')
export class UploadsController {
  @Post('avatar')
  // No limits object. multer's fileSize, files, fields and parts all default
  // to Infinity, and memoryStorage() buffers the whole thing in the heap.
  @UseInterceptors(FileInterceptor('file'))
  upload(@UploadedFile() file: Express.Multer.File) {
    return { size: file.size }
  }
}
```
:::

```bash
# 8 GB of zeroes, streamed, never touching the attacker's disk either.
head -c 8G /dev/zero > /tmp/big
curl -s -X POST localhost:3000/uploads/avatar -F 'file=@/tmp/big'
```

```text title="the process, not the response"
<--- Last few GCs --->
FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory
```

Or without a large file at all, by sending many small parts:

```bash
# 50,000 parts. No single one is large; the loop is the attack.
ARGS=$(for i in $(seq 1 50000); do printf -- "-F f%d=x " "$i"; done)
curl -s -X POST localhost:3000/uploads/avatar $ARGS
```

### The fix in code

Set every limit. These are multer 2.2.0's actual defaults:

| Limit | Default | Set it to |
| --- | --- | --- |
| `fileSize` | **Infinity** | the real maximum for this endpoint |
| `files` | **Infinity** | the number of files you accept |
| `fields` | **Infinity** | the number of non-file fields |
| `parts` | **Infinity** | `files + fields` |
| `fieldSize` | 1 MB | lower if your fields are short |
| `fieldNameSize` | 100 bytes | leave |
| `headerPairs` | 2000 | leave |
| `fieldNestingDepth` | **Infinity** | 1 or 2 |

```ts good title="src/uploads/uploads.controller.ts"
import {
  Controller,
  FileTypeValidator,
  MaxFileSizeValidator,
  ParseFilePipe,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common'
import { FileInterceptor, memoryStorage } from '@nestjs/platform-express'
import { Throttle } from '@nestjs/throttler'
import type { Express } from 'express'
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js'
import { UploadsService } from './uploads.service.js'

const MAX_BYTES = 2 * 1024 * 1024

@Controller('uploads')
@UseGuards(JwtAuthGuard)
export class UploadsController {
  private readonly uploads: UploadsService

  constructor(uploads: UploadsService) {
    this.uploads = uploads
  }

  // An upload route costs far more per request than a JSON route. Give it
  // its own budget rather than the application default.
  @Throttle({ uploads: { limit: 10, ttl: 60_000 } })
  @Post('avatar')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: {
        fileSize: MAX_BYTES,   // busboy aborts mid-stream; bytes stop arriving
        files: 1,
        fields: 2,
        parts: 3,
        fieldSize: 1024,
        fieldNestingDepth: 1,
      },
    }),
  )
  upload(
    @UploadedFile(
      new ParseFilePipe({
        fileIsRequired: true,
        validators: [
          new MaxFileSizeValidator({ maxSize: MAX_BYTES }),
          new FileTypeValidator({ fileType: /^image\/(png|jpeg|webp)$/ }),
        ],
      }),
    )
    file: Express.Multer.File,
  ) {
    return this.uploads.store(file)
  }
}
```

Two things about that pairing:

- **`limits.fileSize` is the one that matters.** It aborts the stream while the bytes are arriving, so the oversized file is never fully buffered. `MaxFileSizeValidator` runs *after* parsing, so on its own it rejects a file you have already paid to receive. Set both, to the same number.
- **`MaxFileSizeValidator` is strictly less than.** A file of exactly `maxSize` bytes fails. Size the constant with that in mind, and keep it identical to `limits.fileSize` so the two cannot disagree.

You do not need an exception filter for the limits themselves. Nest's interceptors pass every multer failure through `transformException` first, which maps them for you:

| multer failure | What the client gets |
| --- | --- |
| `LIMIT_FILE_SIZE` | **413** `PayloadTooLargeException` — "File too large" |
| `LIMIT_FILE_COUNT`, `LIMIT_PART_COUNT`, `LIMIT_FIELD_COUNT`, `LIMIT_FIELD_KEY`, `LIMIT_FIELD_VALUE`, `LIMIT_FIELD_NESTING`, `LIMIT_UNEXPECTED_FILE`, `MISSING_FIELD_NAME` | **400**, with ` - <field>` appended when multer names the field |
| Busboy-level failures — a missing boundary, a malformed part header, a truncated form | **400** |

:::warning The mapping is by message, not by code
`transformException` switches on `error.message` against a fixed table of multer's own strings. An error raised anywhere else in the upload path — your `fileFilter`, a custom storage engine, a stream error — does not match any of them and reaches the client as a **500**.

So make `fileFilter` throw a Nest exception rather than a plain `Error`. `transformException` returns an `HttpException` untouched:

```ts good title="src/uploads/uploads.controller.ts"
FileInterceptor('file', {
  storage: memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: 1 },
  fileFilter: (_request, file, callback) => {
    // A plain Error here would be a 500. An HttpException survives
    // transformException unchanged and reaches the client as a 415.
    if (!/^image\/(png|jpeg|webp)$/.test(file.mimetype)) {
      return callback(new UnsupportedMediaTypeException('Unsupported file type'), false)
    }
    callback(null, true)
  },
})
```

`fileFilter` sees only the client's declared `mimetype`, so it is a cheap early reject that saves you reading the body — never the content check. That is still `FileTypeValidator`'s job, after the bytes have arrived.
:::

### How to verify

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:3000/uploads/avatar \
  -H "authorization: Bearer $TOKEN" -F 'file=@/tmp/big'
```

```text
413
```

The 413 arrives quickly, and the process memory does not move — that is the actual assertion. A 413 that shows up after the whole 8 GB has been buffered means `limits.fileSize` is missing and only the validator is doing the work.

## Content-type spoofing

### The exploit

`file.mimetype` is a string the client typed into the multipart headers. It is not derived from the bytes.

```bash
# An ELF binary, announced as a PNG, with a .png name.
curl -s -X POST localhost:3000/uploads/avatar \
  -H "authorization: Bearer $TOKEN" \
  -F 'file=@/bin/sh;type=image/png;filename=avatar.png'
```

```json title="201 Created — with a filter that trusts mimetype"
{ "url": "https://cdn.example.test/avatars/avatar.png" }
```

The same trick with an HTML file is the stored-XSS variant, and with an SVG it works even against a content check, because SVG is XML that can carry `<script>`.

### The fix in code

In Nest 12 the built-in validator already does the real check. `FileTypeValidator` reads the file's magic numbers with `file-type` and matches the **detected** MIME type, not the client's:

```ts good title="src/uploads/uploads.controller.ts"
new FileTypeValidator({
  fileType: /^image\/(png|jpeg|webp)$/,
  // Replaces file.mimetype with what the bytes actually say, so anything
  // downstream that reads it gets the truth.
  overrideMimeType: true,
})
```

Its options, from the shipped type declarations:

| Option | Default | Effect |
| --- | --- | --- |
| `fileType` | required | a string (exact MIME) or a `RegExp` matched against the **detected** type |
| `skipMagicNumbersValidation` | `false` | trust the client's string instead — do not |
| `fallbackToMimetype` | `false` | trust the client's string *when detection fails* |
| `overrideMimeType` | `false` | rewrite `file.mimetype` from the detected type |
| `errorMessage` | — | string, or a function of `{ file, config }` |

:::warning A string `fileType` is coerced into a regular expression
`matchesFileType` compares with `===` first and then falls through to `mimetype.match(fileType)`. `String#match` turns a string argument into a `RegExp`, so a MIME type containing regex metacharacters — the `+` in `image/svg+xml` — never matches itself through the second branch. Exact equality still works; a partial or differently-cased detection does not. Use an explicit `RegExp` with the metacharacters escaped when the type has any.
:::

### A custom validator with a closed allow-list

Write your own when you need something the built-in does not do: a hard rejection of anything `file-type` cannot identify, and a canonical extension to store the file under.

```ts good title="src/uploads/magic-bytes.validator.ts"
import { FileValidator } from '@nestjs/common'

/**
 * The shape ParseFilePipe hands a validator. `IFile` is exported from
 * @nestjs/common as `{ mimetype: string; size: number; buffer?: Buffer }`;
 * declaring it locally keeps the validator usable from Fastify too.
 */
export interface UploadedFileLike {
  mimetype: string
  size: number
  buffer?: Buffer
}

// Detected MIME type -> the extension we will store it as. A closed set:
// anything not listed is rejected, including everything file-type cannot name.
const ALLOWED = new Map<string, string>([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/webp', 'webp'],
  ['application/pdf', 'pdf'],
])

export class MagicBytesValidator extends FileValidator<Record<string, never>, UploadedFileLike> {
  async isValid(file?: UploadedFileLike | UploadedFileLike[] | Record<string, UploadedFileLike[]>) {
    // Guard the shape. ParseFilePipe hands a field-map record straight through
    // when the interceptor is FileFieldsInterceptor — see below.
    if (!file || Array.isArray(file) || !('buffer' in file) || !file.buffer) return false

    const { fileTypeFromBuffer } = await import('file-type')
    const detected = await fileTypeFromBuffer(file.buffer)

    // No signature means no decision, and no decision means no.
    if (!detected) return false
    return ALLOWED.has(detected.mime)
  }

  buildErrorMessage(): string {
    return `Unsupported file type. Allowed: ${[...ALLOWED.keys()].join(', ')}`
  }

  static extensionFor(mime: string): string | undefined {
    return ALLOWED.get(mime)
  }
}
```

Two limits of magic-byte sniffing, stated by `file-type` itself and worth stating to your reader:

- **Text-based formats have no signature.** CSV, plain text, SVG and JSON are indistinguishable from each other by their first bytes. `file-type` returns nothing, and the validator above rejects them. If you must accept them, validate them by *parsing* them — and treat SVG as untrusted HTML, which means sanitizing or refusing it.
- **A valid signature is not a safe file.** A real PNG can carry a malicious payload in a later chunk. Re-encoding through `sharp` **0.35.4** discards everything that is not pixels, which is the only strong answer for images.

## The two `ParseFilePipe` traps

Both of these are verified against the shipped `@nestjs/common@12.0.1` source, not inferred from the documentation. Both produce an endpoint that rejects every upload with a message that points at the wrong thing.

### 1. `FileTypeValidator` cannot work with disk storage

`isValid()` reads `file.buffer`. `diskStorage()` writes the bytes to a file and gives you `file.path` — there is no buffer. The shipped implementation then does this:

```text
if (!file.buffer) {
  if (fallbackToMimetype) return matchesFileType(file.mimetype)
  return false
}
```

So with disk storage the validator returns `false` for **every** file, and `buildErrorMessage` produces a specifically confusing sentence:

```json title="400 Bad Request — for a perfectly valid PNG"
{
  "message": "Validation failed (file buffer is not available; file type validation could not be performed; expected type is /^image\\/(png|jpeg|webp)$/)",
  "statusCode": 400
}
```

The two escape hatches both amount to trusting the client: `fallbackToMimetype: true` uses the client's string when detection is impossible, and `skipMagicNumbersValidation: true` uses it always. Neither is a content check.

**Use `memoryStorage()` when you want the real check** — which is why the bounded `limits.fileSize` above is not optional. For files too large to buffer, do not validate them in the request at all: stream them to object storage and check the content in a worker, or use presigned uploads.

### 2. `ParseFilePipe` hands a field map to each validator whole

`ParseFilePipe.validateFilesOrFile()` branches on exactly one thing:

```text
if (Array.isArray(value)) { await Promise.all(value.map(f => this.validate(f))) }
else                      { await this.validate(value) }
```

`FileInterceptor` yields one file object, and `FilesInterceptor` yields an array — both handled. `FileFieldsInterceptor` yields a **record** of field name to array (`{ avatar: [file], banner: [file] }`), which is not an array, so the whole record goes to `validate()` and from there to every validator. `MaxFileSizeValidator.isValid()` then evaluates `'size' in record`, finds nothing, and fails:

:::danger `ParseFilePipe` with `FileFieldsInterceptor` rejects everything
```ts vulnerable title="DO NOT COPY — src/uploads/uploads.controller.ts"
@Post('profile')
@UseInterceptors(
  FileFieldsInterceptor([
    { name: 'avatar', maxCount: 1 },
    { name: 'banner', maxCount: 1 },
  ]),
)
upload(
  @UploadedFiles(
    // Each validator receives { avatar: [...], banner: [...] }, not a file.
    new ParseFilePipe({ validators: [new MaxFileSizeValidator({ maxSize: 2_000_000 })] }),
  )
  files: Record<string, Express.Multer.File[]>,
) {
  return this.uploads.storeProfile(files)
}
```

```json title="400 Bad Request — for every request, including valid ones"
{ "message": "Validation failed (expected size is less than 2000000)", "statusCode": 400 }
```
:::

The abstract signature admits the shape on purpose — `isValid(file?: TFile | TFile[] | Record<string, TFile[]>)` — so a validator *can* be written to understand a field map. None of the built-ins are. Two ways out:

**Validate per field in the service**, keeping the pipe off the multi-field route:

```ts good title="src/uploads/uploads.service.ts"
import { BadRequestException, Injectable } from '@nestjs/common'
import type { Express } from 'express'
import { MagicBytesValidator } from './magic-bytes.validator.js'

const MAX_BYTES = { avatar: 2 * 1024 * 1024, banner: 5 * 1024 * 1024 }

@Injectable()
export class UploadsService {
  private readonly validator = new MagicBytesValidator({})

  async validateField(field: keyof typeof MAX_BYTES, file?: Express.Multer.File) {
    if (!file) throw new BadRequestException(`${field} is required`)
    if (file.size >= MAX_BYTES[field]) throw new BadRequestException(`${field} is too large`)
    if (!(await this.validator.isValid(file))) {
      throw new BadRequestException(this.validator.buildErrorMessage())
    }
    return file
  }

  async storeProfile(files: Record<string, Express.Multer.File[]>) {
    const avatar = await this.validateField('avatar', files.avatar?.[0])
    const banner = await this.validateField('banner', files.banner?.[0])
    return { avatar: await this.store(avatar), banner: await this.store(banner) }
  }
}
```

**Or write a field-aware validator**, if you want to keep the declarative form:

```ts good title="src/uploads/field-map.validator.ts"
import { FileValidator } from '@nestjs/common'
import type { UploadedFileLike } from './magic-bytes.validator.js'

interface FieldRules {
  rules: Record<string, { maxSize: number }>
}

export class FieldMapSizeValidator extends FileValidator<FieldRules, UploadedFileLike> {
  isValid(value?: UploadedFileLike | UploadedFileLike[] | Record<string, UploadedFileLike[]>) {
    // Only the record shape is meaningful for this validator.
    if (!value || Array.isArray(value) || 'size' in value) return false

    for (const [field, rule] of Object.entries(this.validationOptions.rules)) {
      const files = (value as Record<string, UploadedFileLike[]>)[field] ?? []
      if (files.some((file) => file.size >= rule.maxSize)) return false
    }
    return true
  }

  buildErrorMessage(): string {
    return 'One or more files exceed the limit for their field'
  }
}
```

:::warning `maxCount` is not optional either
`FileFieldsInterceptor([{ name: 'photos' }])` with no `maxCount` accepts an unbounded number of files on that field. Set `maxCount` on every entry, and set `limits.files` as the overall cap.
:::

## Never let the client name the file

### The exploit

`file.originalname` is attacker-controlled text. Using it as a path component is a write-anywhere primitive.

:::danger `originalname` in a path
```ts vulnerable title="DO NOT COPY — src/uploads/uploads.service.ts"
import { Injectable } from '@nestjs/common'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Express } from 'express'

@Injectable()
export class UploadsService {
  async store(file: Express.Multer.File) {
    // join() resolves `..` happily. The name came from the request.
    const destination = join('/srv/app/uploads', file.originalname)
    await writeFile(destination, file.buffer)
    return { path: destination }
  }
}
```
:::

```bash
curl -s -X POST localhost:3000/uploads/avatar \
  -H "authorization: Bearer $TOKEN" \
  -F 'file=@payload.js;filename=../../../srv/app/dist/main.js'
```

```json title="201 Created"
{ "path": "/srv/app/dist/main.js" }
```

Your compiled entry point has been replaced. The variants are all the same bug: `../../.env`, a path into a static directory to plant a script, a Windows path with backslashes, and a name with a NUL byte to truncate an extension check.

### The fix in code

Generate the name yourself. Never sanitize the client's — an allow-list of characters still lets them choose the name, and choosing the name is the problem.

```ts good title="src/uploads/uploads.service.ts"
import { BadRequestException, Injectable } from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { Express } from 'express'
import { MagicBytesValidator } from './magic-bytes.validator.js'

// Outside the web root and outside the deployment directory, so a stored file
// can never be reached as a static asset or as code.
const UPLOAD_ROOT = resolve('/var/lib/app-uploads')

@Injectable()
export class UploadsService {
  async store(file: Express.Multer.File) {
    const { fileTypeFromBuffer } = await import('file-type')
    const detected = await fileTypeFromBuffer(file.buffer)
    const extension = detected && MagicBytesValidator.extensionFor(detected.mime)
    if (!extension) throw new BadRequestException('Unsupported file type')

    // The name is ours. The extension comes from the bytes. The original name
    // is metadata, stored in the database as a string and never used as a path.
    const key = `${randomUUID()}.${extension}`
    const destination = join(UPLOAD_ROOT, key)

    // Defense in depth: prove the resolved path is still inside the root even
    // if the key generation is changed later.
    if (!resolve(destination).startsWith(`${UPLOAD_ROOT}/`)) {
      throw new BadRequestException('Invalid destination')
    }

    await mkdir(UPLOAD_ROOT, { recursive: true })
    // 'wx' fails if the path already exists, so a UUID collision or a race
    // cannot overwrite an existing file.
    await writeFile(destination, file.buffer, { flag: 'wx', mode: 0o640 })

    return { key, originalName: file.originalname }
  }
}
```

`crypto.randomUUID()` is in the standard library — you do not need `uuid` or `nanoid`. Keep `originalname` for display, in a database column, escaped at render time like any other user string.

## Serving the bytes back

Storing the file safely and then serving it carelessly recreates the vulnerability. Three rules:

- **Never serve the upload directory as static content.** `ServeStaticModule` or `express.static()` pointed at an upload path means the attacker chooses both the bytes and the URL.
- **Serve from a different origin.** A stored HTML or SVG file executed on `app.example.test` has your cookies. On `usercontent-example.test` it has nothing. This is the only control that genuinely contains stored XSS.
- **Force download and stop sniffing.** `Content-Disposition: attachment` plus `X-Content-Type-Options: nosniff` means the browser does not render it inline and does not second-guess the type.

```ts good title="src/uploads/uploads.controller.ts"
import { Controller, Get, Header, Param, ParseUUIDPipe, StreamableFile, UseGuards } from '@nestjs/common'
import { createReadStream } from 'node:fs'
import { join } from 'node:path'
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js'
import { UPLOAD_ROOT } from './upload-root.js'

@Controller('uploads')
@UseGuards(JwtAuthGuard)
export class UploadsController {
  // The route parameter is a UUID; ParseUUIDPipe rejects anything that is not
  // one, so there is no path component the caller controls.
  @Get(':key')
  @Header('content-disposition', 'attachment')
  @Header('x-content-type-options', 'nosniff')
  @Header('content-security-policy', "default-src 'none'; sandbox")
  download(@Param('key', ParseUUIDPipe) key: string) {
    // Authorization first: a stored file is an object like any other, and an
    // unguessable key is not an access-control decision.
    return new StreamableFile(createReadStream(join(UPLOAD_ROOT, `${key}.png`)))
  }
}
```

`Content-Security-Policy: default-src 'none'; sandbox` on the download response is the belt to `nosniff`'s braces: even if a browser renders the file, it can load nothing and run nothing. See [Security headers](security-headers.md).

An unguessable key is not authorization — see [Authorization and IDOR](authorization-and-idor.md). If the file belongs to a user, the download route must check that.

## Taking your server off the data path

For anything above a few megabytes, the best upload endpoint receives no bytes at all.

**Streaming to object storage** keeps the memory flat: the multipart stream goes straight to S3 without a buffer. With `diskStorage()` you lose `FileTypeValidator`, so validate the content in a worker after the upload lands and only mark the object usable once it passes.

**Presigned uploads** remove your service from the path entirely. The client asks for a URL, your service authorizes the request and returns a presigned `PUT`, and the browser uploads directly.

```ts good title="src/uploads/presign.service.ts"
import { Injectable } from '@nestjs/common'
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { randomUUID } from 'node:crypto'

@Injectable()
export class PresignService {
  private readonly s3 = new S3Client({})

  async presignAvatar(userId: string) {
    const key = `avatars/${userId}/${randomUUID()}.png`

    const command = new PutObjectCommand({
      Bucket: process.env.UPLOAD_BUCKET,
      Key: key,                        // the key is ours, not the client's
      ContentType: 'image/png',        // signed in: a different type fails
      ContentLength: 2 * 1024 * 1024,  // signed in: a larger body fails
    })

    return {
      key,
      // Short expiry: a leaked URL is a write credential for the bucket.
      url: await getSignedUrl(this.s3, command, { expiresIn: 60 }),
    }
  }
}
```

What makes a presigned upload safe is what you sign into it. A presigned URL with no `ContentLength` is an unbounded write to your bucket, and a key derived from client input is a write-anywhere primitive with a different filesystem. Sign the key, the type and the length; keep the expiry short; and validate the object's real content asynchronously before anything serves it.

## How to verify

```bash
# 1 — oversized is rejected, fast
curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:3000/uploads/avatar \
  -H "authorization: Bearer $TOKEN" -F 'file=@/tmp/big'          # 413

# 2 — a spoofed MIME type is rejected on content
curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:3000/uploads/avatar \
  -H "authorization: Bearer $TOKEN" \
  -F 'file=@/bin/sh;type=image/png;filename=avatar.png'          # 400

# 3 — a traversal filename does not choose the path
curl -s -X POST localhost:3000/uploads/avatar \
  -H "authorization: Bearer $TOKEN" \
  -F 'file=@avatar.png;filename=../../../srv/app/dist/main.js'
```

```json title="201 Created — the name is ignored"
{ "key": "9d4a71c2-4f30-4b7c-9a11-5f0e2d0b7c33.png", "originalName": "../../../srv/app/dist/main.js" }
```

```ts title="test/uploads.e2e-spec.ts"
import { Test } from '@nestjs/testing'
import { readFileSync } from 'node:fs'
import request from 'supertest'
import { AppModule } from '../src/app.module.js'

describe('upload validation', () => {
  let app: import('@nestjs/common').INestApplication
  let token: string

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = moduleRef.createNestApplication()
    await app.init()
    token = await signInAsTestUser(app)
  })

  afterAll(() => app.close())

  const post = () =>
    request(app.getHttpServer()).post('/uploads/avatar').set('authorization', `Bearer ${token}`)

  it('accepts a real PNG', () =>
    post().attach('file', 'test/fixtures/real.png').expect(201))

  it('rejects an oversized file with 413', () =>
    post().attach('file', Buffer.alloc(3 * 1024 * 1024), 'big.png').expect(413))

  it('rejects a non-image announced as an image', () =>
    post()
      .attach('file', Buffer.from([0x4d, 0x5a, 0x90, 0x00]), {
        filename: 'avatar.png',
        contentType: 'image/png',
      })
      .expect(400))

  it('rejects an SVG, which has no magic number', () =>
    post()
      .attach('file', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'), {
        filename: 'x.svg',
        contentType: 'image/svg+xml',
      })
      .expect(400))

  it('ignores the client filename', async () => {
    const response = await post()
      .attach('file', 'test/fixtures/real.png', { filename: '../../evil.js' })
      .expect(201)

    expect(response.body.key).toMatch(/^[0-9a-f-]{36}\.png$/)
    expect(response.body.key).not.toContain('..')
  })

  it('serves the file back as an attachment that cannot execute', async () => {
    const uploaded = await post().attach('file', 'test/fixtures/real.png').expect(201)
    const download = await request(app.getHttpServer())
      .get(`/uploads/${uploaded.body.key.replace('.png', '')}`)
      .set('authorization', `Bearer ${token}`)
      .expect(200)

    expect(download.headers['content-disposition']).toContain('attachment')
    expect(download.headers['x-content-type-options']).toBe('nosniff')
  })

  it('requires authentication', () =>
    request(app.getHttpServer())
      .post('/uploads/avatar')
      .attach('file', 'test/fixtures/real.png')
      .expect(401))

  it('does not leave the upload directory served as static content', () =>
    request(app.getHttpServer()).get('/uploads/../../package.json').expect(404))
})
```

The SVG case and the filename case are the two that get quietly broken by a well-meaning refactor.

## Production considerations

- **Authenticate and authorize the upload route.** An anonymous upload endpoint is free storage and free bandwidth for anybody who finds it, and free hosting for anything they want to distribute under your domain.
- **Rate limit and quota separately.** A per-minute request limit does not stop a hundred 2 MB files an hour, every hour, forever. Track bytes per user per day. See [Rate limiting and abuse](rate-limiting.md).
- **Put user content on its own origin.** It is the one control that contains stored XSS regardless of what got past your validators.
- **Scan asynchronously, gate on the result.** Store with a `pending` flag, scan in a worker, flip to `available` only on a pass. Nothing serves a `pending` object. See [Background jobs with BullMQ](../nestjs-libraries/bullmq.md).
- **Re-encode images.** `sharp` 0.35.4 discards metadata, EXIF GPS coordinates and anything hidden in a trailing chunk. It also normalizes the dimensions, which bounds the decompression cost.
- **Bound the decoder, not just the file.** A 40 KB PNG can decode to gigabytes of pixels. Cap width and height before decoding, never after.
- **Do not log `originalname` unescaped into a terminal or a dashboard.** It is attacker-controlled text and ends up rendered somewhere. See [Safe logging](safe-logging.md).
- **Set the storage directory's ownership and mode deliberately.** `0o640` and a dedicated user means a stored file is not executable and not world-readable, whatever else goes wrong.

## Common mistakes

- **Any `multer@1.x` in the tree.** End of life with known advisories; `npm ls multer` must show 2.x.
- **No `limits` object at all.** `fileSize`, `files`, `fields`, `parts` and `fieldNestingDepth` all default to Infinity.
- **Relying on `MaxFileSizeValidator` alone.** It runs after parsing, so you have already buffered the file you are about to reject.
- **Throwing a plain `Error` from `fileFilter`.** Nest maps multer's own messages and nothing else, so yours reaches the client as a 500.
- **`maxSize` and `limits.fileSize` set to different numbers.** One of the two is then decorative, and `MaxFileSizeValidator` is strictly less than.
- **Omitting `maxCount` on a `FileFieldsInterceptor` field.** That field is unbounded.
- **`ParseFilePipe` with `FileFieldsInterceptor`.** The field map goes whole to each validator, so every request fails. Validate per field.
- **Expecting `FileTypeValidator` to sniff bytes with `diskStorage()`.** There is no `file.buffer`, so it rejects everything.
- **`fallbackToMimetype` or `skipMagicNumbersValidation` to make the above go away.** Both mean trusting the client's string.
- **A bare string `fileType` containing a regex metacharacter.** `'image/svg+xml'` cannot match itself through the `String#match` branch.
- **Accepting SVG as an image.** It is XML that can carry script; there is no magic number to check and no safe inline rendering.
- **Trusting `file.originalname` as a path, or sanitizing it instead of replacing it.** Generate the name with `crypto.randomUUID()`.
- **Taking the extension from the filename rather than from the detected type.**
- **Storing uploads inside the web root or the deployment directory.** The attacker then chooses both the bytes and the URL.
- **Serving uploads with `ServeStaticModule` from the upload path.** Same outcome, one module import.
- **Serving user content from your application origin.** A stored HTML file then runs with your cookies.
- **Treating an unguessable key as authorization.** Keys leak; the download route still needs an ownership check.
- **A presigned URL without `ContentLength` and `ContentType`.** An unbounded, arbitrary-type write to your bucket.
- **Deriving the object key from client input.** Path traversal with a different filesystem.

## Related topics

- [File upload security](../security/file-upload-security.md) — decompression bombs, SSRF through upload-from-URL, and the stored-XSS mechanics.
- [File uploads](../nestjs-request-handling/file-uploads.md) — the four interceptors, multer options and `ParseFilePipeBuilder` in full.
- [Pipes](../nestjs-request-handling/pipes.md) — where `ParseFilePipe` sits among the built-in pipes.
- [Exception filters](../nestjs-request-handling/exception-filters.md) — what happens to an error raised outside multer's own limit table.
- [Authorization and IDOR](authorization-and-idor.md) — the ownership check the download route needs.
- [Security headers](security-headers.md) — `nosniff`, CSP and why they matter on a download response.
- [Rate limiting and abuse](rate-limiting.md) — per-route budgets and byte quotas for upload endpoints.
- [Validation as a security control](validation-as-a-control.md) — the boundary the rest of the payload goes through.
- [Dependency auditing](dependency-auditing.md) — catching a deprecated multer pulled in transitively.
- [Safe logging](safe-logging.md) — why `originalname` must not reach a log unescaped.
- [Background jobs with BullMQ](../nestjs-libraries/bullmq.md) — the worker that scans and re-encodes after the request ends.
- [Streams and buffers](../node/streams-and-buffers.md) — what `memoryStorage()` is actually holding.
