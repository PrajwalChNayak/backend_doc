# nest-file-upload — uploads that check the bytes

`FileInterceptor` with **every** multer limit set, `ParseFilePipe` with
`MaxFileSizeValidator` and a custom `FileValidator` that sniffs real magic
bytes, `crypto.randomUUID()` filenames, and storage outside any static root.

## What it demonstrates

| Thing | Where |
| --- | --- |
| `FileInterceptor('file', { storage, limits, fileFilter })` | `src/files/uploads.controller.ts` |
| All seven multer limits, not just `fileSize` | same file |
| `ParseFilePipe` with `fileIsRequired` and a custom status code | same file |
| `MaxFileSizeValidator` — the second, independent size check | same file |
| A custom `FileValidator` sniffing magic bytes | `src/files/magic-bytes.validator.ts` |
| A signature table for PNG / JPEG / GIF87a / GIF89a / WebP / PDF | same file |
| Generated filenames + the **sniffed** extension | `src/files/uploads.service.ts` |
| Storage outside any static root | same file |
| Nest 12 already maps `MulterError` → 413/400 | `src/app-factory.ts` |
| 11 `node:test` + supertest tests | `test/uploads.test.js` |

## Prerequisites

Node **20.19+ / 22.12+ / 24 LTS**. Nothing else.

## Install, build, run

```bash
cd examples/nest-file-upload
npm install
npm run setup     # = npm run build
npm start
npm test
```

Port **3037** (`PORT`). Files are written to `UPLOAD_DIR`, defaulting to
`<os tmpdir>/nest-file-upload`.

### The multer version, honestly

`@nestjs/platform-express@12.0.1` pins **multer 2.2.0** in its own
`dependencies`. On a fresh install of this example, `npm audit` said:

```
multer  <=2.2.0
Severity: high
multer vulnerable to Denial of Service via crafted multipart field names
multer vulnerable to Denial of Service via file descriptor leak on aborted uploads
multer vulnerable to file size limit bypass via async fileFilter race condition
multer vulnerable to Denial of Service via oversized array index in field names
3 high severity vulnerabilities
```

All four are fixed in **2.3.0**, and one of them — the size-limit bypass through
an async `fileFilter` — is squarely about this example. `npm audit fix --force`
proposes `@nestjs/core@7.5.5`, which is not a fix, it is a four-major-version
downgrade. So this example pins forward instead:

```json
"overrides": { "multer": "^2.3.0" }
```

After that, `npm audit` reports **found 0 vulnerabilities**, and every test and
route below still passes on multer 2.3.0. multer **1.x** is end of life and
npm-deprecated; it is never an option.

## Routes

### `POST /uploads` — multipart, field name `file`

```bash
printf 'GIF89a\x01\x00\x01\x00\x00\xff\x00,\x00\x00\x00\x00\x01\x00\x01\x00\x00\x02\x00;' > tiny.gif
curl -s -X POST http://localhost:3037/uploads -F "file=@tiny.gif;type=image/gif"
```

```json
{"id":"92aeb57b-65f4-46eb-b4f1-2c056df1148e","storedAs":"92aeb57b-65f4-46eb-b4f1-2c056df1148e.gif","type":"GIF89a","mime":"image/gif","size":26,"sha256":"3b7b8a4b411ddf8db9bacc2f3aabf406f8e4c0c087829b336ca331c40adfdff1","originalNameReported":"tiny.gif","uploadedAt":"2026-09-11T18:55:52.920Z"}
```

**Lying about the type does not work:**

```bash
printf 'hello world, not an image' > notes.txt
curl -s -X POST http://localhost:3037/uploads -F "file=@notes.txt;type=image/png"
```

```json
{"message":"File contents match no known signature (the request claimed image/png); allowed: PNG, JPEG, GIF87a, GIF89a, WEBP, PDF","error":"Unprocessable Entity","statusCode":422}
```

**Too big — 413, from the multer limit:**

```bash
curl -s -X POST http://localhost:3037/uploads -F "file=@big.gif;type=image/gif"
```

```json
{"message":"File too large","error":"Payload Too Large","statusCode":413}
```

**Two files — 400, from the `files: 1` limit:**

```bash
curl -s -X POST http://localhost:3037/uploads \
  -F "file=@tiny.gif;type=image/gif" -F "file=@tiny.pdf;type=application/pdf"
```

```json
{"message":"Too many files","error":"Bad Request","statusCode":400}
```

**The wrong field name — 400:**

```bash
curl -s -X POST http://localhost:3037/uploads -F "avatar=@tiny.gif;type=image/gif"
```

```json
{"message":"Unexpected field - avatar","error":"Bad Request","statusCode":400}
```

### `GET /uploads`, `GET /uploads/usage`, `GET /uploads/:id`

```bash
curl -s http://localhost:3037/uploads/usage
```

```json
{"directory":"C:\\Users\\nprajwal\\AppData\\Local\\Temp\\nest-file-upload","files":2,"bytes":74}
```

`:id` is a `ParseUUIDPipe`, so a malformed id is a 400 before any filesystem
call. Note what is **not** here: no route takes a path or a filename from the
caller. Files are addressed by the id the server generated.

## The four defences, and what each one stops

### 1. Every limit, not just `fileSize`

```ts
limits: {
  fileSize: 2 * 1024 * 1024,  // bytes per file
  files: 1,                   // file parts
  fields: 5,                  // non-file fields
  parts: 6,                   // files + fields, total
  fieldNameSize: 100,         // bytes in a field NAME
  fieldSize: 8 * 1024,        // bytes in a non-file field VALUE
  headerPairs: 100,           // multipart header pairs
}
```

`fileSize` alone stops one big file. It does nothing about ten thousand tiny
parts, a field name a megabyte long, or a field value that fills the heap —
each of those is its own denial of service, and three of the four advisories
against multer 2.2.0 are exactly this shape. multer's defaults for most of these
are unlimited.

### 2. `ParseFilePipe` — a second, independent size check

`MaxFileSizeValidator` re-checks the size multer already limited. That is not
redundancy for its own sake: the multer limit is a **stream** limit enforced
while parsing, and the validator is a check on the **result**. If a limit is ever
misconfigured, moved, or bypassed by a parser bug, the second check still holds.

`errorHttpStatusCode: HttpStatus.UNPROCESSABLE_ENTITY` makes validator failures
422 — distinguishable from multer's own 400s and 413s in your logs.

### 3. Magic bytes, because MIME types are claims

`file.mimetype` is copied from the `Content-Type` the client wrote in the
multipart part. The extension is part of a filename the client chose. Neither is
evidence. The first bytes of a file are:

| Type | Bytes | As text |
| --- | --- | --- |
| PNG | `89 50 4E 47 0D 0A 1A 0A` | `.PNG....` |
| JPEG | `FF D8 FF` | |
| GIF87a / GIF89a | `47 49 46 38 37/39 61` | `GIF87a` / `GIF89a` |
| WebP | `52 49 46 46` … `57 45 42 50` at offset 8 | `RIFF` … `WEBP` |
| PDF | `25 50 44 46 2D` | `%PDF-` |

The table is inline on purpose. `file-type@22.0.2` knows hundreds of formats and
is the right dependency for a general-purpose uploader — but it is **ESM-only**,
so a CommonJS Nest build can only reach it through a dynamic `import()`. Six
formats' worth of magic bytes is a table, not a dependency.

**Magic bytes are necessary, not sufficient.** A file that starts with
`89 50 4E 47 0D 0A 1A 0A` and continues with garbage still passes this check —
one of the tests proves it. If you accept images and then serve or process them,
re-encode with `sharp` and store the output: that is the only check that
actually parses the file.

### 4. The filename is generated, and so is the extension

```ts
const storedAs = `${randomUUID()}${detected.extension}`
await writeFile(join(UPLOAD_DIR, storedAs), file.buffer, { flag: 'wx' })
```

The client's filename is stored as a display string and **never** used to build
a path. `../../../etc/passwd.gif`, `..\web.config`, `index.html`, a 4 KB unicode
name, a name that differs only by case from an existing file — none of them can
reach the filesystem. The extension comes from the *sniffed* type, so PDF bytes
named `invoice.png` are stored as `.pdf`. `flag: 'wx'` means a write never
overwrites an existing file.

And the directory itself is outside any static root. If uploads are reachable
from the same origin, a stored SVG or HTML file is stored XSS, and anything the
server might execute is worse. Serve user files from a separate origin, or
through a handler that sets `Content-Type` and
`Content-Disposition: attachment` itself.

## You do not need a multer exception filter in Nest 12

In bare Express you must catch `MulterError` or a limit breach becomes a 500.
`@nestjs/platform-express@12` already does it — from its own
`multer/multer/multer.utils.js`:

```js
case multerExceptions.LIMIT_FILE_SIZE:
  return new PayloadTooLargeException(error.message)   // 413
case multerExceptions.LIMIT_FILE_COUNT:
case multerExceptions.LIMIT_FIELD_KEY:
case multerExceptions.LIMIT_UNEXPECTED_FILE:
case multerExceptions.LIMIT_PART_COUNT:
  return new BadRequestException(...)                  // 400
```

This example originally shipped a `@Catch(MulterError)` filter. It never fired —
the transform happens before any filter sees the error — so it was deleted.
Dead defensive code is worse than none: it looks like the thing keeping you safe.

## One gotcha the tests pin down

A `fileFilter` that rejects a part does **not** produce an error. multer simply
drops the file, so the handler sees no file at all and `ParseFilePipe` answers
*"File is required"*:

```bash
curl -s -X POST http://localhost:3037/uploads -F "file=@notes.txt;type=text/plain"
```

```json
{"message":"File is required","error":"Unprocessable Entity","statusCode":422}
```

That is why the real check is the validator and not the filter: the filter's
message is "there was no file", which is not what happened. Use `fileFilter` as
a cheap pre-screen on the claimed type, and let the validators produce the
answer the client reads.

## Memory storage versus disk storage

This example uses `memoryStorage()`, bounded by `fileSize`, so the validator can
look at the bytes before anything is written. For large uploads, use
`diskStorage` — and then you own the cleanup, because a file rejected by
`ParseFilePipe` has **already been written**:

```ts
@UseInterceptors(FileInterceptor('file', { storage: diskStorage({ … }) }))
async upload(@UploadedFile(new ParseFilePipe({ … })) file: Express.Multer.File) { … }
// on rejection: unlink(file.path) in a filter, or a sweeper for orphans
```

Memory storage with a small limit avoids that whole class of bug. Pick it
deliberately, not by accident.

## Tests

```
✔ GET /health is ok
✔ a real GIF is accepted and stored under a UUID name
✔ a real PDF is accepted
✔ text claiming to be a PNG is rejected by the magic-byte validator
✔ a dangerous filename never reaches the filesystem
✔ a .png filename on PDF bytes is stored as .pdf
✔ an oversize file is a 413 from the multer limit
✔ two files is a 400 from the files limit
✔ an unexpected field name is a 400
✔ no file at all is a 422, not a crash
✔ GET /uploads lists what was stored, and metadata is fetched by id
ℹ tests 11
ℹ pass 11
ℹ fail 0
```

## Related examples

- `examples/file-upload` — the Express 5 version of the same defences.
- `nest-crud-module` — where pipes and validators fit in the request pipeline.
