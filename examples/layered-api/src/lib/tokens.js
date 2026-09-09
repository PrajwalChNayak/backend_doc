/**
 * JWT issue/verify with `jsonwebtoken`.
 *
 * Three things here are load-bearing and are the three things real applications
 * most often get wrong:
 *
 *   1. `algorithms: ['HS256']` on verify. Without an explicit allow-list an
 *      attacker chooses the algorithm, which is how the `alg: none` and the
 *      RS256->HS256 confusion attacks work.
 *   2. `issuer` and `audience` on verify. A token minted by a different service
 *      that happens to share the secret must not be accepted here.
 *   3. A short `expiresIn`. Access tokens cannot be revoked; keep them brief.
 */
import jwt from 'jsonwebtoken'
import config from '../config.js'

export function signAccessToken({ userId, email }) {
  return jwt.sign({ email }, config.jwt.secret, {
    algorithm: config.jwt.algorithm,
    subject: String(userId),
    issuer: config.jwt.issuer,
    audience: config.jwt.audience,
    expiresIn: config.jwt.expiresIn,
  })
}

/**
 * @returns {{ sub: string, email: string, iat: number, exp: number }}
 * @throws {jwt.JsonWebTokenError} on any failure — expired, wrong signature,
 *   wrong issuer/audience, or a disallowed algorithm.
 */
export function verifyAccessToken(token) {
  return jwt.verify(token, config.jwt.secret, {
    algorithms: [config.jwt.algorithm],
    issuer: config.jwt.issuer,
    audience: config.jwt.audience,
  })
}
