/**
 * Password hashing with `node:crypto` scrypt.
 *
 * WHY SCRYPT HERE: argon2id (the `argon2` package) is the production
 * recommendation, but it needs a native build. This example has to run after a
 * bare `npm install` on any machine, so it uses the scrypt that ships with Node.
 * scrypt is a genuine memory-hard KDF and is an acceptable choice; argon2id is
 * simply the better one. See the README for the swap.
 *
 * The stored format is self-describing so parameters can be raised later without
 * invalidating existing hashes:
 *
 *   scrypt$N$r$p$<salt-base64>$<hash-base64>
 */
import crypto from 'node:crypto'
import { promisify } from 'node:util'

const scrypt = promisify(crypto.scrypt)

// N=2^15 with r=8 needs roughly 32 MiB per hash. Node's default maxmem is 32 MiB,
// which this would exceed, so maxmem is raised explicitly.
const PARAMS = { N: 32768, r: 8, p: 1, keylen: 64, maxmem: 96 * 1024 * 1024 }
const SALT_BYTES = 16

export async function hashPassword(plaintext) {
  if (typeof plaintext !== 'string' || plaintext.length === 0) {
    throw new TypeError('password must be a non-empty string')
  }
  const salt = crypto.randomBytes(SALT_BYTES)
  const derived = await scrypt(plaintext.normalize('NFKC'), salt, PARAMS.keylen, PARAMS)
  return [
    'scrypt',
    PARAMS.N,
    PARAMS.r,
    PARAMS.p,
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$')
}

export async function verifyPassword(plaintext, stored) {
  if (typeof stored !== 'string') return false
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false

  const [, N, r, p, saltB64, hashB64] = parts
  const salt = Buffer.from(saltB64, 'base64')
  const expected = Buffer.from(hashB64, 'base64')

  let derived
  try {
    derived = await scrypt(plaintext.normalize('NFKC'), salt, expected.length, {
      N: Number(N),
      r: Number(r),
      p: Number(p),
      maxmem: PARAMS.maxmem,
    })
  } catch {
    return false
  }

  // Constant-time. `===` on the hex strings leaks the position of the first
  // differing byte through timing.
  if (derived.length !== expected.length) return false
  return crypto.timingSafeEqual(derived, expected)
}

/**
 * Burn roughly the same CPU as a real verification even when the account does
 * not exist, so `POST /auth/login` cannot be used to enumerate email addresses
 * by measuring response time.
 */
export async function fakeVerify() {
  await scrypt('dummy-password', crypto.randomBytes(SALT_BYTES), PARAMS.keylen, PARAMS)
  return false
}
