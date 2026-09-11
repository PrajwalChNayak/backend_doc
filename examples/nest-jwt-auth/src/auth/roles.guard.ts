/**
 * Authorisation, as opposed to authentication. It runs AFTER the JWT guard has
 * put a user on the request, and it fails closed: a handler with @Roles() and no
 * authenticated user is a 403, never a pass.
 */
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import type { Request } from 'express'
import { ROLES_KEY } from './roles.decorator.js'
import type { PublicUser, Role } from '../users/users.service.js'

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ])
    // No @Roles() on this route: authorisation is not this guard's business.
    if (!required || required.length === 0) return true

    const request = context.switchToHttp().getRequest<Request & { user?: PublicUser }>()
    const user = request.user
    if (!user) throw new ForbiddenException('Not authenticated')

    const allowed = required.some((role) => user.roles.includes(role))
    if (!allowed) {
      // 403, not 404: the caller is authenticated and the resource exists, they
      // are simply not allowed. (A 404 is the right answer for a resource whose
      // existence they should not learn — see nest-fixed.)
      throw new ForbiddenException(`Requires one of: ${required.join(', ')}`)
    }
    return true
  }
}
