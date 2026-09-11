// !!! DELIBERATELY VULNERABLE — DO NOT COPY !!!
import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { CatalogController } from './catalog.controller.js'
import { dataSourceOptions } from './data-source.options.js'
import { Order } from './entities/order.entity.js'
import { HealthController } from './health.controller.js'
import { OrdersController } from './orders.controller.js'
import { VulnerableQueriesModule } from './vulnerable-queries/vulnerable-queries.module.js'

@Module({
  imports: [
    TypeOrmModule.forRoot({ ...dataSourceOptions, retryAttempts: 0 }),
    TypeOrmModule.forFeature([Order]),
    VulnerableQueriesModule,
  ],
  controllers: [HealthController, CatalogController, OrdersController],
})
export class AppModule {}
