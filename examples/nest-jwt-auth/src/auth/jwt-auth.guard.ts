import { Injectable } from '@nestjs/common'
import { AuthGuard } from '@nestjs/passport'

/**
 * A named subclass so routes read `@UseGuards(JwtAuthGuard)` instead of
 * `@UseGuards(AuthGuard('jwt'))` — and so the strategy name is written once.
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {}
