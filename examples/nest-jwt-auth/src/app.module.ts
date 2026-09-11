import { Module } from '@nestjs/common'
import { AdminController } from './admin.controller.js'
import { AuthModule } from './auth/auth.module.js'
import { HealthController } from './health.controller.js'
import { UsersModule } from './users/users.module.js'

@Module({
  imports: [AuthModule, UsersModule],
  controllers: [HealthController, AdminController],
})
export class AppModule {}
