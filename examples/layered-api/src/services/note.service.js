import * as notes from '../repositories/note.repository.js'
import { notFound } from '../errors.js'

export function createNote({ userId, title, body }) {
  return notes.insertNote({ userId, title, body })
}

export function listNotes({ userId, limit, offset, q }) {
  return {
    data: notes.listNotesByUser({ userId, limit, offset, q }),
    meta: { total: notes.countNotesByUser(userId), limit, offset },
  }
}

/**
 * Note the deliberate choice: a note that exists but belongs to somebody else
 * produces 404, not 403. A 403 confirms the id is real, which is a free
 * enumeration primitive for an attacker. 404 tells them nothing.
 */
export function getNote({ userId, id }) {
  const note = notes.findNoteForUser({ id, userId })
  if (!note) throw notFound('Note not found')
  return note
}

export function updateNote({ userId, id, title, body }) {
  const note = notes.updateNoteForUser({ id, userId, title, body })
  if (!note) throw notFound('Note not found')
  return note
}

export function deleteNote({ userId, id }) {
  if (!notes.deleteNoteForUser({ id, userId })) throw notFound('Note not found')
}
