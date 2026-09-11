import { Module } from '@nestjs/common'
import { HealthController } from './health.controller.js'
import { TasksModule } from './tasks/tasks.module.js'

@Module({
  imports: [TasksModule],
  controllers: [HealthController],
})
export class AppModule {}
