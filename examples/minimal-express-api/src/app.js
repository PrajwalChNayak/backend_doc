/**
 * src/app.js — builds and exports the Express application. It does NOT listen.
 *
 * Keeping `app` free of `listen()` is what makes the app testable: supertest can
 * bind it to an ephemeral port, and `src/server.js` owns the single real port.
 */
import express from 'express'
import { listNotes, getNote, createNote, deleteNote } from './store.js'

export function createApp() {
  const app = express()

  // Express 5 bundles body-parser. Do not install it separately.
  app.use(express.json({ limit: '100kb' }))

  // The validator (and your load balancer) uses this to know the app is up.
  app.get('/health', (req, res) => {
    res.json({ status: 'ok' })
  })

  app.get('/notes', (req, res) => {
    res.json({ data: listNotes() })
  })

  app.get('/notes/:id', (req, res) => {
    const note = getNote(req.params.id)
    if (!note) {
      res.status(404).json({ error: { message: 'Note not found' } })
      return
    }
    res.json({ data: note })
  })

  app.post('/notes', (req, res) => {
    // In Express 5 `req.body` is `undefined` when no body parser ran, not `{}`.
    const body = req.body ?? {}
    if (typeof body.title !== 'string' || body.title.trim() === '') {
      res.status(400).json({ error: { message: 'title must be a non-empty string' } })
      return
    }
    const note = createNote({ title: body.title.trim(), done: Boolean(body.done) })
    res.status(201).json({ data: note })
  })

  app.delete('/notes/:id', (req, res) => {
    // `app.del()` was removed in Express 5 — `app.delete()` is the only spelling.
    if (!deleteNote(req.params.id)) {
      res.status(404).json({ error: { message: 'Note not found' } })
      return
    }
    res.status(204).end()
  })

  // A route that throws, to prove rejected promises reach the error handler on
  // their own. Express 5 forwards them; no `asyncHandler` wrapper is needed.
  app.get('/boom', async () => {
    throw new Error('deliberate failure')
  })

  // 404 handler. Express 5 uses path-to-regexp v8: bare '/*' is INVALID and throws
  // at startup. '/{*splat}' is the form that also matches '/' itself.
  // Note `req.originalUrl`, not `req.path`: inside a mounted handler Express strips
  // the mount prefix from `req.url`, so `req.path` here is always '/'.
  app.use('/{*splat}', (req, res) => {
    res.status(404).json({ error: { message: `Cannot ${req.method} ${req.originalUrl}` } })
  })

  // Error handler. Four arguments — Express identifies it by arity, so the unused
  // `next` must stay.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = Number.isInteger(err.statusCode) ? err.statusCode : 500
    if (status >= 500) console.error(err)
    res.status(status).json({
      error: {
        message: status >= 500 ? 'Internal Server Error' : err.message,
      },
    })
  })

  return app
}

export default createApp()
