/**
 * Zod 4 validation middleware.
 *
 * ============================ THE EXPRESS 5 TRAP ============================
 * In Express 5 `req.query` is a GETTER with no setter. The Express 4 idiom
 *
 *     req.query = schema.parse(req.query)     // TypeError in Express 5
 *
 * throws "Cannot set property query of #<IncomingMessage> which has only a
 * getter". `req.params` and `req.body` are still writable, but overwriting the
 * raw input is a bad habit anyway: a later middleware can no longer tell what
 * the client actually sent.
 *
 * So the parsed output goes somewhere new — `req.valid` — and handlers read
 * `req.valid.query`, never `req.query`. (`res.locals.valid` is the same idea if
 * you prefer to keep everything on `res.locals`; this module populates both.)
 * ===========================================================================
 */
import { ZodError } from 'zod'

/**
 * @param {{ body?: import('zod').ZodType, params?: import('zod').ZodType, query?: import('zod').ZodType }} schemas
 */
export function validate(schemas) {
  const parts = Object.entries(schemas)

  return function validateMiddleware(req, res, next) {
    const valid = req.valid ?? {}
    const issues = []

    for (const [part, schema] of parts) {
      // Express 5: `req.body` is `undefined` when no body parser ran, and
      // `req.params` has a null prototype. Both are fine for Zod, but the
      // `?? {}` matters — `undefined` against a strict object schema produces a
      // confusing "invalid_type: expected object" instead of the missing-field
      // errors you want.
      const source = part === 'query' ? { ...req.query } : (req[part] ?? {})
      const result = schema.safeParse(source)

      if (result.success) {
        valid[part] = result.data
      } else {
        issues.push(...prefixIssues(result.error, part))
      }
    }

    if (issues.length > 0) {
      // Hand a real ZodError to the central error handler so there is exactly one
      // place that decides what a validation failure looks like on the wire.
      next(new ZodError(issues))
      return
    }

    req.valid = valid
    res.locals.valid = valid
    next()
  }
}

function prefixIssues(error, part) {
  return error.issues.map((issue) => ({ ...issue, path: [part, ...issue.path] }))
}
