/**
 * A feature module. `TasksRepository` and `TasksService` are private to it —
 * nothing outside can inject them unless this module `exports` them.
 */
import { Module } from '@nestjs/common'
import { TasksController } from './tasks.controller.js'
import { TasksRepository } from './tasks.repository.js'
import { TasksService } from './tasks.service.js'

@Module({
  controllers: [TasksController],
  providers: [TasksService, TasksRepository],
  exports: [TasksService],
})
export class TasksModule {}
