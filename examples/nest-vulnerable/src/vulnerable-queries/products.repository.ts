// !!! DELIBERATELY VULNERABLE — DO NOT COPY !!!
//
// This directory is named `vulnerable-queries` for a reason that is not
// cosmetic: `scripts/lint-sql.mjs` exempts any example file living under a path
// segment beginning with `vulnerable-` (CONTRIBUTING.md §7). That is how this
// file is allowed to exist in a repository whose whole point is that no
// injectable SQL ships by accident. Move it one directory up and the lint fails
// the build, which is exactly the intended behaviour.
//
// The bug: `search()` builds SQL by string interpolation. Everything the caller
// types becomes part of the statement.
import { Injectable } from '@nestjs/common'
import { InjectDataSource } from '@nestjs/typeorm'
import { DataSource } from 'typeorm'

@Injectable()
export class VulnerableProductsRepository {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /**
   * VULNERABLE. `term` is concatenated straight into the statement, so the
   * caller controls the SQL, not just the value. See exploit.md.
   *
   * The fix is one line, and it is in examples/nest-fixed:
   *   this.dataSource.query('… WHERE name LIKE ?', [`%${term}%`])
   */
  async search(term: string): Promise<unknown[]> {
    const sql = `SELECT id, name, price_cents FROM products WHERE name LIKE '%${term}%' ORDER BY id`
    // Also vulnerable: the raw SQL is echoed back to the caller below, which
    // hands an attacker the exact shape of the statement they are attacking.
    return this.dataSource.query(sql)
  }

  /** VULNERABLE for the same reason. The sort column is pasted in. */
  async listSorted(sortColumn: string): Promise<unknown[]> {
    const sql = `SELECT id, name, price_cents FROM products ORDER BY ${sortColumn}`
    return this.dataSource.query(sql)
  }

  /** Returns the statement so the README and exploit.md can show it. */
  lastStatementFor(term: string): string {
    return `SELECT id, name, price_cents FROM products WHERE name LIKE '%${term}%' ORDER BY id`
  }
}
