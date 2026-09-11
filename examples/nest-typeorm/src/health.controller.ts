import { Controller, Get } from '@nestjs/common'
import { InjectDataSource } from '@nestjs/typeorm'
import { DataSource } from 'typeorm'

@Controller()
export class HealthController {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /** Liveness: no database call. */
  @Get('health')
  health() {
    return { status: 'ok' }
  }

  /** Readiness: one trivial parameterised query, so it proves the pool works. */
  @Get('ready')
  async ready() {
    const rows = await this.dataSource.query('SELECT 1 AS ok')
    return { status: rows?.[0]?.ok === 1 ? 'ok' : 'degraded', driver: 'better-sqlite3' }
  }
}
