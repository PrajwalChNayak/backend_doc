import * as noteService from '../services/note.service.js'

export async function list(req, res) {
  // `req.valid.query`, not `req.query` — the raw getter is untouched.
  const { limit, offset, q } = req.valid.query
  res.json(noteService.listNotes({ userId: req.user.id, limit, offset, q }))
}

export async function create(req, res) {
  const note = noteService.createNote({ userId: req.user.id, ...req.valid.body })
  res.status(201).location(`/notes/${note.id}`).json({ data: note })
}

export async function getOne(req, res) {
  res.json({ data: noteService.getNote({ userId: req.user.id, id: req.valid.params.id }) })
}

export async function update(req, res) {
  const note = noteService.updateNote({
    userId: req.user.id,
    id: req.valid.params.id,
    ...req.valid.body,
  })
  res.json({ data: note })
}

export async function remove(req, res) {
  noteService.deleteNote({ userId: req.user.id, id: req.valid.params.id })
  res.status(204).end()
}
