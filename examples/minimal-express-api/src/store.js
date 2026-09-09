/**
 * A deliberately boring in-memory store.
 *
 * It exists so the example needs no database. Everything here is synchronous and
 * process-local: restart the server and the data is gone. Swap this module for a
 * repository backed by a real driver and nothing else in the app has to change.
 */

/** @type {Map<string, { id: string, title: string, done: boolean, createdAt: string }>} */
const notes = new Map()

export function listNotes() {
  return [...notes.values()]
}

export function getNote(id) {
  return notes.get(id) ?? null
}

export function createNote({ title, done = false }) {
  const note = {
    id: crypto.randomUUID(),
    title,
    done,
    createdAt: new Date().toISOString(),
  }
  notes.set(note.id, note)
  return note
}

export function deleteNote(id) {
  return notes.delete(id)
}

export function resetNotes() {
  notes.clear()
}
