import { Module } from '@nestjs/common'
import { UsersController } from './users.controller.js'
import { UsersService } from './users.service.js'

// No imports: PrismaModule is @Global, so PrismaService is already injectable.
@Module({
  controllers: [UsersController],
  providers: [UsersService],
})
export class UsersModule {}
