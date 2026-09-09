import { Router } from 'express'
import { validate } from '../middleware/validate.js'
import { requireAuth } from '../middleware/auth.js'
import {
  createNoteBody,
  updateNoteBody,
  noteParams,
  listNotesQuery,
} from '../schemas.js'
import * as controller from '../controllers/note.controller.js'

export function noteRoutes() {
  const router = Router()

  // Every route below this line is authenticated.
  router.use(requireAuth)

  router.get('/', validate({ query: listNotesQuery }), controller.list)
  router.post('/', validate({ body: createNoteBody }), controller.create)
  router.get('/:id', validate({ params: noteParams }), controller.getOne)
  router.patch('/:id', validate({ params: noteParams, body: updateNoteBody }), controller.update)
  // `router.delete()`. `app.del()` / `router.del()` were removed in Express 5.
  router.delete('/:id', validate({ params: noteParams }), controller.remove)

  return router
}
