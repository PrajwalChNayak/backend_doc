/**
 * Pino, configured so it cannot log a credential.
 *
 * `redact` is not optional decoration. Without it `pino-http` serialises the
 * whole request, and the very first line of your production log contains a
 * bearer token that is valid for the next fifteen minutes.
 */
import pino from 'pino'
import config from './config.js'

export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  'password',
  '*.password',
  'req.body.password',
  'body.password',
  'token',
  '*.token',
]

export const logger = pino({
  level: config.logLevel,
  redact: {
    paths: REDACT_PATHS,
    censor: '[redacted]',
  },
  base: { service: 'layered-api' },
})

export default logger
