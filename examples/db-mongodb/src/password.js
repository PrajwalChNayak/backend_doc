/**
 * scrypt from node:crypto, so the example has no extra dependency.
 *
 * For a real service prefer argon2 (`argon2@0.45.1`) or bcrypt (`bcrypt@6.0.0`) —
 * they carry tuned defaults and a versioned hash format. The point here is only
 * that the login route compares hashes in constant time and never stores or
 * compares a plaintext password.
 */
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const scrypt = promisify(scryptCb)
const KEY_LENGTH = 64

export async function hashPassword(password) {
  const salt = randomBytes(16)
  const derived = await scrypt(password, salt, KEY_LENGTH)
  return `scrypt$${salt.toString('base64')}$${derived.toString('base64')}`
}

export async function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false
  const [scheme, saltB64, hashB64] = stored.split('$')
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false

  const expected = Buffer.from(hashB64, 'base64')
  const actual = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length)

  // Constant-time compare: a normal === leaks how many leading bytes matched.
  return timingSafeEqual(expected, actual)
}
