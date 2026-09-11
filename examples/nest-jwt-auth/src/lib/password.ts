/**
 * scrypt password hashing on `node:crypto`, with no native build.
 *
 * See the README for why this is scrypt and not argon2id: argon2@0.45.1 is the
 * production recommendation, but it needs a compiler, and every example in this
 * repository has to install on a bare CI image.
 *
 * The stored string is self-describing:
 *
 *   scrypt$N$r$p$<salt-base64>$<hash-base64>
 *
 * so the cost parameters can be raised later without invalidating old hashes.
 */
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const scryptAsync = promisify(scrypt) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>

const PARAMS = {
  N: 32768, // CPU/memory cost
  r: 8,
  p: 1,
  // N=32768, r=8 needs ~32 MiB, which is exactly Node's default ceiling, so the
  // call fails with "memory limit exceeded" without raising maxmem. This is the
  // single most common scrypt mistake.
  maxmem: 64 * 1024 * 1024,
}

const KEY_LENGTH = 64

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const derived = await scryptAsync(password.normalize('NFKC'), salt, KEY_LENGTH, PARAMS)
  return [
    'scrypt',
    PARAMS.N,
    PARAMS.r,
    PARAMS.p,
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$')
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, saltB64, hashB64] = stored.split('$')
  if (scheme !== 'scrypt') return false

  const salt = Buffer.from(saltB64, 'base64')
  const expected = Buffer.from(hashB64, 'base64')
  const derived = await scryptAsync(password.normalize('NFKC'), salt, expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: PARAMS.maxmem,
  })

  // Length check first: timingSafeEqual throws on a length mismatch.
  if (derived.length !== expected.length) return false
  return timingSafeEqual(derived, expected)
}

/**
 * Hash of a value nobody can log in with. Verifying against this for an unknown
 * username keeps the response time for "no such user" and "wrong password" in
 * the same range, so the endpoint is not a user-enumeration oracle.
 *
 * Computed once, lazily — this file compiles to CommonJS, where there is no
 * top-level `await`.
 */
let dummyHash: Promise<string> | null = null

export function getDummyHash(): Promise<string> {
  dummyHash ??= hashPassword(randomBytes(32).toString('hex'))
  return dummyHash
}
