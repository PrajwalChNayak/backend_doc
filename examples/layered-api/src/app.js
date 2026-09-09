/**
 * src/app.js — wires the application together. It never calls `listen()`.
 *
 * Order matters here and is the same in every Express app worth copying:
 *
 *   1. helmet          — response headers, before anything can respond
 *   2. request logging — so even rejected requests get a log line
 *   3. cors            — must run before the router or preflights 404
 *   4. compression, cookie-parser, body parsers
 *   5. rate limiting
 *   6. routes
 *   7. 404 handler
 *   8. error handler   — always last, always four arguments
 */
import express from 'express'
import helmet from 'helmet'
import cors from 'cors'
import compression from 'compression'
import cookieParser from 'cookie-parser'
import { rateLimit } from 'express-rate-limit'
import pinoHttp from 'pino-http'

import config from './config.js'
import logger, { REDACT_PATHS } from './logger.js'
import { authRoutes } from './routes/auth.routes.js'
import { noteRoutes } from './routes/note.routes.js'
import { errorHandler, notFoundHandler } from './middleware/error-handler.js'
import { isReady } from './readiness.js'
import { getDriverName } from './db/index.js'

export function createApp() {
  const app = express()

  // Behind exactly one proxy (a load balancer). `trust proxy: true` would let a
  // client spoof X-Forwarded-For and defeat rate limiting by IP.
  app.set('trust proxy', 1)
  app.disable('x-powered-by')

  app.use(helmet())

  app.use(
    pinoHttp({
      logger,
      // pino-http has its own serialisers, so the redact list is repeated here.
      redact: { paths: REDACT_PATHS, censor: '[redacted]' },
      customLogLevel(req, res, err) {
        if (err || res.statusCode >= 500) return 'error'
        if (res.statusCode >= 400) return 'warn'
        return 'info'
      },
    }),
  )

  const allowedOrigins = new Set(config.cors.allowedOrigins)
  app.use(
    cors({
      // A function, not `origin: true`. `true` reflects whatever Origin the
      // browser sent, which combined with `credentials: true` is the same as
      // having no CORS policy at all.
      origin(origin, callback) {
        // No Origin header: curl, same-origin requests, server-to-server. There
        // is no browser to protect, so let it through.
        if (!origin) return callback(null, true)
        // Returning `false` omits the CORS headers and the browser blocks it.
        // Returning an Error would produce a 500, which is not what happened.
        return callback(null, allowedOrigins.has(origin))
      },
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'DELETE'],
      maxAge: 600,
    }),
  )

  app.use(compression())
  app.use(cookieParser())
  // A body limit is a security control, not a nicety: without it a single
  // request can pin a worker on JSON parsing.
  app.use(express.json({ limit: '100kb' }))
  app.use(express.urlencoded({ extended: false, limit: '100kb' }))

  app.use(
    rateLimit({
      windowMs: config.rateLimit.windowMs,
      limit: config.rateLimit.max,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      // Health checks must never be throttled or the orchestrator will restart a
      // perfectly healthy process during a traffic spike.
      skip: (req) => req.path === '/health' || req.path === '/ready',
      message: { error: { code: 'TOO_MANY_REQUESTS', message: 'Rate limit exceeded' } },
    }),
  )

  app.get('/health', (req, res) => {
    res.json({ status: 'ok' })
  })

  app.get('/ready', (req, res) => {
    if (!isReady()) {
      res.status(503).json({ status: 'shutting_down' })
      return
    }
    res.json({ status: 'ok', driver: getDriverName() })
  })

  app.use('/auth', authRoutes())
  app.use('/notes', noteRoutes())

  // path-to-regexp v8: '/*' is invalid and throws at startup. '/{*splat}' is the
  // optional-wildcard form that also matches '/'.
  app.use('/{*splat}', notFoundHandler)
  app.use(errorHandler)

  return app
}

export default createApp
