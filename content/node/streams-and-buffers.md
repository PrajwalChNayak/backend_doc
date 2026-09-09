---
title: Streams and buffers
description: Backpressure, pipeline, async iteration, Web Stream interop, and the Buffer rules that decide whether large payloads take down your process.
status: current
updated: 2026-09-08
---

Streams let you process data larger than memory, and they are the reason a Node process can serve a 2 GB download on a 512 MB container. Buffers are the byte containers those streams move around. Most stream bugs are really one bug: ignoring backpressure and letting a fast producer fill the heap.

## Why streams exist

```js title="src/bad.js"
const data = await readFile('/var/exports/report.csv')   // whole file into RAM
res.end(data)
```

With a 2 GB file and ten concurrent clients you need 20 GB. Worse, `readFile` completes in one shot, so the process holds each entire buffer until the socket has drained.

```js title="src/good.js"
import { createReadStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'

await pipeline(createReadStream('/var/exports/report.csv'), res)
```

Constant memory, regardless of file size and client count, because the file is only read as fast as the socket accepts bytes. That coupling is **backpressure**.

## How backpressure works

Every stream has a `highWaterMark` — the number of bytes it will buffer internally before it asks the producer to stop. For byte streams the default is 64 KiB in Node 24 (raised from 16 KiB in Node 22); in `objectMode` it is 16 objects.

`writable.write(chunk)` returns `false` when the internal buffer is over the mark. That return value is the entire protocol:

```js title="src/manual.js"
// what pipeline does for you — do not write this by hand
if (!writable.write(chunk)) {
  readable.pause()
  writable.once('drain', () => readable.resume())
}
```

Ignoring the `false` is what turns a slow client into an out-of-memory kill: the reader keeps producing, the writer keeps queueing, and the heap grows until V8 gives up.

:::warning
`readable.pipe(writable)` handles backpressure but **not error propagation or cleanup**. If the destination errors, the source is left open and leaks a file descriptor. Use `pipeline` instead — that is the whole reason it exists.
:::

## `pipeline` is the default tool

```js title="src/compress.js"
import { createReadStream, createWriteStream } from 'node:fs'
import { createGzip } from 'node:zlib'
import { pipeline } from 'node:stream/promises'

await pipeline(
  createReadStream('input.log'),
  createGzip(),
  createWriteStream('input.log.gz'),
)
```

`pipeline` wires backpressure, forwards errors as a rejected promise, and destroys **every** stream in the chain when any of them fails or when the promise is aborted. It also accepts a `signal`:

```js title="src/timeboxed.js"
await pipeline(source, transform, destination, { signal: AbortSignal.timeout(30_000) })
```

For a chain you did not build — where you only need to know when it is done — use `finished`:

```js
import { finished } from 'node:stream/promises'
await finished(someStream)
```

## Reading

### Async iteration

Any `Readable` is an async iterable, and `for await` applies backpressure automatically because the loop body must complete before the next chunk is pulled:

```js title="src/count.js"
import { createReadStream } from 'node:fs'

let bytes = 0
for await (const chunk of createReadStream('big.bin')) {
  bytes += chunk.length
}
```

This is the most readable form for consuming a stream, and errors surface as a normal `throw` you can `try/catch`.

:::note
Breaking out of a `for await` loop early destroys the stream. That is usually what you want — but it means you cannot resume iteration later.
:::

### Collecting a whole stream, deliberately

When the payload is genuinely small and bounded, `node:stream/consumers` does the buffering for you:

```js title="src/body.js"
import { json, text, buffer } from 'node:stream/consumers'

const payload = await json(req)     // only for bounded, small bodies
```

Guard it with a size limit — an unbounded collector on a request stream is a denial-of-service primitive, since a client can stream gigabytes into your heap.

### `Readable.from`

Turn any iterable or async generator into a stream:

```js title="src/rows.js"
import { Readable } from 'node:stream'

// `source` is any async iterable — a cursor, a queue consumer, a generator
async function* toNdjson(source) {
  for await (const row of source) {
    yield JSON.stringify(row) + '\n'
  }
}

const ndjson = Readable.from(toNdjson(source))
```

## Transforming

The cleanest transform in modern Node is an async generator handed straight to `pipeline`:

```js title="src/upper.js"
import { pipeline } from 'node:stream/promises'

await pipeline(
  source,
  async function* (chunks) {
    for await (const chunk of chunks) {
      yield chunk.toString('utf8').toUpperCase()
    }
  },
  destination,
)
```

The class form is still useful when you need to hold state or emit a different number of chunks than you consume:

```js title="src/ndjson.js"
import { Transform } from 'node:stream'

export function parseNdjson() {
  let remainder = ''
  return new Transform({
    readableObjectMode: true,
    transform(chunk, _encoding, callback) {
      const lines = (remainder + chunk.toString('utf8')).split('\n')
      remainder = lines.pop()
      try {
        for (const line of lines) if (line.trim()) this.push(JSON.parse(line))
        callback()
      } catch (err) {
        callback(err)
      }
    },
    flush(callback) {
      try {
        if (remainder.trim()) this.push(JSON.parse(remainder))
        callback()
      } catch (err) {
        callback(err)
      }
    },
  })
}
```

Two details make this correct: the `remainder` handles a JSON object split across chunk boundaries, and `flush` emits the final line when the source ends without a trailing newline.

:::warning
**Chunk boundaries are arbitrary.** A chunk is not a line, a record, or even a whole UTF-8 character. `chunk.toString('utf8')` on a chunk that ends mid-character produces a replacement character. Use `readable.setEncoding('utf8')` or `node:string_decoder`'s `StringDecoder`, both of which hold the partial bytes until the next chunk.
:::

## Web Streams interop

`fetch` gives you a WHATWG `ReadableStream`, not a Node `Readable`. Convert at the boundary:

```js title="src/proxy.js"
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const upstream = await fetch(url, { signal: AbortSignal.timeout(10_000) })
if (!upstream.ok) throw new Error(`upstream ${upstream.status}`)

await pipeline(Readable.fromWeb(upstream.body), res)
```

`Readable.toWeb()`, `Writable.fromWeb()` and `Writable.toWeb()` cover the other directions. Prefer Node streams inside your application and convert only where a Web API forces it — the Node ecosystem, including Express, speaks Node streams.

## Buffers

A `Buffer` is a `Uint8Array` subclass with extra helpers, so every `TypedArray` method already works on it and any API that accepts a `Uint8Array` accepts a `Buffer`.

| Constructor | Behavior |
| --- | --- |
| `Buffer.from(string, encoding)` | copies the encoded bytes |
| `Buffer.from(arrayBuffer)` | **shares** memory with the ArrayBuffer — no copy |
| `Buffer.alloc(size)` | allocates and **zero-fills** |
| `Buffer.allocUnsafe(size)` | allocates without clearing — faster, contains whatever was in memory |

:::danger
`Buffer.allocUnsafe(n)` returns memory that has not been cleared. If you allocate 4 KiB, fill 100 bytes and send the whole buffer, you transmit ~4 KiB of whatever previously occupied that memory — other users' request bodies, tokens, decrypted data. Use `Buffer.alloc()` unless you are about to overwrite every byte, and then slice to the length you actually wrote.
:::

### Encodings

| Encoding | Notes |
| --- | --- |
| `utf8` | default; multi-byte, so `.length` in bytes ≠ string length |
| `hex` | two characters per byte |
| `base64` | standard alphabet with `+`, `/`, `=` |
| `base64url` | URL-safe alphabet, no padding — use this in tokens and query strings |
| `latin1` | one byte per character, lossless byte round-trip |
| `ucs2` / `utf16le` | 2 bytes per code unit |

```js
Buffer.from('héllo').length      // 6 bytes
'héllo'.length                   // 5 characters
```

Getting this wrong is how `Content-Length` ends up short and the response truncates. Use `Buffer.byteLength(str)` when you need the byte count.

### Slicing shares memory

`buf.subarray(start, end)` returns a **view** over the same memory — writing through it modifies the original. Copy explicitly with `Buffer.from(buf.subarray(0, n))` when you need independence. (`buf.slice()` is the deprecated alias; prefer `subarray`.)

`Buffer.concat(list, totalLength)` allocates a new buffer. Passing `totalLength` when you know it avoids a second pass.

### Constant-time comparison

```js title="src/token.js"
import { timingSafeEqual } from 'node:crypto'

export function tokensMatch(a, b) {
  const bufA = Buffer.from(a, 'utf8')
  const bufB = Buffer.from(b, 'utf8')
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}
```

`===` on secrets returns early at the first differing byte, which leaks how much of a guess was correct. `timingSafeEqual` requires equal lengths, hence the guard.

## Streaming a file to an HTTP response

```js title="src/download.js"
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import path from 'node:path'

const ROOT = path.resolve('/srv/exports')

export async function download(req, res) {
  const target = path.resolve(ROOT, req.params.name)
  if (target !== ROOT && !target.startsWith(ROOT + path.sep)) {
    return res.status(400).json({ error: 'invalid path' })
  }

  const info = await stat(target)
  res.setHeader('Content-Type', 'text/csv')
  res.setHeader('Content-Length', info.size)
  res.setHeader('Content-Disposition', 'attachment; filename="export.csv"')

  await pipeline(createReadStream(target), res)
}
```

Three things earn their place here. The containment check stops `../../etc/passwd` (see [Files and paths](./fs-and-path.md)). `Content-Length` from `stat` lets the client show a progress bar. And `pipeline` destroys the file stream if the client disconnects mid-download — without it, every abandoned download leaks a file descriptor until the process hits `EMFILE`.

:::note
Once the first byte is written you cannot change the status code — the headers are already on the wire. Do every check that can fail (existence, authorization, path containment) *before* you start piping. An error after that point can only close the connection.
:::

## Common mistakes

- **Using `.pipe()` in application code.** It leaks the source on a destination error. Use `pipeline` from `node:stream/promises`.
- **Ignoring the `false` from `write()`.** The classic unbounded-memory bug.
- **Buffering a whole upload or response "for now".** It works in development with a 2 KB fixture and dies in production.
- **Assuming a chunk is a line or a record.** Chunks split anywhere, including mid-character. Buffer the remainder.
- **`Buffer.allocUnsafe` without overwriting every byte.** You leak process memory to the client.
- **`Buffer.concat` in a loop.** Quadratic copying. Collect chunks in an array and concat once.
- **Confusing string length with byte length.** Non-ASCII makes them differ; use `Buffer.byteLength`.
- **Sending an error response after streaming started.** Headers are gone; you can only destroy the connection.
- **Mutating a `subarray` and being surprised the original changed.** It is a view, not a copy.
- **Mixing Web Streams and Node streams ad hoc.** Convert once at the boundary with `Readable.fromWeb` / `toWeb`.

## Related topics

- [Files and paths](./fs-and-path.md) — `createReadStream`, and the containment check used above.
- [The http module](./the-http-module.md) — `req` and `res` are streams; how that shapes request handling.
- [Async/await and promises](./async-await-and-promises.md) — async iteration and `AbortSignal`.
- [Runtime and the event loop](./runtime-and-event-loop.md) — why streaming keeps the loop responsive.
- [File uploads](../express-libraries/file-uploads.md) — streaming multipart bodies instead of buffering them.
- [Compression](../express-libraries/compression.md) — gzip and Brotli as a transform in the response pipeline.
