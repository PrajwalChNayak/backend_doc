import { Controller, Get } from '@nestjs/common'
import { PrismaService } from './prisma/prisma.service.js'

@Controller()
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  /** Liveness: no database call. */
  @Get('health')
  health() {
    return { status: 'ok' }
  }

  /**
   * Readiness: one trivial query through the real client.
   *
   * `Number(...)` is not decoration. SQLite integers come back from `$queryRaw`
   * as **BigInt** through the better-sqlite3 adapter, so `rows[0].ok === 1` is
   * false and `JSON.stringify` on the raw row throws
   * "Do not know how to serialize a BigInt". Normalise raw rows at the edge.
   */
  @Get('ready')
  async ready() {
    const rows = await this.prisma.$queryRaw<Array<{ ok: bigint }>>`SELECT 1 AS ok`
    return { status: Number(rows[0]?.ok) === 1 ? 'ok' : 'degraded', client: 'prisma@7' }
  }
}
