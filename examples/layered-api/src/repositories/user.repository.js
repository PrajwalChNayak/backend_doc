/**
 * Repository layer: the ONLY place SQL is written.
 *
 * Nothing here knows about HTTP. It takes and returns plain objects, and every
 * value that came from a user is bound as a `?` parameter — never interpolated
 * into the SQL string.
 */
import crypto from 'node:crypto'
import { getDb } from '../db/index.js'

function toUser(row) {
  if (!row) return null
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    passwordHash: row.password_hash,
    createdAt: row.created_at,
  }
}

export function insertUser({ email, name, passwordHash }) {
  const user = {
    id: crypto.randomUUID(),
    email,
    name,
    passwordHash,
    createdAt: new Date().toISOString(),
  }
  getDb()
    .prepare(
      'INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)',
    )
    .run(user.id, user.email, user.name, user.passwordHash, user.createdAt)
  return user
}

export function findUserByEmail(email) {
  const row = getDb().prepare('SELECT * FROM users WHERE email = ?').get(email)
  return toUser(row)
}

export function findUserById(id) {
  const row = getDb().prepare('SELECT * FROM users WHERE id = ?').get(id)
  return toUser(row)
}

export function emailExists(email) {
  const row = getDb().prepare('SELECT 1 AS hit FROM users WHERE email = ?').get(email)
  return Boolean(row)
}
