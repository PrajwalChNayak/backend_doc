import type { Role } from '../users/users.service.js'

/** What we put in the token, and what comes back out of it after verification. */
export interface JwtPayload {
  /** Subject — the user id. Never the username, which can change. */
  sub: string
  username: string
  roles: Role[]
  iss?: string
  aud?: string
  iat?: number
  exp?: number
}
