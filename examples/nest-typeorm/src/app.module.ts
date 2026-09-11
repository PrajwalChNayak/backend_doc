import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { dataSourceOptions } from './data-source.options.js'
import { HealthController } from './health.controller.js'
import { UsersModule } from './users/users.module.js'

@Module({
  imports: [
    // forRoot opens exactly one DataSource for the process and makes it
    // injectable everywhere. `retryAttempts: 0` so a bad configuration fails
    // fast instead of retrying ten times over thirty seconds.
    TypeOrmModule.forRoot({ ...dataSourceOptions, retryAttempts: 0 }),
    UsersModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
