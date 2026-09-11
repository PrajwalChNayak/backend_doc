import { randomBytes } from 'node:crypto'
import type { JwtSignOptions } from '@nestjs/jwt'

/**
 * A random secret per boot in development means tokens do not survive a
 * restart — which is correct for a demo and fatal in production. Set JWT_SECRET.
 */
export const JWT_SECRET = process.env.JWT_SECRET ?? randomBytes(32).toString('hex')
export const JWT_ISSUER = process.env.JWT_ISSUER ?? 'https://nest-jwt-auth.example'
export const JWT_AUDIENCE = process.env.JWT_AUDIENCE ?? 'nest-jwt-auth-clients'

/**
 * `expiresIn` is typed as a `ms` duration string ("15m", "2h") or a number of
 * seconds, so an env var has to be narrowed rather than passed as a bare string.
 */
export const JWT_EXPIRES_IN: JwtSignOptions['expiresIn'] =
  (process.env.JWT_EXPIRES_IN as JwtSignOptions['expiresIn']) ?? '15m'

if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET is required in production')
}
