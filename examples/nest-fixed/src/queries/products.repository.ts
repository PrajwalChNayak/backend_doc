/**
 * The fixed repository. Compare examples/nest-vulnerable/src/vulnerable-queries.
 *
 * Values are bound with `?` placeholders. The one thing you cannot bind — an
 * identifier such as a sort column — is validated against an allow-list before
 * it is interpolated, and only the vetted constant is used.
 */
import { BadRequestException, Injectable } from '@nestjs/common'
import { InjectDataSource } from '@nestjs/typeorm'
import { DataSource } from 'typeorm'

/** The only column names a caller may sort by. */
const SORTABLE = new Set(['id', 'name', 'price_cents'])

@Injectable()
export class ProductsRepository {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /**
   * FIXED: the search term is a BIND PARAMETER. The `%` wildcards are added to
   * the value, not to the SQL, so `' OR '1'='1` is looked up as a literal
   * product name and matches nothing.
   */
  async search(term: string): Promise<unknown[]> {
    return this.dataSource.query(
      'SELECT id, name, price_cents FROM products WHERE name LIKE ? ORDER BY id',
      [`%${term}%`],
    )
  }

  /**
   * FIXED: you cannot bind an identifier, so validate it. `sortColumn` is
   * rejected unless it is one of a known-safe set; only the vetted value is
   * interpolated.
   */
  async listSorted(sortColumn: string): Promise<unknown[]> {
    if (!SORTABLE.has(sortColumn)) {
      throw new BadRequestException(`Cannot sort by ${sortColumn}`)
    }
    // lint-sql:allow sortColumn is checked against the SORTABLE allow-list above
    return this.dataSource.query(`SELECT id, name, price_cents FROM products ORDER BY ${sortColumn}`)
  }
}
