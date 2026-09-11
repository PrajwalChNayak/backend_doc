import { Module } from '@nestjs/common'
import { JwtModule } from '@nestjs/jwt'
import { PassportModule } from '@nestjs/passport'
import { JWT_AUDIENCE, JWT_EXPIRES_IN, JWT_ISSUER, JWT_SECRET } from '../config.js'
import { UsersModule } from '../users/users.module.js'
import { AuthController } from './auth.controller.js'
import { AuthService } from './auth.service.js'
import { JwtStrategy } from './jwt.strategy.js'

@Module({
  imports: [
    UsersModule,
    PassportModule.register({ defaultStrategy: 'jwt', session: false }),
    JwtModule.register({
      secret: JWT_SECRET,
      signOptions: {
        // Sign with exactly the algorithm the strategy will accept.
        algorithm: 'HS256',
        expiresIn: JWT_EXPIRES_IN,
        issuer: JWT_ISSUER,
        audience: JWT_AUDIENCE,
      },
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy],
  // PassportModule has to be re-exported, not just imported. `JwtAuthGuard`
  // extends `AuthGuard('jwt')`, which injects `AuthModuleOptions` — a provider
  // that lives in PassportModule. Any module whose controllers use the guard
  // needs it in scope, and AdminController lives in AppModule. Without this
  // line Nest fails at boot with:
  //   "Nest can't resolve dependencies of the JwtAuthGuard (?).
  //    Please make sure that the argument AuthModuleOptions at index [0]
  //    is available in the AppModule module."
  exports: [AuthService, PassportModule],
})
export class AuthModule {}
