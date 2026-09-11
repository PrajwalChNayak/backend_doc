import { Module } from '@nestjs/common'
import { HealthController } from './health.controller.js'
import { UploadsModule } from './uploads/uploads.module.js'

@Module({
  imports: [UploadsModule],
  controllers: [HealthController],
})
export class AppModule {}
