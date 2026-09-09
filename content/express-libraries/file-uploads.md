---
title: File uploads
description: Handling multipart uploads with multer 2, enforcing hard limits, sniffing real content types, and storing files without creating a remote code execution path.
status: current
updated: 2026-09-08
---

An upload endpoint hands an anonymous user a way to write bytes to your infrastructure and, often, a URL that serves those bytes back. Treat it as the highest-risk route in the application and design it as an attack surface first and a feature second.

## Why it exists

`multipart/form-data` is a streaming, multi-part encoding that `express.json()` cannot parse. You need a parser that reads the parts, enforces limits as it goes, and either buffers each file or writes it somewhere — that is what multer does.

Everything else on this page is about the decisions multer deliberately leaves to you.

## Installation

:::tabs
@tab npm
```bash
npm install multer@2
```
@tab pnpm
```bash
pnpm add multer@2
```
@tab yarn
```bash
yarn add multer@2
```
:::

:::deprecated
**multer 1.x is end of life and deprecated on npm.** The final 1.x release, `1.4.5-lts.2`, carries the registry deprecation message *"Multer 1.x is impacted by a number of vulnerabilities, which have been patched in 2.x."*

There is no supported 1.x line. If `npm ls multer` shows a `1.x` anywhere in your tree — including transitively — upgrade to 2.3.0. The 2.x API is nearly identical for the common cases.
:::

## Basic example

```js title="src/routes/upload.js"
import { Router } from 'express'
import multer from 'multer'

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 5, parts: 10 },
})

const router = Router()

router.post('/avatar', upload.single('avatar'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'file_required' })
  // req.file: { fieldname, originalname, encoding, mimetype, size, buffer }
  res.status(201).json({ size: req.file.size })
})

export default router
```

Full runnable version: [`examples/file-upload`](../../examples/file-upload/README.md).

The four ways to declare what you accept:

| Call | Result |
| --- | --- |
| `upload.single('avatar')` | One file on that field → `req.file` |
| `upload.array('photos', 8)` | Up to 8 files on that field → `req.files` |
| `upload.fields([{ name: 'avatar', maxCount: 1 }, { name: 'docs', maxCount: 5 }])` | A mix → `req.files` keyed by field name |
| `upload.none()` | Text fields only; any file errors with `LIMIT_UNEXPECTED_FILE` |

`upload.any()` accepts every file on every field. Multer's own documentation warns against it, and so should you: it lets a client attach files to a route that was never designed to handle them.

:::danger
Never register multer as global middleware (`app.use(multer(...).any())`). Every route in your application then accepts uploads, including ones that ignore `req.files` and leave the temporary files behind. Attach it to the specific routes that handle files.
:::

## diskStorage vs memoryStorage

| | `memoryStorage()` | `diskStorage()` |
| --- | --- | --- |
| Where the bytes go | A `Buffer` on `req.file.buffer` | A file on disk, path in `req.file.path` |
| Right for | Small files you immediately re-encode, validate, or forward to object storage | Larger files, or anything you will move/keep on this host |
| Fails by | Exhausting heap — `fileSize × concurrency` is your real RAM requirement | Filling the disk, and leaving orphans when a later step fails |
| Cleanup | Automatic (garbage collection) | **Yours.** Multer does not delete the file if your handler throws |

Memory storage is the better default for images and documents under a few megabytes, because the buffer is exactly what `file-type` and `sharp` want, and because there is no partial file on disk to clean up when validation rejects it.

Neither is right for genuinely large files. See the streaming section below.

```js title="src/upload/storage.js"
import crypto from 'node:crypto'
import path from 'node:path'
import multer from 'multer'

// Outside the web root, on a volume you control.
const UPLOAD_DIR = process.env.UPLOAD_DIR // e.g. /var/lib/app/uploads

export const diskUpload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR, // string form: multer creates it for you
    filename(req, file, cb) {
      // Never derive the name from originalname. See below.
      const ext = path.extname(file.originalname).toLowerCase()
      cb(null, `${crypto.randomUUID()}${/^\.[a-z0-9]{1,8}$/.test(ext) ? ext : ''}`)
    },
  }),
  limits: { fileSize: 20 * 1024 * 1024, files: 1 },
})
```

Note the `filename` callback is a temporary measure here — the extension still comes from the client. The correct version derives it from the sniffed type, which you can only do after the bytes have arrived; see below.

## Hard limits

`limits` is passed straight through to busboy and enforced *while parsing*, so an over-sized upload is aborted mid-stream rather than after you have absorbed it.

| Key | Default | Set it to |
| --- | --- | --- |
| `fileSize` | Infinity | The largest file you actually accept, in bytes |
| `files` | Infinity | The number of files the route expects |
| `fields` | Infinity | The number of non-file fields |
| `parts` | Infinity | `fields + files + 1`, at least |
| `fieldNameSize` | Infinity | 100 |
| `fieldSize` | 1 MB | As small as your largest text field needs |
| `headerPairs` | 2000 | 20 is plenty for a real form |
| `fieldNestingDepth` | Infinity | 1 or 2 |
| `fieldArrayIndexLimit` | Infinity | A small number, if you use `a[0]` field names at all |

```js
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024,
    files: 1,
    fields: 5,
    parts: 8,
    fieldNameSize: 100,
    fieldSize: 16 * 1024,
    headerPairs: 20,
    fieldNestingDepth: 2,
    fieldArrayIndexLimit: 100,
  },
})
```

Every default of `Infinity` is a denial-of-service vector. Without `fields` and `parts`, a client can send a million tiny text parts and keep your process parsing indefinitely. Without `fieldNestingDepth` and `fieldArrayIndexLimit`, a field named `a[b][c][d]…` or `a[999999999]` forces enormous object allocation from a tiny request body.

`parts` triggers **on reaching** the configured number, not on exceeding it, so allow at least one more than your total of fields plus files.

:::warning
Multer's limits are not a body-size limit for the request as a whole. `fileSize: 5MB` with `files: 10` still permits a 50 MB request. Cap the total at the proxy (`client_max_body_size` in nginx) as well.
:::

## Validating the real content type

The two things clients tell you about a file's type are both worthless:

- **`file.mimetype`** is copied verbatim from the `Content-Type` of the multipart part. The client writes it. `image/png` on a PHP script costs nothing.
- **The extension in `file.originalname`** is a string the client chose.

The only signal with any authority is the first few bytes of the file. `file-type` reads those magic numbers.

```bash
npm install file-type@22
```

`file-type` 22.0.2 is **ESM-only**. Your project needs `"type": "module"` (or a dynamic `import()`), which is the right default on Node 24 anyway.

```js title="src/upload/validate.js"
import { fileTypeFromBuffer } from 'file-type'

// Map allowed sniffed MIME -> the extension we will use.
const ALLOWED = new Map([
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp'],
  ['application/pdf', '.pdf'],
])

export async function sniff(buffer) {
  const detected = await fileTypeFromBuffer(buffer)
  if (!detected || !ALLOWED.has(detected.mime)) {
    const error = new Error('unsupported_file_type')
    error.status = 415
    throw error
  }
  return { mime: detected.mime, ext: ALLOWED.get(detected.mime) }
}
```

Two limits of this approach, stated plainly by the library's own documentation:

- **It is a hint, not a guarantee.** Magic bytes say "this begins like a PNG", not "this is a valid, safe PNG". A polyglot file can be a valid GIF *and* a valid HTML document at once.
- **It only covers binary formats.** SVG, CSV, and plain text have no magic number. SVG in particular is XML that can contain `<script>` — if you accept SVG, sanitize it (`sanitize-html` or DOMPurify with an SVG profile) and serve it with `Content-Disposition: attachment`.

For images, the strongest available control is to **re-encode**: pipe the upload through `sharp` and write out a fresh file. Whatever was hidden in the metadata or in a trailing appended archive does not survive a decode-and-re-encode, and you get EXIF stripping (including GPS coordinates) for free.

## Never trust `originalname`

`file.originalname` is a client-supplied string. It has been the source of two decades of path traversal.

```js vulnerable title="DO NOT COPY"
const dest = path.join(UPLOAD_DIR, req.file.originalname)
await fs.writeFile(dest, req.file.buffer)
```

An `originalname` of `../../../../etc/cron.d/pwn`, or `..\\..\\config.json` on Windows, escapes the directory. Multer's `preservePath` option, if enabled, keeps the client's path segments in `originalname` — its documentation is explicit that it does not sanitize them for you.

Even without traversal, `originalname` can be a NUL-embedded string, a name that collides with an existing file, a name that is 4000 characters long, or a name whose extension does not match its contents.

Generate the name yourself:

```js good title="src/upload/store.js"
import crypto from 'node:crypto'
import path from 'node:path'
import fs from 'node:fs/promises'
import { sniff } from './validate.js'

const UPLOAD_DIR = process.env.UPLOAD_DIR

export async function storeUpload(buffer) {
  const { mime, ext } = await sniff(buffer)

  // The name comes from us; the extension comes from the sniffed type.
  const filename = `${crypto.randomUUID()}${ext}`
  const dest = path.join(UPLOAD_DIR, filename)

  // Belt and braces: confirm the resolved path is still inside UPLOAD_DIR.
  if (path.relative(UPLOAD_DIR, dest).startsWith('..')) {
    throw new Error('path_escape')
  }

  await fs.writeFile(dest, buffer, { flag: 'wx' }) // fail if it exists
  return { filename, mime }
}
```

Keep the original name as **data** if users need to see it — a `display_name` column, escaped on output — never as a path component.

## Storing and serving

**Store outside the web root.** If uploads land in a directory that `express.static()` serves, or that your web server maps to a URL, you have handed the attacker a way to place a file at a URL of their choosing. On any stack that can execute files from that directory, that is remote code execution.

Better still: store in object storage (S3, GCS, R2) and keep nothing on the application host. Then the "can this directory execute" question does not arise.

When you do serve uploads from your own process, go through a handler that sets the headers:

```js title="src/routes/files.js"
import path from 'node:path'
import { Router } from 'express'

const router = Router()

router.get('/files/:id', requireAuth, async (req, res) => {
  const record = await findFile(req.params.id)
  if (!record || !userCanRead(req.user, record)) {
    return res.status(404).json({ error: 'not_found' })
  }

  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Content-Type', record.mime) // the SNIFFED mime, from the DB
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(record.displayName)}"`)
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox")

  res.sendFile(path.join(process.env.UPLOAD_DIR, record.filename), { dotfiles: 'deny' })
})

export default router
```

What each header buys you:

- **`X-Content-Type-Options: nosniff`** stops the browser from second-guessing your `Content-Type` and executing something you declared as `application/octet-stream` as HTML or JavaScript.
- **`Content-Disposition: attachment`** makes the browser download rather than render, which neutralizes stored XSS in an uploaded HTML or SVG file.
- **A restrictive `Content-Security-Policy` on the file response** is a second layer for the same problem.
- **The `Content-Type` comes from the sniffed value you stored at upload time**, not from the request and not from the extension.

:::danger
Serving user uploads from your application's own origin means any script that does execute runs with your origin's cookies and local storage. Put uploads on a separate domain (not just a path) when you can — a dedicated `usercontent.example.net` — so a stored XSS cannot reach your session cookies. `Content-Disposition: attachment` is the mitigation when you cannot.
:::

Also note that in Express 5, `express.static()` defaults to `dotfiles: 'ignore'`, so a file named `.htaccess` is not served — but do not rely on that as your only defense against dotfile uploads. Your generated UUID names make it moot.

## Large files: stream, or skip your server entirely

Buffering a 2 GB video into memory or onto the app host's disk is the wrong shape. Two better patterns:

### Stream straight to object storage

```bash
npm install @aws-sdk/client-s3@3 @aws-sdk/lib-storage@3
```

```js title="src/routes/upload-stream.js"
import { Router } from 'express'
import multer from 'multer'
import { S3Client } from '@aws-sdk/client-s3'
import { Upload } from '@aws-sdk/lib-storage'
import crypto from 'node:crypto'

const s3 = new S3Client({ region: process.env.AWS_REGION })
const upload = multer({ limits: { fileSize: 2 * 1024 * 1024 * 1024, files: 1 } })

const router = Router()

router.post('/videos', upload.single('video'), async (req, res) => {
  const key = `videos/${crypto.randomUUID()}`

  const uploader = new Upload({
    client: s3,
    params: {
      Bucket: process.env.UPLOAD_BUCKET,
      Key: key,
      Body: req.file.buffer,
      ContentType: 'application/octet-stream', // never the client's value
    },
  })

  await uploader.done()
  res.status(201).json({ key })
})

export default router
```

`lib-storage`'s `Upload` does multipart uploads with concurrency and retries, which is what you want for anything above a few megabytes.

### Presigned uploads — the better pattern

For large files, take your server off the data path entirely. Your API only issues a short-lived, tightly-scoped URL; the browser `PUT`s directly to the bucket.

```bash
npm install @aws-sdk/client-s3@3 @aws-sdk/s3-request-presigner@3
```

```js title="src/routes/upload-presign.js"
import { Router } from 'express'
import crypto from 'node:crypto'
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

const s3 = new S3Client({ region: process.env.AWS_REGION })
const router = Router()

router.post('/uploads/presign', requireAuth, async (req, res) => {
  const { contentType, contentLength } = req.valid.body // validated, allow-listed

  const key = `u/${req.user.id}/${crypto.randomUUID()}`

  const url = await getSignedUrl(
    s3,
    new PutObjectCommand({
      Bucket: process.env.UPLOAD_BUCKET,
      Key: key, // the KEY is chosen by the server, never by the client
      ContentType: contentType,
      ContentLength: contentLength,
    }),
    { expiresIn: 300 },
  )

  res.json({ url, key })
})

export default router
```

Why this is better: no request body ever crosses your process, so upload size stops being a memory or timeout concern, the transfer does not occupy a Node worker for minutes, and a stalled upload cannot hold a connection open on your server.

What you must still get right:

- **The server picks the key.** If the client supplies it, they overwrite other users' objects.
- **Short `expiresIn`.** Five minutes, not a day.
- **Pin `ContentType` and `ContentLength` in the signed request** so the URL cannot be reused for a different or unbounded object.
- **The bucket is private.** Serve reads through your own signed download URLs after an authorization check.
- **Validate after the fact.** You have not seen the bytes. Verify on an S3 event or on first read: sniff the type, check the size, and mark the record usable only then.

## Virus scanning

For anything users share with each other, magic-byte checks do not detect malware. ClamAV is the usual defense-in-depth layer.

```bash
npm install clamscan@2
```

```js title="src/upload/scan.js"
import NodeClam from 'clamscan'

const clam = await new NodeClam().init({
  clamdscan: { host: process.env.CLAMD_HOST, port: 3310 },
})

export async function assertClean(filePath) {
  const { isInfected, viruses } = await clam.isInfected(filePath)
  if (isInfected) {
    const error = new Error('infected_file')
    error.status = 422
    error.viruses = viruses
    throw error
  }
}
```

Practical notes: run `clamd` as a daemon (a separate container is easiest) rather than spawning `clamscan` per file, keep signatures updated with `freshclam`, and scan **asynchronously** — hold the file in a quarantine location, return 202, and mark it available once the scan passes. A synchronous scan on a large file will blow through your request timeout.

`isInfected` returns `null` for `isInfected` when it could not scan. Treat that as a failure, not a pass.

ClamAV catches known malware. It does not catch a novel payload, and it is not a substitute for the storage and serving rules above.

## Handling MulterError properly

Multer signals limit violations by passing a `MulterError` to `next()`. Without a mapping, they surface as a generic 500 and the client learns nothing.

```js title="src/middleware/upload-errors.js"
import multer from 'multer'

const STATUS = {
  LIMIT_FILE_SIZE: 413,
  LIMIT_FILE_COUNT: 400,
  LIMIT_UNEXPECTED_FILE: 400,
  LIMIT_PART_COUNT: 413,
  LIMIT_FIELD_COUNT: 400,
  LIMIT_FIELD_KEY: 400,
  LIMIT_FIELD_VALUE: 413,
}

export function uploadErrors(err, req, res, next) {
  if (!(err instanceof multer.MulterError)) return next(err)

  res.status(STATUS[err.code] ?? 400).json({
    error: err.code.toLowerCase(),
    field: err.field, // the field name, which is safe to echo
  })
}
```

```js title="src/app.js"
app.use('/api', routes)
app.use(uploadErrors) // before the generic error handler
app.use(genericErrorHandler)
```

The codes you will actually see:

| `err.code` | Cause | Status |
| --- | --- | --- |
| `LIMIT_FILE_SIZE` | A file exceeded `limits.fileSize` | **413** Payload Too Large |
| `LIMIT_FILE_COUNT` | More files than `limits.files` | 400 |
| `LIMIT_UNEXPECTED_FILE` | A file on a field the route did not declare | 400 |
| `LIMIT_PART_COUNT` | More parts than `limits.parts` | 413 |
| `LIMIT_FIELD_COUNT` / `LIMIT_FIELD_KEY` / `LIMIT_FIELD_VALUE` | Field count, name length, or value size limits | 400 / 413 |

Multer also defines `LIMIT_FIELD_NESTING`, `LIMIT_FIELD_ARRAY_INDEX`, `MISSING_FIELD_NAME`, `INVALID_FIELD_NAME` and `STREAM_DESTROYED`; the `?? 400` fallback covers them.

`LIMIT_FILE_SIZE` is worth calling out: it fires when the stream crosses the limit, so with `diskStorage` a partial file may already exist. Multer removes files it wrote for the request it is aborting, but if your own handler already moved one, that copy is yours to clean up.

:::note
Register the upload error handler where the uploads are, not necessarily at the very end. Express matches error middleware in registration order, and you want the multer-specific mapping to run before a generic "something went wrong" handler swallows it.
:::

## Security considerations

**The uploaded file is untrusted input that you also give a URL.** That combination is what makes uploads uniquely dangerous compared to a JSON body.

**Never let the client influence the stored path or filename.** UUID names, server-chosen keys, and a `path.relative` check that the resolved path is still inside the directory.

**Never trust `file.mimetype` or the extension.** Sniff the bytes; re-encode images where you can.

**Never store uploads inside the web root** or anywhere a request can reach them without going through your authorization check.

**Serve with `nosniff`, `Content-Disposition: attachment`, a restrictive CSP, and — ideally — from a separate domain.**

**Authorize downloads.** An unguessable UUID is not an access control; if the file is private, check ownership on read. See [IDOR and broken object-level authorization](../security/broken-object-level-authorization.md).

**Set every limit.** The defaults are `Infinity` for the ones that matter most.

**Rate limit upload endpoints separately and strictly.** An upload costs orders of magnitude more than a normal request.

**Strip metadata.** EXIF in a photo commonly contains GPS coordinates and device identifiers. A `sharp` re-encode removes it.

**Watch out for zip bombs and decompression.** If you unpack archives or process documents, bound the output size and the nesting depth, and do it out of process.

**Beware SVG and HTML.** Both are executable in a browser context. Sanitize or force download.

**Quarantine before publishing.** Especially with presigned uploads, where the file exists before you have inspected it.

The full exploit narrative — polyglot files, double extensions, content-type confusion, and the path from upload to RCE — is in [File upload security](../security/file-upload-security.md).

## Production considerations

**Object storage, not the app host's disk.** Local disk does not survive a container restart, does not work across instances, is not backed up, and fills up. If a file must live on the host, treat that host as stateful and monitor free space.

**Cap the body at the proxy too.** `client_max_body_size` in nginx, or the equivalent, so a 10 GB request is rejected before Node allocates anything. Make it consistent with multer's limits, and make sure the proxy's own timeout is longer than a legitimate slow upload.

**`fileSize × concurrency` is your memory budget** with `memoryStorage()`. Ten concurrent 20 MB uploads is 200 MB of heap and a fast route to an OOM kill.

**Clean up orphans.** With `diskStorage`, a handler that throws after multer wrote the file leaves it behind. Run a scheduled sweep for files with no database row, and delete the row and the object together when a user deletes something.

**Uploads hold a connection for a long time.** That interacts with graceful shutdown — an in-flight 500 MB upload will not drain in your five-second window. Decide whether to wait or to fail it; see [Process management](process-management-and-graceful-shutdown.md).

**Log the outcome, not the file.** Field name, size, sniffed type, user, request ID. Never the buffer, and never the original filename unescaped.

**Test the failure paths.** An over-size file, an unexpected field, a `.png` that is really a shell script, and a filename containing `../`. See [Testing](testing.md).

## Common mistakes

- **Running multer 1.x.** EOL and deprecated with known vulnerabilities.
- **Registering multer globally or using `.any()`.** Every route becomes an upload endpoint.
- **Leaving `limits` unset.** The defaults are unbounded for `fileSize`, `files`, `fields` and `parts`.
- **Setting `fileSize` but not `files` or `parts`.** Ten files at the limit each, or a million tiny parts.
- **Trusting `file.mimetype`.** It is the client's string.
- **Using `originalname` as a path.** Traversal, collision, and NUL bytes.
- **Deriving the extension from the client's filename** instead of the sniffed type.
- **Saving into `public/` or another statically served directory.** Upload-to-RCE.
- **Serving uploads from the app's own origin without `Content-Disposition: attachment`.** Stored XSS with your cookies.
- **Omitting `X-Content-Type-Options: nosniff`.** The browser overrides your `Content-Type`.
- **Letting the client choose the S3 key in a presigned upload.** They overwrite other users' objects.
- **Long `expiresIn` on presigned URLs.** A leaked URL becomes a write primitive for as long as it lives.
- **Treating a `MulterError` as a 500.** `LIMIT_FILE_SIZE` is a 413 and the client can act on it.
- **Assuming an unguessable filename is authorization.**
- **Scanning synchronously in the request.** The request times out on the first large file.

## Related topics

- [File upload security](../security/file-upload-security.md) — polyglots, double extensions, and the path to code execution.
- [`examples/file-upload`](../../examples/file-upload/README.md) — a runnable endpoint with limits, sniffing and error mapping.
- [Validation](validation.md) — validating the text fields that accompany the file.
- [Rate limiting](rate-limiting.md) — bounding the most expensive endpoint you own.
- [Static files](../express/static-files.md) — why the upload directory must not be one of these.
- [IDOR and broken object-level authorization](../security/broken-object-level-authorization.md) — authorizing downloads.
- [Streams and buffers](../node/streams-and-buffers.md) — what `memoryStorage` is actually holding.
