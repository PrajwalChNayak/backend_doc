import { SetMetadata } from '@nestjs/common'
import type { Role } from '../users/users.service.js'

export const ROLES_KEY = 'auth:roles'

/** `@Roles('admin')` — metadata only. RolesGuard is what enforces it. */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles)
