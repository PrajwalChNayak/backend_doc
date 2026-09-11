/**
 * A guard answers one question: may this request reach the handler?
 *
 * It runs after middleware and before pipes, so it sees the raw request and
 * never sees a validated DTO. That ordering is deliberate — rejecting an
 * unauthenticated request should not depend on its body parsing cleanly.
 */
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { timingSafeEqual } from 'node:crypto'
import type { Request } from 'express'
import { IS_PUBLIC_KEY } from './public.decorator.js'

/** Constant-time compare so the key cannot be recovered one byte at a time. */
function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

@Injectable()
export class ApiKeyGuard implements CanActivate {
  private readonly apiKey = process.env.API_KEY ?? 'dev-secret-key'

  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    // getAllAndOverride looks at the handler first, then the controller class,
    // so a method-level @Public() beats a class-level setting.
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ])
    if (isPublic) return true

    const request = context.switchToHttp().getRequest<Request>()
    const presented = request.header('x-api-key')
    if (!presented || !sameSecret(presented, this.apiKey)) {
      // The message never says whether the header was missing or wrong.
      throw new UnauthorizedException('A valid x-api-key header is required')
    }
    return true
  }
}
