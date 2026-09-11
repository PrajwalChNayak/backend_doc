import { Module } from '@nestjs/common'
import { HealthController } from './health.controller.js'
import { PrismaModule } from './prisma/prisma.module.js'
import { UsersModule } from './users/users.module.js'

@Module({
  imports: [PrismaModule, UsersModule],
  controllers: [HealthController],
})
export class AppModule {}
