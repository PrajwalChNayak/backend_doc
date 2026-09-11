import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { CatalogController } from './catalog.controller.js'
import { dataSourceOptions } from './data-source.options.js'
import { Order } from './entities/order.entity.js'
import { HealthController } from './health.controller.js'
import { OrdersController } from './orders.controller.js'
import { QueriesModule } from './queries/queries.module.js'

@Module({
  imports: [
    TypeOrmModule.forRoot({ ...dataSourceOptions, retryAttempts: 0 }),
    TypeOrmModule.forFeature([Order]),
    QueriesModule,
  ],
  controllers: [HealthController, CatalogController, OrdersController],
})
export class AppModule {}
