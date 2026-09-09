/**
 * Controller layer: HTTP in, HTTP out. It reads validated input, calls one
 * service function, and picks a status code. No business logic, no SQL.
 *
 * These handlers are `async` and do not catch. Express 5 forwards a rejected
 * promise to the error handler by itself — `express-async-handler` and
 * `.catch(next)` wrappers are dead weight here.
 */
import * as authService from '../services/auth.service.js'

export async function register(req, res) {
  const user = await authService.register(req.valid.body)
  res.status(201).json({ data: user })
}

export async function login(req, res) {
  const { token, user } = await authService.login(req.valid.body)
  res.json({ data: { token, tokenType: 'Bearer', user } })
}

export async function me(req, res) {
  res.json({ data: authService.getProfile(req.user.id) })
}
