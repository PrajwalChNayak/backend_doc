import { Controller, Get, Query } from '@nestjs/common'
import { ProductsRepository } from './queries/products.repository.js'

@Controller('products')
export class CatalogController {
  constructor(private readonly products: ProductsRepository) {}

  /** FIXED: `q` is passed as a bound value, never concatenated into SQL. */
  @Get('search')
  async search(@Query('q') q = '') {
    return { rows: await this.products.search(q) }
  }

  /** FIXED: the sort column is validated against an allow-list in the repository. */
  @Get()
  async list(@Query('sort') sort = 'id') {
    return { rows: await this.products.listSorted(sort) }
  }
}
