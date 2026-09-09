---
title: HTTPS and TLS
description: Terminating TLS at a proxy, getting trust proxy right, ACME renewal against Express 5's dotfiles default, and the TLS options that matter when Node terminates it itself.
status: current
updated: 2026-09-09
---

In almost every production deployment, your Node process should never see a TLS handshake. A proxy, load balancer, or ingress terminates TLS and forwards plaintext HTTP over a private network, and your application's entire TLS responsibility collapses into one setting: telling Express which forwarded headers to believe.

That setting is where the security bugs are. Getting `trust proxy` wrong turns `req.secure` into a client-controlled boolean and `req.ip` into a value the attacker picks, which breaks the two controls most likely to be built on top of them.

## Terminate TLS at the proxy

| | TLS at the proxy | TLS in Node |
| --- | --- | --- |
| Certificate renewal | the proxy's job, no app restart | your job, needs a reload path |
| Cipher and protocol policy | one place, one team, audited | duplicated in every service |
| Security patches for the TLS stack | proxy release | Node release, plus your redeploy |
| Handshake CPU | on the proxy, which is sized for it | on your event loop, competing with request handling |
| HTTP/2 and HTTP/3 | usually free | HTTP/2 needs `node:http2`; Express is an HTTP/1 app |
| OCSP stapling, session resumption | usually free | configuration you own |
| Health checks and draining | built in | you write it |

Terminate at the edge because TLS configuration is a specialty and it rots: a cipher suite that was fine two years ago is a finding today. One proxy config that one team keeps current beats twelve services each pinning their own `ciphers` string.

The cases where Node genuinely terminates TLS are narrow: a single-box deployment with no proxy, mutual TLS where the application itself must inspect the client certificate, or a development setup that needs a real `https://` origin for a browser API. There is a working example for those at the end of this page.

:::warning
"Terminate at the proxy" means the hop from proxy to Node is plaintext. That is acceptable only when the hop is a private network you control. Across a shared network, a public cloud VPC boundary you do not trust, or between availability zones with a compliance requirement, re-encrypt — most proxies support an HTTPS backend, and the app-side cost is the same `node:https` server shown below.
:::

## `trust proxy`, `req.secure`, and what breaks when it is wrong

Behind a proxy, the TCP peer is the proxy. Without configuration, Express reports the proxy's address as `req.ip`, `http` as `req.protocol`, and `false` for `req.secure` — on every request, for every user.

```js good title="src/app.js"
// The number is how many proxies sit between the client and this process.
// One ALB, or one nginx, or one CDN = 1. Count them; do not guess.
app.set('trust proxy', 1)
```

With a hop count, Express reads `X-Forwarded-For` from the right and takes the address that many entries in — the one your own proxy wrote. `req.protocol` and `req.secure` start reading `X-Forwarded-Proto` the same way, and `req.hostname` reads `X-Forwarded-Host`.

:::note
Express 5 changed `req.host` to include the port; `req.hostname` still does not. Build redirect URLs from `req.hostname`, or a `https://app.example.com:8443` redirect turns into `https://app.example.com:8443:8443`.
:::

### The spoofed `X-Forwarded-Proto`

**The threat.** The numeric form of `trust proxy` trusts by **position**, not by identity. `trust proxy: 1` means "believe the first hop", whoever that hop turns out to be. If your application port is reachable without going through the proxy — a debug port left open, a security group that allows the whole VPC, a Kubernetes service exposed more widely than intended, a developer port-forward — the attacker is the first hop.

:::danger
```js vulnerable title="DO NOT COPY — app reachable on :3000 as well as through the LB"
app.set('trust proxy', 1)

app.use((req, res, next) => {
  if (!req.secure) return res.redirect(301, `https://${req.hostname}${req.originalUrl}`)
  next()
})

app.post('/login', async (req, res) => {
  const session = await createSession(req.body)
  // Express refuses to set a `secure` cookie on a connection it thinks is plain HTTP,
  // so this "works" — which is the problem.
  res.cookie('sid', session.id, { httpOnly: true, secure: true, sameSite: 'lax' })
  res.json({ ok: true })
})
```
:::

**The exploit.** One header, sent straight to the app port:

```bash
$ curl -sD - -o /dev/null http://10.0.4.19:3000/login -X POST \
    -H 'content-type: application/json' -d '{"email":"ann@example.com","password":"…"}'
HTTP/1.1 301 Moved Permanently
Location: https://app.example.com/login

$ curl -sD - -o /dev/null http://10.0.4.19:3000/login -X POST \
    -H 'X-Forwarded-Proto: https' \
    -H 'content-type: application/json' -d '{"email":"ann@example.com","password":"…"}'
HTTP/1.1 200 OK
set-cookie: sid=8f2a1c94b7e0d3; Path=/; HttpOnly; Secure; SameSite=Lax
```

The redirect is gone, the session cookie was issued over cleartext, and the `Secure` attribute is a label on a value the network already saw.

**The fix has two parts, and you need both.**

1. **Make the app unreachable except through the proxy.** A network control, not an application one: bind to the loopback or the pod network, and close the port at the security group or network policy. This is the fix that actually holds.

```js good title="src/server.js"
import app from './app.js'

const port = Number(process.env.PORT ?? 3000)
const host = process.env.BIND_HOST ?? '127.0.0.1'   // not 0.0.0.0

app.listen(port, host, (err) => {
  if (err) throw err
  console.log(`listening on ${host}:${port}`)
})
```

2. **Trust by address, not by position, when the topology allows it.** Given a proxy on a known subnet, name it:

```js good title="src/app.js"
// Believe X-Forwarded-* only when the TCP peer is one of these.
app.set('trust proxy', ['127.0.0.1', '10.0.0.0/8'])
```

Now a request arriving from anywhere else has its forwarded headers ignored: `req.secure` is `false`, the redirect fires, and the `Secure` cookie is refused.

:::note
`app.listen()` in Express 5 passes a server `'error'` to the callback instead of throwing, which is why the callback above checks `err`. A port that is already in use otherwise fails silently.
:::

### The rate-limit failure

The same setting decides `req.ip`, and both directions of getting it wrong are damaging.

| Setting | Behind a load balancer | Directly reachable |
| --- | --- | --- |
| default (`false`) | every user shares the balancer's IP — one abusive client 429s your entire user base | correct |
| `true` | Express takes the **left-most** `X-Forwarded-For` entry, which is pure client input — one fresh bucket per invented header value | wide open |
| a hop count | correct | trusts whoever connects first |
| an address or subnet list | correct | correct |

```bash
# Against `trust proxy: true`, the limiter is a decoration.
$ for i in $(seq 1 500); do
    curl -s -o /dev/null -H "X-Forwarded-For: 203.0.113.$((RANDOM % 254 + 1))" \
      https://api.example.com/login -X POST -d '{"email":"a@b.c","password":"guess"}'
  done
```

Five hundred login attempts, no 429, because every request landed in its own bucket. The full treatment — including the IPv6 subnet problem, where one customer's /64 gives them eighteen quintillion buckets — is in [Rate limiting](../express-libraries/rate-limiting.md).

**Verify what Express actually believes**, through the real proxy, not against localhost:

```js good title="src/routes/debug.js"
// Register behind authentication, or only outside production.
router.get('/debug/proxy', (req, res) => {
  res.json({
    ip: req.ip,
    ips: req.ips,
    protocol: req.protocol,
    secure: req.secure,
    hostname: req.hostname,
    forwardedFor: req.get('x-forwarded-for') ?? null,
    forwardedProto: req.get('x-forwarded-proto') ?? null,
  })
})
```

```bash
$ curl -s https://api.example.com/debug/proxy | jq
{"ip":"203.0.113.44","ips":["203.0.113.44"],"protocol":"https","secure":true,
 "hostname":"api.example.com","forwardedFor":"203.0.113.44","forwardedProto":"https"}
```

`ip` must be the real client address. If it is your balancer's, the hop count is too low; if it changes when you send your own `X-Forwarded-For`, it is too high.

## Redirect HTTP to HTTPS — and why that is not HSTS

**The threat.** A plaintext request happens, once, before the redirect is even considered. The redirect tells a well-behaved client what to do next; it does nothing about what already crossed the network.

```js good title="src/middleware/https-only.js"
export function httpsOnly(req, res, next) {
  if (req.secure) return next()

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    // The body already crossed the network in the clear. A redirect cannot unsend it,
    // and following one would send it a second time. Fail instead.
    return res.status(400).json({ error: 'https_required' })
  }

  res.redirect(301, `https://${req.hostname}${req.originalUrl}`)
}
```

Two Express 5 details in four lines: `res.redirect(status, url)` takes the status **first** (Express 4 had it last), and `req.hostname` excludes the port while `req.host` now includes it.

**Why it is not a substitute for HSTS.** The redirect is delivered over the channel the attacker controls. On a hostile network they answer the plaintext request themselves and never send it, serving a cleartext copy of your login page and proxying the credentials upstream. HSTS moves the decision into the browser, *before* the request leaves:

| | HTTP→HTTPS redirect | HSTS |
| --- | --- | --- |
| Where the upgrade decision is made | your server, after a plaintext round trip | the browser, before any request |
| Survives an active network attacker | no | yes, once the policy is cached |
| Works on the first-ever visit | n/a — that is the exposed request | only if preloaded |
| Needed | yes, to bootstrap the policy | yes, to close the window |

You need both. The redirect is how a browser that has never visited you gets to HTTPS and receives the HSTS header in the first place. The `Strict-Transport-Security` header itself, and the real cost of `preload`, are covered in [Security headers](security-headers.md).

:::warning
HSTS is ignored when it arrives over plain HTTP, by design. Setting it on the redirect response accomplishes nothing — it has to be on the HTTPS response.
:::

## Certificates: issuance and renewal with ACME

ACME is the protocol behind Let's Encrypt and most other automated CAs. You prove control of a name, you get a certificate, and a client renews it on a timer. Let's Encrypt certificates are valid for 90 days and clients renew at roughly 30 days remaining, which means renewal runs often enough that a broken renewal path is discovered by an outage rather than by a warning.

| Challenge | Proves control by | Needs | Works for wildcards |
| --- | --- | --- | --- |
| HTTP-01 | serving a token at `/.well-known/acme-challenge/<token>` on port 80 | inbound port 80 | no |
| DNS-01 | publishing a `_acme-challenge` TXT record | DNS API credentials | **yes** |
| TLS-ALPN-01 | a special certificate during the handshake on port 443 | inbound port 443, ALPN support | no |

If a proxy terminates TLS, the proxy owns ACME and none of this reaches Node. Caddy does it automatically, nginx is usually paired with certbot, and `cert-manager` handles it in Kubernetes. Prefer DNS-01 where you can: it needs no inbound port, it works for wildcards, and it is immune to the trap below.

### The Express 5 trap that breaks HTTP-01 renewal

**The threat.** Not an attack — an outage, and a particularly nasty one because it is invisible until the certificate expires.

`express.static()` in Express 5 defaults to `dotfiles: 'ignore'`, and the check now applies to hidden **directories** anywhere in the path, not just the final filename. `/.well-known/acme-challenge/<token>` contains a dot-directory, so it returns 404.

:::danger
```js vulnerable title="DO NOT COPY — renewal silently 404s"
import express from 'express'

const app = express()
app.use(express.static('public'))     // dotfiles: 'ignore' → /.well-known/... is 404
```
:::

**The exploit is the calendar.** Issuance worked on Express 4. You upgraded. Everything passed. Sixty days later:

```bash
$ curl -sI http://app.example.com/.well-known/acme-challenge/probe-token
HTTP/1.1 404 Not Found

$ certbot renew
Failed authorization procedure. app.example.com (http-01): urn:ietf:params:acme:error:unauthorized
```

Thirty days after that, every client rejects your certificate.

**The fix.** Mount `/.well-known` explicitly with `dotfiles: 'allow'`, before the general static handler:

```js good title="src/app.js"
import express from 'express'

const app = express()

// Express 5 defaults express.static() to dotfiles: 'ignore', which 404s the
// ACME HTTP-01 challenge path. This mount is what keeps renewal working.
app.use('/.well-known', express.static('public/.well-known', { dotfiles: 'allow' }))

app.use(express.static('public'))
```

Scope it to `/.well-known` and nothing wider. `dotfiles: 'allow'` on your whole `public` directory serves `.env`, `.git/config`, and every other dotfile that ends up in a deploy artifact.

**Verify it before you need it.** Drop a file and fetch it:

```bash
$ mkdir -p public/.well-known/acme-challenge
$ echo ok > public/.well-known/acme-challenge/probe
$ curl -s http://app.example.com/.well-known/acme-challenge/probe
ok
```

Then make it a test, because this breaks on an upgrade and nothing else will catch it:

```js title="test/acme.test.js"
import { test } from 'node:test'
import assert from 'node:assert/strict'
import request from 'supertest'
import app from '../src/app.js'

test('the ACME challenge path is served', async () => {
  const res = await request(app).get('/.well-known/acme-challenge/probe')
  assert.equal(res.status, 200)
})
```

`/.well-known` carries more than ACME — `security.txt`, `change-password`, app-association files for mobile deep links, and OIDC discovery documents all live there and all hit the same 404.

## TLS versions and ciphers

TLS 1.0 and 1.1 are deprecated and removed from current browsers. Serve 1.2 and 1.3 only.

Node's own default minimum is already TLS 1.2, and TLS 1.3 negotiates its own fixed cipher suites, so on a modern Node there is very little to configure — which is the point. State the floor explicitly anyway, because it documents the intent and it survives someone lowering a default:

```js good title="src/server.js"
const tlsOptions = {
  minVersion: 'TLSv1.2',
  // Node's default suites are already sensible. Only pin `ciphers` if a
  // compliance regime names specific suites — a hand-written list rots.
  honorCipherOrder: true,
}
```

Prefer ECDSA certificates over RSA where your clients allow it: smaller handshakes, less CPU. Keep an RSA certificate alongside only if you must serve genuinely ancient clients, and know that "must" is usually an assumption nobody has measured.

If a proxy terminates TLS, none of this is yours — but it is still someone's, and "the load balancer's default policy" is a decision whether or not anyone made it deliberately. Look up which policy your balancer is on and when it was last updated.

## mTLS for service-to-service

**The threat.** Inside a private network, most services authenticate callers with a shared bearer token, or with nothing at all. One compromised pod, one leaked token in an environment variable, and every internal API is reachable.

Mutual TLS makes the transport itself carry identity: the client presents a certificate, the server verifies it against a private CA, and an unauthenticated connection never completes a handshake.

```js good title="src/internal-server.js"
import https from 'node:https'
import { readFileSync } from 'node:fs'
import app from './app.js'

const server = https.createServer(
  {
    key: readFileSync('/etc/tls/server-key.pem'),
    cert: readFileSync('/etc/tls/server-cert.pem'),
    ca: readFileSync('/etc/tls/internal-ca.pem'),   // the ONLY issuer accepted
    requestCert: true,
    rejectUnauthorized: true,                        // no certificate → no connection
    minVersion: 'TLSv1.2',
  },
  app,
)

server.listen(8443)
```

Authentication is not authorization. The handshake proves the caller holds a key your CA vouched for; deciding *which* service that is, and what it may do, is a separate check on the certificate's subject:

```js good title="src/middleware/require-service.js"
const ALLOWED = new Map([
  ['billing.internal', ['POST /invoices', 'GET /invoices']],
  ['reports.internal', ['GET /invoices']],
])

export function requireService(req, res, next) {
  const cert = req.socket.getPeerCertificate()
  const cn = cert?.subject?.CN
  const allowed = cn ? ALLOWED.get(cn) : undefined

  if (!allowed) return res.status(403).json({ error: 'unknown_client' })
  if (!allowed.includes(`${req.method} ${req.baseUrl}`)) {
    return res.status(403).json({ error: 'not_permitted' })
  }

  req.callerService = cn
  next()
}
```

:::danger
When a proxy or service mesh terminates mTLS on your behalf, it forwards the verified identity in a header — `X-Client-Cert`, `X-Forwarded-Client-Cert`, `ssl-client-verify`, whatever your mesh calls it. That header is exactly as trustworthy as `X-Forwarded-Proto`: if anything can reach your port without passing through the mesh, a caller sets it themselves and becomes `billing.internal`.

```bash
$ curl -s http://10.0.4.19:8080/invoices -H 'X-Client-Cert-CN: billing.internal'
[{"id":"inv_9912","amount":48000,"customer":"acme"}]
```

Strip these headers at the ingress on every inbound request before the mesh sets them, and close the port to everything else.
:::

**Verify it.** A client with no certificate must fail the handshake, not receive a 403:

```bash
$ curl -s https://billing.internal:8443/invoices
curl: (56) OpenSSL SSL_read: error:0A00045C:SSL routines::tlsv13 alert certificate required

$ curl -s --cert client.pem --key client-key.pem --cacert internal-ca.pem \
    https://billing.internal:8443/invoices
[{"id":"inv_9912","amount":48000,"customer":"acme"}]
```

Rotation is the operational cost. Internal certificates are usually short-lived, so every service needs a reload path — see `setSecureContext` below — and a monitor for expiry. A mesh that issues and rotates them for you is worth the complexity precisely because doing it by hand is where mTLS deployments die.

## Certificate pinning

**What it defends against.** A certificate issued for your domain by a CA you never chose — a compromised or coerced CA, or a corporate TLS-inspecting middlebox whose root is installed on the device.

**What it costs.** Every pinning failure is an outage you cannot fix by deploying the server, because the client is the one refusing.

:::warning
HPKP, the browser-facing version of this (`Public-Key-Pins`), was removed from browsers years ago for exactly this reason: a site could pin itself off the internet, permanently, with one bad deploy. There is no browser pinning mechanism to reach for. Pinning today means a native or server-side client that you control.
:::

In Node, a client pins by checking the peer certificate itself:

```js good title="src/lib/pinned-fetch.js"
import https from 'node:https'
import { createHash } from 'node:crypto'

// SPKI hashes, not certificate fingerprints: the SPKI survives renewal when the
// key is reused, a certificate fingerprint changes every 90 days.
const PINS = new Set([
  'YLh1dUR9y6Kja30RrAn7JKnbQG/uEtLMkBgFF2Fuihg=',  // current key
  '5C8kvU039KouVrl52D0eZSGf4Onjo4Khs8tmyTlV3nU=',  // backup key, already generated
])

const agent = new https.Agent({
  checkServerIdentity(host, cert) {
    const spki = createHash('sha256').update(cert.pubkey).digest('base64')
    if (!PINS.has(spki)) {
      return new Error(`certificate public key ${spki} is not pinned for ${host}`)
    }
    return undefined   // undefined means "identity accepted"
  },
})

export const partnerAgent = agent
```

Three rules if you pin at all:

- **Pin the SPKI, not the leaf certificate.** A certificate fingerprint changes at every renewal, which on a 90-day certificate means four self-inflicted outages a year.
- **Always ship a backup pin** for a key you have already generated and stored offline. A single pin means a key compromise and an outage are the same event.
- **Have a kill switch.** A remote configuration flag that disables pinning, reachable over a path that is not itself pinned, is the difference between a bad afternoon and a recalled mobile release.

For most services, pinning is the wrong trade. Certificate Transparency monitoring — alerting when any CA logs a certificate for your domain — gives you detection without the outage risk, and it covers names you forgot you owned.

## Terminating TLS in Node

For the narrow cases where the process really does own the handshake:

```js good title="src/server.js"
import https from 'node:https'
import http from 'node:http'
import { readFileSync } from 'node:fs'
import app from './app.js'

const options = {
  key: readFileSync(process.env.TLS_KEY_PATH),
  cert: readFileSync(process.env.TLS_CERT_PATH),   // fullchain: leaf + intermediates
  minVersion: 'TLSv1.2',
  honorCipherOrder: true,
}

const server = https.createServer(options, app)
server.listen(443, () => console.log('https on :443'))

// Port 80 exists only to bootstrap: redirect, and serve the ACME challenge.
http
  .createServer((req, res) => {
    if (req.url?.startsWith('/.well-known/acme-challenge/')) return app(req, res)
    res.writeHead(301, { Location: `https://${req.headers.host}${req.url}` })
    res.end()
  })
  .listen(80)

// Renewal replaces the files on disk. Reload without dropping connections.
process.on('SIGHUP', () => {
  server.setSecureContext({
    key: readFileSync(process.env.TLS_KEY_PATH),
    cert: readFileSync(process.env.TLS_CERT_PATH),
    minVersion: 'TLSv1.2',
  })
})
```

Four things that are easy to get wrong here:

- **`cert` must be the full chain**, leaf first then intermediates. A leaf alone works in your browser, which already cached the intermediate, and fails for everyone else. This is the single most common "works on my machine" TLS bug.
- **`setSecureContext` is what makes renewal survivable.** Without it, a renewed certificate needs a process restart, and a restart every 90 days on a schedule nobody owns is a future outage.
- **Read the key from a path, not from an environment variable.** A PEM in the environment shows up in process listings, crash dumps, and `/proc`. See [Secrets management](secrets-management.md).
- **Binding port 443 needs privileges.** Grant the capability or bind high and redirect in the network layer; do not run Node as root.

## Verifying

**Which protocol and cipher were actually negotiated:**

```bash
$ curl -vI https://api.example.com/health 2>&1 | grep -E 'SSL connection|subject|expire|ALPN'
* ALPN: server accepted h2
* SSL connection using TLSv1.3 / TLS_AES_256_GCM_SHA384
*  subject: CN=api.example.com
*  expire date: Dec  8 11:04:22 2026 GMT
```

**That old protocols are refused** — this must fail:

```bash
$ openssl s_client -connect api.example.com:443 -servername api.example.com -tls1_1 </dev/null
140234...:SSL alert number 70
$ echo $?
1
```

**That the chain is complete.** `Verify return code: 0 (ok)` with no `unable to get local issuer certificate`:

```bash
$ openssl s_client -connect api.example.com:443 -servername api.example.com </dev/null 2>/dev/null \
  | grep -E 'Verify return code|^ [0-9] s:'
 0 s:CN=api.example.com
 1 s:C=US, O=Let's Encrypt, CN=R11
Verify return code: 0 (ok)
```

Two chain entries, not one. A lone leaf means you shipped `cert.pem` where `fullchain.pem` was needed.

**When the certificate expires**, as a scripted check rather than a calendar reminder:

```bash
$ openssl s_client -connect api.example.com:443 -servername api.example.com </dev/null 2>/dev/null \
  | openssl x509 -noout -dates -subject
notBefore=Sep  9 11:04:23 2026 GMT
notAfter=Dec  8 11:04:22 2026 GMT
subject=CN=api.example.com
```

**That `X-Forwarded-Proto` is not believed from outside the proxy:**

```bash
$ curl -s http://10.0.4.19:3000/debug/proxy -H 'X-Forwarded-Proto: https' | jq .secure
false
```

`true` there is the bug from the first section, and it is worth a test in CI against a request that does not come through the proxy.

## Security considerations

- **`trust proxy` is a security setting, not a convenience.** It decides whether `req.secure` and `req.ip` are facts or client input.
- **A hop count trusts a position; a subnet list trusts an address.** Only the second one holds when your port is reachable directly.
- **A redirect is not transport security.** The plaintext request already happened, and an active attacker never delivers the redirect at all.
- **`Secure` on a cookie is a promise, not a guarantee.** It only means something if the connection really was TLS.
- **Every header a proxy adds is forgeable by anyone who can reach your port.** `X-Forwarded-For`, `X-Forwarded-Proto`, and client-certificate headers all need stripping at the ingress.
- **Expiry is a security incident with a countdown.** An expired certificate trains users to click through warnings, which is a lasting cost.
- **Private-network plaintext is a decision.** Make it explicitly, and write down which hops are encrypted.

## Production considerations

- **Alert on days-to-expiry, not on renewal failure.** Renewal is retried; an alert at 21 days remaining catches a broken ACME path with three weeks to fix it, and it catches the certificates nobody automated.
- **Test renewal, not just issuance.** `certbot renew --dry-run` in a staging environment after every dependency upgrade. The Express 5 `dotfiles` change is exactly the class of break this catches.
- **Prefer DNS-01.** No inbound port, wildcards, and it cannot be broken by a change to your static-file middleware.
- **Keep the TLS policy in one place.** One proxy configuration, reviewed on a schedule, beats a `ciphers` string copied into twelve repositories in 2023.
- **Scan your own endpoints.** An external TLS scanner run from CI catches the balancer policy that quietly still allows TLS 1.0.
- **Plan HSTS before you need it.** Short `max-age`, verify every subdomain, then raise it — see [Security headers](security-headers.md).
- **Reload, do not restart, on renewal.** `setSecureContext` if Node terminates TLS; a graceful reload signal if the proxy does.
- **Monitor Certificate Transparency logs for your domains.** It is the detection you actually get, and it costs nothing.

## Common mistakes

- **`app.set('trust proxy', true)`.** `req.ip` becomes whatever the client puts in `X-Forwarded-For`, and every rate limit becomes decorative.
- **No `trust proxy` at all behind a balancer.** Every user shares one IP, so one abusive client throttles everyone, and `req.secure` is always `false` so `Secure` cookies are never set.
- **A hop count on a process that is also reachable directly.** `X-Forwarded-Proto: https` from anywhere is believed.
- **Binding to `0.0.0.0` and relying on the proxy to be the only caller.** It is not, the moment someone adds a debug route or a port-forward.
- **`express.static('public')` alone, on Express 5.** ACME HTTP-01 renewal 404s, and you find out 60 days later.
- **`dotfiles: 'allow'` on the whole public directory** to fix that. Now `.env` and `.git/config` are downloadable.
- **Serving `cert.pem` instead of `fullchain.pem`.** Works in your browser, fails for every client that has not cached the intermediate.
- **Redirecting a POST to HTTPS.** The body already went in the clear; following the redirect sends it again. Reject it.
- **`res.redirect(url, 301)`.** Express 5 flipped the argument order — status first.
- **Building the redirect from `req.host`.** It includes the port in Express 5, so the port ends up in the URL twice.
- **Trusting a mesh's client-certificate header without stripping it at the ingress.** Impersonation of any internal service with one `-H`.
- **Pinning a leaf certificate fingerprint.** Four outages a year, on a 90-day certificate.
- **Pinning with no backup pin and no kill switch.** A key compromise and a full outage become the same event.
- **Treating certificate expiry as an ops calendar item.** Automate it, then alert on the automation.

## Related topics

- [Security headers](security-headers.md) — HSTS, and why the redirect on this page is not a substitute for it.
- [Rate limiting](../express-libraries/rate-limiting.md) — what a wrong `req.ip` does to every limiter you have.
- [Request and response](../express/request-and-response.md) — `req.ip`, `req.protocol`, `req.hostname` and the `trust proxy` forms in full.
- [Cookies](../express-libraries/cookies.md) — why `secure: true` silently sets no cookie behind a proxy.
- [Secrets management](secrets-management.md) — where private keys live, and why not in the environment.
- [Static files](../express/static-files.md) — the `dotfiles` option and the rest of `express.static()`.
- [Authentication and session security](authentication-and-session-security.md) — what a downgraded connection costs you.
- [Deployment checklist](../production/deployment-checklist.md) — the pre-launch pass that includes all of this.
