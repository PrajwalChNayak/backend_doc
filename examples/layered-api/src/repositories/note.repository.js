/**
 * Notes repository. Every query is scoped by `user_id` at the SQL level.
 *
 * Scoping in the WHERE clause rather than checking ownership after the fetch is
 * what makes IDOR structurally impossible here: there is no code path that can
 * return another user's row for it to leak.
 */
import crypto from 'node:crypto'
import { getDb } from '../db/index.js'

function toNote(row) {
  if (!row) return null
  return {
    id: row.id,
    userId: row.user_id,
    title: row.title,
    body: row.body,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function insertNote({ userId, title, body }) {
  const now = new Date().toISOString()
  const note = {
    id: crypto.randomUUID(),
    userId,
    title,
    body: body ?? '',
    createdAt: now,
    updatedAt: now,
  }
  getDb()
    .prepare(
      `INSERT INTO notes (id, user_id, title, body, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(note.id, note.userId, note.title, note.body, note.createdAt, note.updatedAt)
  return note
}

export function listNotesByUser({ userId, limit, offset, q }) {
  // The optional search term is a bound parameter too — LIKE is not an excuse to
  // start concatenating. The wildcards go in the *value*, not in the SQL.
  if (q) {
    const rows = getDb()
      .prepare(
        `SELECT * FROM notes
          WHERE user_id = ? AND title LIKE ? ESCAPE '\\'
          ORDER BY created_at DESC
          LIMIT ? OFFSET ?`,
      )
      .all(userId, `%${escapeLike(q)}%`, limit, offset)
    return rows.map(toNote)
  }

  const rows = getDb()
    .prepare(
      `SELECT * FROM notes
        WHERE user_id = ?
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?`,
    )
    .all(userId, limit, offset)
  return rows.map(toNote)
}

export function countNotesByUser(userId) {
  const row = getDb().prepare('SELECT COUNT(*) AS n FROM notes WHERE user_id = ?').get(userId)
  return Number(row.n)
}

export function findNoteForUser({ id, userId }) {
  const row = getDb().prepare('SELECT * FROM notes WHERE id = ? AND user_id = ?').get(id, userId)
  return toNote(row)
}

export function updateNoteForUser({ id, userId, title, body }) {
  const now = new Date().toISOString()
  const result = getDb()
    .prepare(
      `UPDATE notes
          SET title = COALESCE(?, title),
              body  = COALESCE(?, body),
              updated_at = ?
        WHERE id = ? AND user_id = ?`,
    )
    .run(title ?? null, body ?? null, now, id, userId)
  if (Number(result.changes) === 0) return null
  return findNoteForUser({ id, userId })
}

export function deleteNoteForUser({ id, userId }) {
  const result = getDb().prepare('DELETE FROM notes WHERE id = ? AND user_id = ?').run(id, userId)
  return Number(result.changes) > 0
}

/** `%` and `_` are wildcards inside LIKE; neutralise them in user input. */
function escapeLike(value) {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`)
}
