import { Module, OnModuleInit } from '@nestjs/common'
import { MongooseModule } from '@nestjs/mongoose'
import { Category, CategorySchema } from './category.schema.js'
import { Product, ProductSchema } from './product.schema.js'
import { ProductsController } from './products.controller.js'
import { ProductsService } from './products.service.js'

@Module({
  // forFeature registers the models for this module, the same way
  // TypeOrmModule.forFeature registers repositories.
  imports: [
    MongooseModule.forFeature([
      { name: Product.name, schema: ProductSchema },
      { name: Category.name, schema: CategorySchema },
    ]),
  ],
  controllers: [ProductsController],
  providers: [ProductsService],
})
export class ProductsModule implements OnModuleInit {
  constructor(private readonly products: ProductsService) {}

  /** Idempotent fixtures, so the example has something to show on first boot. */
  async onModuleInit(): Promise<void> {
    await this.products.seed()
  }
}
