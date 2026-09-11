import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req, UseGuards } from '@nestjs/common'
import type { Request } from 'express'
import { AuthService } from './auth.service.js'
import { LoginDto } from './dto.js'
import { JwtAuthGuard } from './jwt-auth.guard.js'
import type { PublicUser } from '../users/users.service.js'

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /** 200, not 201: logging in creates no resource. */
  @Post('login')
  @HttpCode(HttpStatus.OK)
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto.username, dto.password)
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  me(@Req() request: Request & { user: PublicUser }) {
    // `request.user` is whatever JwtStrategy.validate() returned.
    return { user: request.user }
  }
}
