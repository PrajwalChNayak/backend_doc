---
title: Compression
description: Using the compression middleware correctly, why the proxy is usually the better place to do it, and the BREACH caveat for secret-bearing responses.
status: current
updated: 2026-09-08
---

Compression trades CPU for bandwidth. On a JSON API that returns kilobytes of repetitive text, gzip typically removes 70–90% of the bytes, which is a real latency win on slow connections. It is also the one performance feature that can introduce a cryptographic vulnerability, so it is worth understanding before you enable it globally.

## Why it exists

Node's `zlib` can compress a response, but doing it correctly means negotiating `Accept-Encoding`, choosing an encoding, setting `Content-Encoding` and `Vary`, dropping `Content-Length`, skipping already-compressed formats, and streaming rather than buffering. The `compression` middleware does all of that.

## Installation

:::tabs
@tab npm
```bash
npm install compression@1
```
@tab pnpm
```bash
pnpm add compression@1
```
@tab yarn
```bash
yarn add compression@1
```
:::

## Basic example

```js title="src/app.js"
import express from 'express'
import compression from 'compression'

const app = express()

app.use(compression())

app.get('/items', async (req, res) => {
  res.json(await listItems())
})

export default app
```

Register it **before** the routes whose responses you want compressed. Middleware wraps `res.write`/`res.end`, so anything that has already written cannot be compressed retroactively.

`compression` 1.8.1 supports `gzip`, `deflate` and `br` (Brotli), selected from the client's `Accept-Encoding`.

## How it decides

Three checks run per response:

1. **The client's `Accept-Encoding`.** No supported encoding, no compression. The `enforceEncoding` option (default `identity`) sets the fallback when the header is absent entirely.
2. **The `filter` function.** The default uses the `compressible` module against the response's `Content-Type`, so `application/json`, `text/html` and `text/css` are compressed while `image/png`, `video/mp4` and `application/zip` are not.
3. **The `threshold`.** Default `1kb`. Below that, compression usually makes the response *larger* once the header overhead is counted, and always costs CPU for nothing.

It also never compresses a response carrying `Cache-Control: no-transform`, because compressing would transform the body.

:::note
`threshold` is advisory. When the body size is not known at the time headers are written — which is the case for any streamed response without a `Content-Length` — the middleware assumes it is over the threshold. Set `Content-Length` if you want the threshold respected exactly.
:::

## The `filter` and `x-no-compression`

Some responses must not be compressed even though their content type is compressible: Server-Sent Events, long-poll streams, and any endpoint where you are deliberately avoiding the BREACH problem below. The conventional escape hatch is a request header.

```js title="src/app.js"
import compression from 'compression'

app.use(
  compression({
    threshold: 1024,
    filter(req, res) {
      // Opt-out honoured per request.
      if (req.headers['x-no-compression']) return false

      // Never compress event streams — buffering breaks them.
      if (res.getHeader('Content-Type')?.toString().startsWith('text/event-stream')) {
        return false
      }

      // Fall through to the default content-type check.
      return compression.filter(req, res)
    },
  }),
)
```

The `compression.filter(req, res)` fall-through is the important line. Writing your own content-type list instead means re-deriving the `compressible` database by hand and getting it wrong.

`x-no-compression` is a convention, not a standard — it is useful for debugging and for internal clients, and it is not something an untrusted client should be able to use to force expensive behavior (here it only ever *reduces* work, so it is safe).

Compression buffers output to get a useful window, which is why streaming responses need the opt-out. If you compress an SSE stream, events sit in the compressor until enough bytes accumulate. `res.flush()` — added to the response by this middleware — forces the partial output out, but excluding the route is simpler.

## Compress at the proxy instead

For most production deployments, the answer is: do not do this in Node.

| | In Node (`compression`) | At nginx / a CDN |
| --- | --- | --- |
| CPU cost | Your event loop and your instance | The proxy's, which is built for it |
| Static assets | Compressed on every request | Precompressed once (`gzip_static`, `brotli_static`) |
| Brotli quality | Node's zlib bindings | Usually a tuned native build |
| Config changes | A deploy | A proxy reload |
| Applies to | Only what Node serves | Everything the edge serves |

If you already have nginx, a load balancer, or a CDN in front of the application, enable compression there and leave it off in Node. Compressing twice is not harmful — the middleware skips a response that already has `Content-Encoding` — but it is wasted CPU on the instance you pay for per request.

Keep `compression` in Node when:

- Nothing sits in front of the process (a small service, a container talking directly to clients).
- The proxy terminates TLS but does not compress, and you cannot change it.
- Responses are dynamic and large, and the compression ratio on your specific payload is worth more than the CPU.

Measure it. `curl -s -H 'Accept-Encoding: gzip' -o /dev/null -w '%{size_download}\n'` against the same endpoint with and without the header tells you the ratio; a load test tells you the CPU cost.

## Security considerations

### BREACH and CRIME

Compression works by removing redundancy. That means the compressed length of a response depends on how much its content repeats — including how much an attacker-controlled part of the response matches a secret part of it.

The attack, in outline: the attacker gets your application to reflect a chosen string into a page that also contains a secret (a CSRF token, an API key, part of a session identifier). They guess a prefix of the secret, put the guess in the reflected input, and measure the compressed response size. A correct guess compresses better. Repeat, one character at a time, and the secret is recovered — over TLS, without breaking TLS.

CRIME was the same idea applied to TLS-level compression (now disabled everywhere). BREACH is the HTTP-level version and is still live.

The preconditions are all three of:

1. The response is compressed.
2. It contains a secret.
3. It reflects attacker-controlled input.

:::danger
Remove any one of the three and the attack fails. In order of preference:

- **Do not reflect user input into a response that contains a secret.** This is the real fix.
- **Do not put secrets in response bodies.** A CSRF token in an `httpOnly` cookie is not reachable this way.
- **Mask the secret per response.** Randomize the token's representation (XOR with a per-response nonce) so its compressed length does not correlate with its value. This is what modern CSRF libraries do.
- **Disable compression for that specific route**, via the `filter`. A blunt instrument, but effective and easy to reason about.
- **Rate limit.** The attack needs thousands of requests; a limiter makes it slow and noisy. Not a fix on its own.
:::

For a pure JSON API that returns no attacker-reflected content alongside secrets, compression is safe. The risk lives on HTML pages that echo a search term next to a hidden form token.

### Other considerations

**A zip bomb in reverse.** Compression itself is cheap, but an endpoint that generates enormous responses is still a resource problem — compression makes it cheaper to *send*, which can make an amplification issue worse rather than better. Bound your result sets with pagination.

**`Vary: Accept-Encoding` must be present** or a cache can serve a gzip body to a client that did not ask for one. `compression` sets it; verify it survives your proxy.

**Do not compress already-encrypted or already-compressed bodies.** No benefit, pure CPU. The default filter handles the common types.

**Watch the CPU under load.** Compression is a per-response cost paid on the event loop's behalf in the zlib thread pool. A sudden traffic spike on large responses can saturate the pool and delay unrelated file I/O.

## Production considerations

**Prefer the edge.** Say it once more: if a proxy or CDN is in the path, compress there.

**Precompress static assets.** Bundling with a build step that emits `.gz` and `.br` alongside each file, served by `gzip_static`/`brotli_static`, is strictly better than compressing the same unchanging file on every request.

**Set `threshold` deliberately.** The 1 KB default is sensible. Lowering it to 0 makes small JSON responses bigger and burns CPU.

**Leave `level` alone unless you have measured.** The default (`-1`, roughly level 6) is a good trade. Level 9 costs substantially more CPU for a few percent of size; level 1 is worth considering if you are CPU-bound and bandwidth is cheap.

**Brotli is smaller but slower to compress** at default quality. It is an excellent fit for precompressed static assets and a questionable one for dynamic responses generated per request. Tune it through the `brotli` option if you enable it for dynamic content.

**Exclude streaming routes explicitly.** SSE and long-poll endpoints break or stall when buffered.

**Verify the header, not the config:**

```bash
curl -s -H 'Accept-Encoding: gzip, br' -o /dev/null -D - https://api.example.com/items \
  | grep -i -E 'content-encoding|vary|content-length'
```

**Measure the ratio on your real payloads.** Highly repetitive JSON compresses spectacularly; already-dense binary payloads do not compress at all, and you are paying CPU to learn that on every request.

## Common mistakes

- **Registering `compression()` after the routes.** Responses are already written.
- **Writing a custom `filter` that does not fall through to `compression.filter`.** You silently stop compressing content types you meant to keep.
- **Compressing Server-Sent Events or long-poll responses.** Events are buffered and appear in bursts, or never.
- **Setting `threshold: 0`.** Tiny responses get bigger and cost CPU.
- **Compressing in Node when nginx or the CDN is already doing it.** Wasted cycles on the instance you pay for.
- **Compressing an HTML page that contains both a CSRF token and reflected user input.** That is BREACH.
- **Assuming TLS makes compression safe.** BREACH works over HTTPS; that is the entire point of it.
- **Losing `Vary: Accept-Encoding` at a proxy.** Caches then serve compressed bodies to clients that cannot decode them.
- **Cranking `level` to 9 by default.** Much more CPU, marginal size gain.

## Related topics

- [Performance](../production/performance.md) — where compression sits among the things that actually move latency.
- [CSRF](../security/csrf.md) — the tokens that BREACH targets, and why masking them matters.
- [Security headers with Helmet](security-headers-helmet.md) — the other set of response headers to get right.
- [Static files](../express/static-files.md) — why precompressed assets beat per-request compression.
- [Streams and buffers](../node/streams-and-buffers.md) — why buffering breaks a streaming response.
