import { Module } from '@nestjs/common'
import { ProductsRepository } from './products.repository.js'

@Module({
  providers: [ProductsRepository],
  exports: [ProductsRepository],
})
export class QueriesModule {}
