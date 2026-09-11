import { Module } from '@nestjs/common'
import { MongooseModule } from '@nestjs/mongoose'
import { MONGODB_URI } from './config.js'
import { HealthController } from './health.controller.js'
import { ProductsModule } from './products/products.module.js'

@Module({
  imports: [
    MongooseModule.forRoot(MONGODB_URI, {
      // Fail fast instead of ten retries over thirty seconds — the point of this
      // example is a clear message when MongoDB is absent.
      retryAttempts: 0,
      serverSelectionTimeoutMS: 3000,
      connectTimeoutMS: 3000,
    }),
    ProductsModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
