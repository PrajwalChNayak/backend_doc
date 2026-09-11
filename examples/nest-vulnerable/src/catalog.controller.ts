// !!! DELIBERATELY VULNERABLE — DO NOT COPY !!!
import { Controller, Get, Query } from '@nestjs/common'
import { VulnerableProductsRepository } from './vulnerable-queries/products.repository.js'

@Controller('products')
export class CatalogController {
  constructor(private readonly products: VulnerableProductsRepository) {}

  /**
   * VULNERABLE: `q` reaches the SQL statement as SQL.
   *
   * There is no validation, no allow-list and no bind parameter anywhere on
   * this path. `statement` is echoed back so the reader can watch their payload
   * become part of the query.
   */
  @Get('search')
  async search(@Query('q') q = '') {
    return {
      statement: this.products.lastStatementFor(q),
      rows: await this.products.search(q),
    }
  }

  /** VULNERABLE: the ORDER BY column comes straight from the query string. */
  @Get()
  async list(@Query('sort') sort = 'id') {
    return { rows: await this.products.listSorted(sort) }
  }
}
