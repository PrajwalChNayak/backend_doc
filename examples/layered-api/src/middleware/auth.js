/**
 * Bearer-token authentication.
 *
 * Authentication only — it answers "who is this?" and nothing else. Deciding
 * what that identity may touch is the service layer's job (see how every notes
 * query is scoped by `user_id`). Keeping the two apart is what stops the classic
 * "authenticated therefore authorized" bug.
 */
import { verifyAccessToken } from '../lib/tokens.js'
import { unauthorized } from '../errors.js'

export function requireAuth(req, res, next) {
  const header = req.get('authorization') ?? ''
  const [scheme, token] = header.split(' ')

  if (!token || scheme.toLowerCase() !== 'bearer') {
    // RFC 6750: tell the client how to authenticate.
    res.set('WWW-Authenticate', 'Bearer realm="layered-api"')
    next(unauthorized('Missing bearer token'))
    return
  }

  let claims
  try {
    claims = verifyAccessToken(token)
  } catch (err) {
    res.set(
      'WWW-Authenticate',
      `Bearer realm="layered-api", error="invalid_token", error_description="${
        err.name === 'TokenExpiredError' ? 'token expired' : 'token invalid'
      }"`,
    )
    // Never forward `err.message` to the client: it distinguishes "bad
    // signature" from "wrong audience", which helps an attacker tune a forgery.
    next(unauthorized('Invalid or expired token'))
    return
  }

  req.user = { id: claims.sub, email: claims.email }
  next()
}
