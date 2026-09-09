---
title: Password hashing
description: Hashing passwords with argon2id, choosing parameters by measured cost rather than copied constants, and the bcrypt and scrypt fallbacks.
status: current
updated: 2026-09-08
---

A password hash has one job: make an offline attack against a stolen database expensive. Everything about the algorithm choice and its parameters follows from that, which is why "use a slow hash" is the rule and "use a fast one and add a salt" — the advice that produced a decade of breached SHA-256 tables — is not.

## Why it exists

Assume the database will leak. Backups, a SQL injection, a misconfigured snapshot, an insider. Once an attacker has the hash column, the only thing standing between them and every user's plaintext is how many guesses per second their hardware can make.

A general-purpose hash like SHA-256 is designed to be fast — billions of guesses per second on a consumer GPU. A password hash is deliberately slow and, in Argon2's case, deliberately memory-hungry, because GPUs and ASICs have far more compute than they have fast memory per core. Memory-hardness is what makes the attacker's specialized hardware advantage collapse.

:::danger
Never use MD5, SHA-1, SHA-256, SHA-512, or HMAC for passwords, salted or not. Never invent a scheme out of several rounds of those. Never store a password reversibly. If you can email a user their existing password, you have a critical vulnerability.
:::

## argon2id — the default choice

Argon2 won the Password Hashing Competition and `argon2id` is the variant to use: it combines Argon2i's resistance to side-channel attacks with Argon2d's resistance to GPU cracking.

```bash
npm install argon2@0.45.1
```

`argon2` builds a native addon. Prebuilt binaries are published for common platforms; where none matches, you need a compiler and `node-gyp` at install time. Plan for that in your Docker build — see the production notes below.

```js title="src/auth/password.js"
import argon2 from 'argon2'

const OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 65536, // KiB — 64 MiB
  timeCost: 3, // passes over memory
  parallelism: 4, // lanes
}

export function hashPassword(plain) {
  return argon2.hash(plain, OPTIONS)
}

export function verifyPassword(hash, plain) {
  return argon2.verify(hash, plain)
}
```

Those are the library's own defaults, and they are a reasonable starting point rather than a target. `argon2.hash()` generates a cryptographically random salt for you and returns a PHC string:

```text
$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHQ$RdescudvJCsgt3ub+b+dWRWJTmaaJObG
```

Salt, parameters and digest are all in that one string, which is why `verify()` needs no configuration — it reads the parameters back out of the stored hash. Store the whole string in a `varchar(255)`; do not parse it, do not store the salt in a separate column.

### Choosing parameters: measure, do not copy

Any specific set of numbers in a document goes stale as hardware moves. The right method is to pick a **time budget** and tune to it on the hardware you will actually deploy on.

Target roughly **250–500 ms** per hash on your production instance type. That is slow enough to make large-scale offline cracking painful and fast enough that a login feels instant and your event loop is not saturated.

```js title="scripts/tune-argon2.mjs"
import argon2 from 'argon2'

const candidates = [
  { memoryCost: 19456, timeCost: 2, parallelism: 1 },
  { memoryCost: 65536, timeCost: 3, parallelism: 4 },
  { memoryCost: 131072, timeCost: 3, parallelism: 4 },
  { memoryCost: 262144, timeCost: 4, parallelism: 4 },
]

for (const opts of candidates) {
  const start = performance.now()
  await argon2.hash('correct horse battery staple', { type: argon2.argon2id, ...opts })
  const ms = performance.now() - start
  console.log(`m=${opts.memoryCost} t=${opts.timeCost} p=${opts.parallelism} -> ${ms.toFixed(0)} ms`)
}
```

Run that on the instance type you deploy to — not your laptop, which is usually much faster than a shared vCPU — and pick the largest configuration that stays inside your budget.

How the three knobs trade off:

| Parameter | Effect | How to move it |
| --- | --- | --- |
| `memoryCost` (KiB) | The memory-hardness. This is what defeats GPUs. | Raise this **first**. Doubling it roughly doubles both time and RAM. |
| `timeCost` | Passes over that memory. Raises cost linearly with no extra RAM. | Raise this when you cannot afford more memory. Keep it ≥ 2. |
| `parallelism` | Lanes used. | Match your available cores, but see the concurrency warning below. |

Current OWASP-style minimums, as a floor rather than a goal, are `argon2id` with `m=19456` (19 MiB), `t=2`, `p=1`. If your measurement says you can afford `m=65536, t=3` inside the budget, use that instead.

:::warning
`memoryCost` is per hash **in flight**. At 64 MiB and 20 concurrent logins you are allocating 1.28 GiB. On a 512 MiB container that is an OOM kill, triggered by anyone who can send twenty login requests at once. Bound the concurrency — rate limit the login endpoint, and consider a small queue in front of the hash — and size the container for `memoryCost × expected concurrency`.
:::

### Rehash on login when parameters change

When you raise the cost, existing hashes keep their old, weaker parameters forever unless you upgrade them. You cannot recompute them offline — you do not have the plaintext. The only moment you hold it is at login.

```js title="src/auth/password.js"
export async function verifyAndUpgrade(user, plain) {
  const ok = await argon2.verify(user.passwordHash, plain)
  if (!ok) return false

  if (argon2.needsRehash(user.passwordHash, OPTIONS)) {
    await saveHash(user.id, await argon2.hash(plain, OPTIONS))
  }

  return true
}
```

`needsRehash(digest, options)` compares `timeCost`, `memoryCost`, `parallelism` and `version` in the stored PHC string against what you pass, and returns `true` when they differ. Do the rehash *after* the verify succeeds, and never let a failed write turn a successful login into an error.

## bcrypt

bcrypt is older, not memory-hard, and still perfectly serviceable. Use it when the native Argon2 build is a real obstacle, or when you already have a table full of bcrypt hashes.

```bash
npm install bcrypt@6
```

```js title="src/auth/password.js"
import bcrypt from 'bcrypt'

const COST = 12 // 2^12 = 4096 iterations

export function hashPassword(plain) {
  return bcrypt.hash(plain, COST)
}

export function verifyPassword(hash, plain) {
  return bcrypt.compare(plain, hash)
}

export function needsRehash(hash) {
  return bcrypt.getRounds(hash) < COST
}
```

Cost 12 is the current sensible minimum; tune it the same way, to the same time budget. Each increment doubles the work, so 12 → 13 doubles your login latency.

:::danger
**bcrypt silently truncates at 72 bytes.** Only the first 72 bytes of the input are hashed, and the rest are ignored — including when comparing. That is 72 *bytes*, not characters, so a passphrase with emoji or non-Latin script hits the limit far sooner than it looks.

The consequence: two different passwords that share a 72-byte prefix are interchangeable. Combined with a password manager generating long secrets, or with a pre-hashing scheme that produces long input, this quietly weakens accounts.

`bcrypt` 6.0.0 does not throw on over-long input; it truncates. Reject passwords over 72 bytes at validation time (`Buffer.byteLength(plain, 'utf8') > 72`), or use argon2, which has no such limit.
:::

A related trap: pre-hashing with SHA-256 to "fix" the length limit produces a hex or base64 string whose *bytes* may still exceed 72, and if you use raw binary output it can contain a NUL. Do not do it. Just cap the length or switch algorithms.

Note also that bcrypt's own hash string embeds the cost and salt, so `bcrypt.compare` needs no configuration either.

## scrypt with no dependencies

`node:crypto` ships scrypt, which is memory-hard and needs no native build, no npm package, and no compiler in your image. It is a genuine option when adding a native dependency is not worth the trouble.

The catch is that Node gives you a raw KDF, not a password-hashing API: you generate the salt, you choose the encoding, you compare in constant time, and you store the parameters yourself.

```js title="src/auth/password.js"
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const scryptAsync = promisify(scrypt)

// N must be a power of two. maxmem must be raised to match:
// the limit is approximately 128 * N * r bytes, default 32 MiB.
const PARAMS = { N: 2 ** 16, r: 8, p: 1, maxmem: 256 * 1024 * 1024 }
const KEYLEN = 64

export async function hashPassword(plain) {
  const salt = randomBytes(16)
  const key = await scryptAsync(plain.normalize('NFKC'), salt, KEYLEN, PARAMS)
  return `scrypt$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${salt.toString('base64')}$${key.toString('base64')}`
}

export async function verifyPassword(stored, plain) {
  const [scheme, N, r, p, saltB64, keyB64] = stored.split('$')
  if (scheme !== 'scrypt') return false

  const salt = Buffer.from(saltB64, 'base64')
  const expected = Buffer.from(keyB64, 'base64')
  const actual = await scryptAsync(plain.normalize('NFKC'), salt, expected.length, {
    N: Number(N),
    r: Number(r),
    p: Number(p),
    maxmem: 256 * 1024 * 1024,
  })

  return actual.length === expected.length && timingSafeEqual(actual, expected)
}
```

Two things that are easy to get wrong here:

- **`maxmem`.** The default is 32 MiB and scrypt errors out when `128 * N * r` exceeds it. Raising `N` without raising `maxmem` gives you a runtime error, not a weaker hash — but only once you deploy the new parameters.
- **`timingSafeEqual` throws when the buffers differ in length.** Check the length first, as above, and treat a mismatch as a failed verification.

Node 24.7.0 also added `crypto.argon2()` and `crypto.argon2Sync()`. They expose Argon2 as a raw KDF — `{ message, nonce, parallelism, tagLength, memory, passes }` — and, like `scrypt`, they neither produce nor parse PHC strings and offer no rehash check. For password storage, the `argon2` package remains the more practical choice today.

## Timing-safe comparison

Comparing two secrets with `===` leaks information: string comparison returns as soon as it finds a differing byte, so the time taken reveals how many leading bytes matched. Over enough samples that is enough to reconstruct the value.

For password hashes this rarely matters, because `argon2.verify` and `bcrypt.compare` already compare in constant time internally, and the hash itself dominates the timing. It matters a great deal for the *other* secrets in an auth system — API keys, password-reset tokens, HMAC signatures, session identifiers you compare by hand:

```js
import { timingSafeEqual } from 'node:crypto'

function safeEqual(a, b) {
  const bufA = Buffer.from(a, 'utf8')
  const bufB = Buffer.from(b, 'utf8')
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}
```

### The user-enumeration timing leak

A subtler leak is at the account level. If a login with an unknown email returns in 2 ms and a login with a known email returns in 300 ms, an attacker can enumerate your entire user base by timing alone — no error message needed.

```js title="src/auth/login.js"
import argon2 from 'argon2'

// A real argon2id hash of a random string, generated once at build time.
const DUMMY_HASH = process.env.DUMMY_PASSWORD_HASH

export async function login(email, password) {
  const user = await findUserByEmail(email)

  // Always do the work, even when the user does not exist.
  const hash = user?.passwordHash ?? DUMMY_HASH
  const ok = await argon2.verify(hash, password)

  return user && ok ? user : null
}
```

The dummy hash must use the same parameters as your real ones, or the timing difference reappears.

## Peppering

A pepper is a secret key mixed into the hash, stored outside the database — in an environment variable, a KMS, or an HSM. It means a stolen database alone is not enough to start cracking.

`argon2` supports it directly via the `secret` option, which maps to Argon2's keyed mode:

```js
const PEPPER = Buffer.from(process.env.PASSWORD_PEPPER, 'base64')

argon2.hash(plain, { ...OPTIONS, secret: PEPPER })
argon2.verify(hash, plain, { secret: PEPPER })
```

Do **not** implement it as `hash(hmac(password))` unless you have thought it through — you inherit the length and encoding problems described under bcrypt.

The honest trade-off: a pepper helps only when the attacker gets the database *without* getting application secrets — a SQL injection or a leaked backup, not a compromised server. And rotating it is painful, because every hash must be recomputed, which again requires the plaintext, which again means at login. If you adopt one, version it (store which pepper generation produced each hash) so rotation is possible at all.

It is a genuine defense-in-depth measure, and it is strictly less important than getting `memoryCost` right.

## Security considerations

**Never roll your own.** Not the hash, not the salt scheme, not the comparison. Every part of this has a subtle failure mode that is invisible until a breach.

**One hash per password, with a unique random salt.** All three libraries do this automatically. If you find yourself generating salts by hand, you are on the wrong path.

**Rate limit login, registration and password reset.** Hashing is expensive *for you* too. Unlimited login attempts against a 300 ms hash is a denial-of-service primitive and a brute-force channel at once. See [Rate limiting](rate-limiting.md).

**Enforce a length policy, not a composition policy.** A minimum of 8–12 characters and a check against a breached-password list beats forcing a symbol and a digit. Set a maximum too (128 characters is generous) so a 10 MB "password" cannot be used to burn CPU.

**Normalize Unicode before hashing.** `plain.normalize('NFKC')` makes visually identical inputs from different keyboards hash the same. Decide once and apply it consistently, because changing it later invalidates every stored hash.

**Never log the password.** Not at debug level, not in a request dump, not in an error. Redact it at the logger — see [Logging](logging.md).

**Return one generic message on failure.** "Invalid email or password", both for unknown users and wrong passwords, with matched timing.

**Force a re-login after a password change** by invalidating existing sessions and refresh tokens. A password change that leaves the attacker's session alive achieves nothing.

**Treat password-reset tokens like passwords.** Random, at least 32 bytes, hashed at rest, single-use, short-lived, compared with `timingSafeEqual`.

## Production considerations

**Native builds affect your image.** `argon2` and `bcrypt` both compile. In a multi-stage Dockerfile, install and build in a stage that has the toolchain, then copy `node_modules` into a slim runtime — and make sure both stages use the same base image and Node version, or the prebuilt or freshly compiled `.node` binary will not load.

**Size memory for concurrency, not for one hash.** `memoryCost × concurrent logins` is your real requirement. Measure under a login burst, not at rest.

**Hashing occupies a libuv thread pool slot.** Both `argon2` and `bcrypt` run the work off the main thread, but the pool defaults to four threads and is shared with file I/O and DNS. A burst of logins can therefore stall unrelated `fs` operations. Raising `UV_THREADPOOL_SIZE` helps; bounding login concurrency helps more.

**Never use the synchronous variants in a request path.** `bcrypt.hashSync` and `crypto.scryptSync` block the event loop for the full duration — 300 ms during which your process serves nobody.

**Retune when you change instance types.** A migration from x86 to ARM, or to a burstable instance, can move your hash time by a factor of several. Re-run the tuning script as part of the migration.

**Plan the migration when you change algorithm.** Store the algorithm in the hash string (all three formats above do), detect the old format on login, verify with the old scheme, and rehash with the new one. Do not attempt a big-bang migration; you cannot.

**Alert on hash latency.** A sudden change means either an instance-type change or a parameter change you did not intend.

## Common mistakes

- **Any general-purpose hash for passwords.** SHA-256 with a salt is still billions of guesses per second.
- **Copying parameters from a blog post.** Measure on your own hardware, to a time budget.
- **Setting `memoryCost` high without sizing the container.** Twenty concurrent logins OOM the process.
- **Ignoring bcrypt's 72-byte truncation.** Long passphrases and emoji are silently cut.
- **Pre-hashing with SHA before bcrypt to work around that limit.** New problems, same class.
- **Storing the salt in a separate column.** The PHC string already contains it.
- **Never rehashing.** Parameters you raised in 2024 protect nobody who registered in 2022.
- **Skipping the dummy hash for unknown users.** Timing enumerates your user table.
- **`===` on tokens and API keys.** Use `timingSafeEqual`, and check the length first because it throws on a mismatch.
- **Using `scryptSync` or `hashSync` in a handler.** Blocks the loop for everyone.
- **Raising scrypt's `N` without raising `maxmem`.** Runtime error, discovered in production.
- **Not rate limiting login.** The expensive hash you configured becomes the attacker's DoS tool.

## Related topics

- [Authentication](authentication.md) — sessions and tokens, once the password is verified.
- [Authentication and session security](../security/authentication-and-session-security.md) — the wider threat model, including credential stuffing.
- [Rate limiting](rate-limiting.md) — bounding both brute force and the cost of hashing.
- [Secrets management](../security/secrets-management.md) — where a pepper would live.
- [Logging without leaking PII](../security/logging-without-leaking-pii.md) — keeping passwords out of every log line.
- [Dockerfile](../production/dockerfile.md) — building images that contain a working native addon.
