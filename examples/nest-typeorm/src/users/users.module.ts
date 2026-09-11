import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { Post } from '../posts/post.entity.js'
import { User } from './user.entity.js'
import { UsersController } from './users.controller.js'
import { UsersService } from './users.service.js'

@Module({
  // forFeature registers the repository providers for THESE entities in THIS
  // module. Forgetting it is the classic "Nest can't resolve dependencies of
  // UsersService (?)" error.
  imports: [TypeOrmModule.forFeature([User, Post])],
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
