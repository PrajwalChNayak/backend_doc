// !!! DELIBERATELY VULNERABLE — DO NOT COPY !!!
import { Module } from '@nestjs/common'
import { VulnerableProductsRepository } from './products.repository.js'

@Module({
  providers: [VulnerableProductsRepository],
  exports: [VulnerableProductsRepository],
})
export class VulnerableQueriesModule {}
