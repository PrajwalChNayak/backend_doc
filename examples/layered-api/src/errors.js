/**
 * One error type for everything the application deliberately rejects.
 *
 * The rule the whole codebase follows: services throw `AppError`, the error
 * handler is the only place that turns an error into a response. No layer below
 * the controller ever touches `res`.
 */
export class AppError extends Error {
  /**
   * @param {number} statusCode HTTP status to send.
   * @param {string} message Safe to show a client — never include internals.
   * @param {{ code?: string, details?: unknown, cause?: unknown }} [options]
   */
  constructor(statusCode, message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined)
    this.name = 'AppError'
    this.statusCode = statusCode
    this.code = options.code ?? httpCode(statusCode)
    this.details = options.details
    // Marks the error as intentional, so the handler knows the message is safe
    // to send verbatim. Anything without this flag is treated as a 500.
    this.expose = statusCode < 500
    Error.captureStackTrace?.(this, AppError)
  }
}

function httpCode(status) {
  return (
    {
      400: 'BAD_REQUEST',
      401: 'UNAUTHORIZED',
      403: 'FORBIDDEN',
      404: 'NOT_FOUND',
      409: 'CONFLICT',
      413: 'PAYLOAD_TOO_LARGE',
      429: 'TOO_MANY_REQUESTS',
    }[status] ?? 'INTERNAL_ERROR'
  )
}

export const badRequest = (message, details) => new AppError(400, message, { details })
export const unauthorized = (message = 'Authentication required') => new AppError(401, message)
export const forbidden = (message = 'Forbidden') => new AppError(403, message)
export const notFound = (message = 'Not found') => new AppError(404, message)
export const conflict = (message) => new AppError(409, message)
