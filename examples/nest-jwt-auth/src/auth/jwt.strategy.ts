/**
 * The passport-jwt strategy. Everything interesting is in the options.
 */
import { Injectable, UnauthorizedException } from '@nestjs/common'
import { PassportStrategy } from '@nestjs/passport'
import { ExtractJwt, Strategy, type StrategyOptionsWithoutRequest } from 'passport-jwt'
import { JWT_AUDIENCE, JWT_ISSUER, JWT_SECRET } from '../config.js'
import { UsersService, type PublicUser } from '../users/users.service.js'
import type { JwtPayload } from './jwt-payload.js'

const options: StrategyOptionsWithoutRequest = {
  jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
  secretOrKey: JWT_SECRET,

  // PIN THE ALGORITHM. Without `algorithms`, a verifier will accept whatever
  // the token's own header asks for — which is how the `alg: "none"` and
  // RS256→HS256 confusion attacks work. The list is yours, not the token's.
  algorithms: ['HS256'],

  // Checked on verify, not just set on sign. A token minted by a different
  // service that happens to share the secret is still rejected here.
  issuer: JWT_ISSUER,
  audience: JWT_AUDIENCE,

  // Never true. An expired token is an expired token.
  ignoreExpiration: false,
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(private readonly users: UsersService) {
    super(options)
  }

  /**
   * Runs only after the signature, `exp`, `iss` and `aud` have all passed.
   * Whatever it returns becomes `request.user`.
   *
   * Re-reading the user here means a deleted or demoted account stops working
   * immediately instead of at token expiry. That costs a lookup per request and
   * is usually worth it; if it is not, cache it — do not skip it silently.
   */
  async validate(payload: JwtPayload): Promise<PublicUser> {
    const user = this.users.findById(payload.sub)
    if (!user) throw new UnauthorizedException('Token subject no longer exists')
    return UsersService.toPublic(user)
  }
}
