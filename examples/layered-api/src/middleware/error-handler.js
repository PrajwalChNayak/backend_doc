/**
 * The single place an error becomes a response.
 *
 * Mapping, in order:
 *   ZodError          -> 400 with the field-level issues
 *   AppError          -> its own statusCode, message sent verbatim
 *   body-parser error -> 400 (malformed JSON) / 413 (too large)
 *   anything else     -> 500 with a generic message and NO stack
 */
import { ZodError } from 'zod'
import { AppError } from '../errors.js'
import config from '../config.js'

export function notFoundHandler(req, res) {
  res.status(404).json({
    error: {
      code: 'NOT_FOUND',
      message: `Cannot ${req.method} ${req.originalUrl}`,
    },
  })
}

// Four parameters. Express detects error middleware by arity, so `next` must
// stay in the signature even though it is unused.
// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  const log = req.log ?? console

  if (err instanceof ZodError) {
    res.status(400).json({
      error: {
        code: 'VALIDATION_FAILED',
        message: 'Request validation failed',
        issues: err.issues.map((i) => ({
          path: i.path.join('.'),
          code: i.code,
          message: i.message,
        })),
      },
    })
    return
  }

  if (err instanceof AppError) {
    if (err.statusCode >= 500) log.error?.({ err }, 'application error')
    res.status(err.statusCode).json({
      error: {
        code: err.code,
        message: err.message,
        ...(err.details ? { details: err.details } : {}),
      },
    })
    return
  }

  // express.json() rejections arrive as http-errors instances with `status` and
  // `type` set. Surface them as client errors rather than a mystery 500.
  if (err.type === 'entity.too.large') {
    res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body too large' } })
    return
  }
  if (err.type === 'entity.parse.failed') {
    res.status(400).json({ error: { code: 'INVALID_JSON', message: 'Request body is not valid JSON' } })
    return
  }

  // Genuinely unexpected. Log everything, tell the client nothing.
  log.error?.({ err }, 'unhandled error')

  const payload = {
    error: { code: 'INTERNAL_ERROR', message: 'Internal Server Error' },
  }
  // Outside production it is useful to see the stack in the response. In
  // production this branch is dead, and that is deliberate: a stack trace names
  // your file paths, your dependencies and often your database schema.
  if (!config.isProduction) {
    payload.error.debug = { name: err.name, message: err.message, stack: err.stack?.split('\n') }
  }
  res.status(500).json(payload)
}
