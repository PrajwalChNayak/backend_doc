/**
 * Service layer: business rules, no HTTP, no SQL.
 *
 * Services throw `AppError`. They never see `req` or `res`, which is what lets
 * you call them from a queue worker or a CLI without refactoring anything.
 */
import * as users from '../repositories/user.repository.js'
import { hashPassword, verifyPassword, fakeVerify } from '../lib/password.js'
import { signAccessToken } from '../lib/tokens.js'
import { conflict, unauthorized, notFound } from '../errors.js'

/** Strips the password hash. Nothing above this line may see it. */
export function publicUser(user) {
  return { id: user.id, email: user.email, name: user.name, createdAt: user.createdAt }
}

export async function register({ email, name, password }) {
  const normalized = email.trim().toLowerCase()
  if (users.emailExists(normalized)) {
    throw conflict('That email address is already registered')
  }
  const passwordHash = await hashPassword(password)
  const user = users.insertUser({ email: normalized, name: name.trim(), passwordHash })
  return publicUser(user)
}

export async function login({ email, password }) {
  const user = users.findUserByEmail(email.trim().toLowerCase())

  // Same generic message and comparable timing whether the account exists or the
  // password was wrong. Anything else is an account-enumeration oracle.
  const ok = user ? await verifyPassword(password, user.passwordHash) : await fakeVerify()
  if (!ok) throw unauthorized('Invalid email or password')

  return {
    token: signAccessToken({ userId: user.id, email: user.email }),
    user: publicUser(user),
  }
}

export function getProfile(userId) {
  const user = users.findUserById(userId)
  if (!user) throw notFound('User not found')
  return publicUser(user)
}
