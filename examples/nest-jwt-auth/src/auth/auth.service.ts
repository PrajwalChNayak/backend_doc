import { Injectable, UnauthorizedException } from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import { JWT_AUDIENCE, JWT_EXPIRES_IN, JWT_ISSUER } from '../config.js'
import { getDummyHash, verifyPassword } from '../lib/password.js'
import { UsersService, type PublicUser } from '../users/users.service.js'
import type { JwtPayload } from './jwt-payload.js'

@Injectable()
export class AuthService {
  constructor(
    private readonly users: UsersService,
    private readonly jwt: JwtService,
  ) {}

  async login(username: string, password: string) {
    const user = this.users.findByUsername(username)

    // Verify against a dummy hash when the user does not exist, so "no such
    // user" and "wrong password" cost the same and return the same body. An
    // early `return` here turns the endpoint into a user-enumeration oracle.
    const hash = user?.passwordHash ?? (await getDummyHash())
    const ok = await verifyPassword(password, hash)

    if (!user || !ok) throw new UnauthorizedException('Invalid username or password')

    const publicUser = UsersService.toPublic(user)
    const payload: JwtPayload = {
      sub: publicUser.id,
      username: publicUser.username,
      roles: publicUser.roles,
    }

    return {
      accessToken: await this.jwt.signAsync(payload),
      tokenType: 'Bearer',
      expiresIn: JWT_EXPIRES_IN,
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
      user: publicUser satisfies PublicUser,
    }
  }
}
