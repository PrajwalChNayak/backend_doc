import { Controller, Get, UseGuards } from '@nestjs/common'
import { JwtAuthGuard } from './auth/jwt-auth.guard.js'
import { Roles } from './auth/roles.decorator.js'
import { RolesGuard } from './auth/roles.guard.js'
import { UsersService } from './users/users.service.js'

@Controller('admin')
// Order matters: JwtAuthGuard authenticates and sets request.user, RolesGuard
// then reads it. Swap them and RolesGuard always sees an anonymous request.
@UseGuards(JwtAuthGuard, RolesGuard)
export class AdminController {
  constructor(private readonly users: UsersService) {}

  @Get('stats')
  @Roles('admin')
  stats() {
    return { users: this.users.count(), generatedAt: new Date().toISOString() }
  }
}
