# file-upload

Multer 2 with every limit set, magic-byte content verification, generated
filenames, and storage outside any served directory. The interesting part is not
that uploads work — it is every way this example refuses one.

:::danger
`multer@1.x` is deprecated on npm: *"Multer 1.x is impacted by a number of
vulnerabilities, which have been patched in 2.x."* This example pins
`multer@^2.3.0`. If your project still has 1.x, that is the upgrade to do first.
:::

## What it demonstrates

| Defence | Where | Why |
| --- | --- | --- |
| All seven busboy limits | `src/upload.js` → `LIMITS` | multer's defaults are `Infinity` for most of them |
| Magic-byte sniffing | `src/sniff.js`, `src/verify.js` | `file.mimetype` and `file.originalname` are attacker-controlled strings |
| Quarantine-then-promote | `src/storage.js`, `src/verify.js` | you cannot sniff bytes that have not arrived; the sniff runs *after* multer |
| `crypto.randomUUID()` filenames | `src/storage.js` → `storedName()` | `originalname` never reaches the filesystem |
| Extension from the **sniffed** type | `src/verify.js` | `shell.php.png` cannot become `shell.php` |
| Storage outside the static root | `src/storage.js` | `var/uploads` is a *sibling* of `public/`, not a child |
| Explicit retrieval handler | `src/app.js` → `GET /files/:id` | our Content-Type, `nosniff`, `attachment`, `sandbox` CSP |
| `MulterError` mapping | `src/app.js` → `uploadErrorHandler` | `LIMIT_FILE_SIZE`→413, everything else→400 |
| busboy parse errors mapped to 400 | `src/app.js` | an unparseable body is the client's fault, not a 500 |

## Prerequisites

- Node.js 24 LTS.

## Install and run

```bash
cd examples/file-upload
npm install
npm start
```

```
file-upload listening on http://localhost:3003
  quarantine: …\examples\file-upload\var\quarantine
  accepted:   …\examples\file-upload\var\uploads
```

Override the port with `PORT`, and the storage locations with `UPLOAD_DIR` /
`QUARANTINE_DIR`. Run the tests with `npm test`.

## The limits, and why each one is there

```js
export const LIMITS = {
  fileSize: 2 * 1024 * 1024, // bytes per file
  files: 3,                  // number of file parts
  fields: 10,                // number of non-file fields
  parts: 13,                 // file + field parts combined
  fieldNameSize: 100,        // bytes in a field NAME
  fieldSize: 8 * 1024,       // bytes in a field VALUE
  headerPairs: 32,           // headers parsed per multipart part
}
```

| Limit | multer default | What is unbounded without it |
| --- | --- | --- |
| `fileSize` | `Infinity` | disk, and the time spent writing it |
| `files` | `Infinity` | file handles and disk |
| `fields` | `Infinity` | memory and parse time |
| `parts` | `Infinity` | **the one people forget** — a body of 100 000 tiny fields never trips `fileSize` or `files` |
| `fieldNameSize` | 100 | memory per part header |
| `fieldSize` | 1 MiB | memory per field value |
| `headerPairs` | 2000 | parse time per part |

Read them back from the running server:

```bash
curl -s http://localhost:3003/limits
```

```json
{"limits":{"fileSize":2097152,"files":3,"fields":10,"parts":13,"fieldNameSize":100,"fieldSize":8192,"headerPairs":32},"allowed":["image/png","image/jpeg","image/gif","image/webp","application/pdf"]}
```

## Routes

### `GET /health`

```bash
curl -s http://localhost:3003/health
```

```json
{"status":"ok"}
```

### `POST /uploads/avatar` — one file, disk storage

```bash
curl -s -X POST http://localhost:3003/uploads/avatar \
  -F 'avatar=@./tiny.png;type=image/png'
```

```json
{"data":{"id":"658fca4a-4282-44da-911c-8c180a842ad3.png","originalName":"my photo.png","declaredType":"image/png","detectedType":"image/png","size":70,"storedAs":"658fca4a-4282-44da-911c-8c180a842ad3.png"}}
```

`originalName` is echoed for display. `storedAs` is what exists on disk: a UUID
plus the extension **the sniffer decided on**.

### `POST /uploads/batch` — up to 3 files, images and PDFs

```bash
curl -s -X POST http://localhost:3003/uploads/batch \
  -F 'documents=@./tiny.png;type=image/png' \
  -F 'documents=@./fake.png;type=image/png'
```

```json
{"data":{"accepted":[{"id":"e4205de7-….png","originalName":"tiny.png","declaredType":"image/png","detectedType":"image/png","size":70,"storedAs":"e4205de7-….png"}],"rejected":[{"originalName":"bad.png","reason":"content type not recognized","declaredType":"image/png","detectedType":"unknown"}]}}
```

Each file is judged on its own bytes. Accepted files are kept; rejected ones are
deleted from quarantine.

### `POST /uploads/memory` — memory storage variant

```bash
curl -s -X POST http://localhost:3003/uploads/memory \
  -F 'image=@./tiny.png;type=image/png'
```

```json
{"data":{"id":"494fe709-….png","originalName":"tiny.png","declaredType":"image/png","detectedType":"image/png","size":70,"storedAs":"494fe709-….png","storage":"memory"}}
```

Nothing is written until the sniff passes, which is strictly safer than the disk
route — but it costs `fileSize` bytes of RSS per concurrent upload, so its own
`fileSize` limit is deliberately smaller (1 MiB) and `files` is 1. Use memory
storage when you are going to re-encode or forward the buffer anyway; use disk
storage when files can be large.

### `GET /files/:id` — retrieval

```bash
curl -s -D - -o /dev/null http://localhost:3003/files/658fca4a-….png
```

```
HTTP/1.1 200 OK
Content-Security-Policy: default-src 'none'; sandbox
X-Content-Type-Options: nosniff
Content-Type: image/png
Content-Disposition: attachment; filename="658fca4a-….png"
Cache-Control: private, max-age=0, no-store
```

Deliberately **not** `express.static` over the upload directory: an explicit
handler is the only way to guarantee the `Content-Type` is the one *you*
detected, with `nosniff` so the browser does not overrule it and `attachment` so
nothing renders inside your origin.

### `DELETE /files/:id`

`204` on success, `404` if it is not there.

## Every failure mode, with the curl that produces it

Make the two fixtures first:

```bash
# a real 1x1 PNG
node -e 'require("fs").writeFileSync("tiny.png",Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==","base64"))'
# HTML that is going to claim to be a PNG
node -e 'require("fs").writeFileSync("fake.png","<!doctype html>\n<script>alert(1)</script>\n")'
# 3 MiB, over the 2 MiB limit
node -e 'const f=require("fs");f.writeFileSync("big.png",Buffer.concat([f.readFileSync("tiny.png"),Buffer.alloc(3*1024*1024,65)]))'
```

### 415 — a spoofed content type

```bash
curl -s -w '\nHTTP %{http_code}\n' -X POST http://localhost:3003/uploads/avatar \
  -F 'avatar=@./fake.png;type=image/png;filename=logo.png'
```

```
{"error":{"code":"UNSUPPORTED_MEDIA_TYPE","message":"Rejected: content type not recognized","declaredType":"image/png","detectedType":"unknown"}}
HTTP 415
```

The filename says `.png`. The `Content-Type` says `image/png`. The bytes say
`<!doctype html>`. Only the bytes are checked, so it is rejected and deleted from
quarantine. This is the single most important line in the whole example.

### 413 — over `fileSize`

```bash
curl -s -w '\nHTTP %{http_code}\n' -X POST http://localhost:3003/uploads/avatar \
  -F 'avatar=@./big.png;type=image/png'
```

```
{"error":{"code":"LIMIT_FILE_SIZE","message":"File too large. The limit is 2097152 bytes.","field":"avatar"}}
HTTP 413
```

### 400 — wrong field name

```bash
curl -s -w '\nHTTP %{http_code}\n' -X POST http://localhost:3003/uploads/avatar \
  -F 'wrong=@./tiny.png;type=image/png'
```

```
{"error":{"code":"LIMIT_UNEXPECTED_FILE","message":"Unexpected file, unexpected field name, or a rejected filename.","field":"wrong"}}
HTTP 400
```

### 400 — too many files

```bash
curl -s -w '\nHTTP %{http_code}\n' -X POST http://localhost:3003/uploads/batch \
  -F 'documents=@./tiny.png;type=image/png' -F 'documents=@./tiny.png;type=image/png' \
  -F 'documents=@./tiny.png;type=image/png' -F 'documents=@./tiny.png;type=image/png'
```

```
{"error":{"code":"LIMIT_FILE_COUNT","message":"Too many files. The limit is 3."}}
HTTP 400
```

### 400 — too many fields

```bash
curl -s -w '\nHTTP %{http_code}\n' -X POST http://localhost:3003/uploads/batch \
  $(for i in $(seq 1 25); do printf ' -F k%s=v' "$i"; done) \
  -F 'documents=@./tiny.png;type=image/png'
```

`LIMIT_FIELD_COUNT` (or `LIMIT_PART_COUNT`, whichever trips first).

### 404 — the upload directory is not served

```bash
curl -s -o /dev/null -w 'HTTP %{http_code}\n' http://localhost:3003/public/658fca4a-….png
```

```
HTTP 404
```

`/public` serves `public/`. Uploads live in `var/uploads`, which is a sibling of
`public/`, not a child, so no amount of path manipulation on the static route
reaches them.

## Magic bytes: what this actually proves, and what it does not

`src/sniff.js` holds a small signature table (PNG, JPEG, GIF, WebP, PDF) and
reads only the first 16 bytes of the file. WebP needs a second check, because
`RIFF` alone is a container that could hold audio.

**In production, use `file-type@^22.0.2`.** It knows hundreds of formats and
handles container formats properly:

```js
import { fileTypeFromBuffer } from 'file-type'
const type = await fileTypeFromBuffer(buffer) // { ext, mime } | undefined
```

It is ESM-only, which is fine here — it is left out of this example purely so the
detection logic is visible in the repository instead of hidden behind an import,
and so the example has one fewer dependency.

**And know the limit of the technique.** A valid JPEG can carry a PHP payload in
its EXIF comment; a valid PDF can contain JavaScript. Sniffing proves *"this is a
JPEG"*, never *"this is harmless"*. What makes a hostile-but-well-formed file
inert is the rest of the stack:

- it is stored outside every directory the web server will serve;
- its name is a UUID, so it has no interpreter-triggering extension;
- it comes back with a `Content-Type` you chose, `nosniff`, and `attachment`;
- if you need certainty, re-encode it (`sharp@^0.35.4` for images), which throws
  the original bytes away entirely.

## What to read in the source

`src/sniff.js` first — it is the whole idea in 60 lines of comments and a table.
Then `src/upload.js` for the limits, and `src/verify.js` for the
quarantine → sniff → rename-or-delete flow. `src/app.js`'s `uploadErrorHandler`
at the bottom is where the multer error codes become status codes.

Two findings from writing the tests, both in the comments:

- multer 2 (via busboy) already reduces `originalname` to a basename, so a
  `../../etc/passwd.png` filename arrives as `passwd.png`. That is *not* the
  reason this app is safe — the generated UUID is. Do not rely on it.
- A NUL byte in a multipart part header makes busboy throw a plain `Error`, not a
  `MulterError`. Without the extra branch in the handler that is a 500 for a
  request the client sent wrong.

## Tests

```bash
npm test
```

```
✔ GET /health returns ok
✔ a real PNG is accepted and stored under a generated name
✔ an oversized file is a 413, not a 500
✔ HTML named .png and declared image/png is rejected with 415
✔ PHP named .png and declared image/png is rejected with 415
✔ a traversal filename cannot escape the upload directory
✔ a filename containing a NUL byte is a 400, not a 500
✔ a wrong field name is a 400 LIMIT_UNEXPECTED_FILE
✔ too many files is a 400 LIMIT_FILE_COUNT
✔ too many fields is a 400 LIMIT_FIELD_COUNT
✔ the batch route reports accepted and rejected files separately
✔ the memory-storage route accepts a real image and rejects a fake one
✔ GET /files/:id serves the detected type with nosniff and attachment
✔ GET /files/:id refuses a traversal attempt
✔ uploaded files are not reachable through the static root
ℹ tests 15
ℹ pass 15
ℹ fail 0
```
