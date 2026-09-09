import { Router } from 'express'
import { rateLimit } from 'express-rate-limit'
import { validate } from '../middleware/validate.js'
import { requireAuth } from '../middleware/auth.js'
import { registerBody, loginBody } from '../schemas.js'
import * as controller from '../controllers/auth.controller.js'
import config from '../config.js'

export function authRoutes() {
  const router = Router()

  // A much tighter bucket than the global one. Credential endpoints are what
  // gets brute-forced, and they are the cheapest thing to protect.
  const authLimiter = rateLimit({
    windowMs: config.rateLimit.windowMs,
    limit: config.rateLimit.authMax,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: { code: 'TOO_MANY_REQUESTS', message: 'Too many attempts, slow down' } },
  })

  router.post('/register', authLimiter, validate({ body: registerBody }), controller.register)
  router.post('/login', authLimiter, validate({ body: loginBody }), controller.login)
  router.get('/me', requireAuth, controller.me)

  return router
}
