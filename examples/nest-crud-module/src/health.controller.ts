/**
 * Liveness. Deliberately outside the tasks controller so it carries no guard,
 * no envelope and no dependencies — the body is exactly `{"status":"ok"}`.
 */
import { Controller, Get } from '@nestjs/common'

@Controller()
export class HealthController {
  @Get('health')
  health() {
    return { status: 'ok' }
  }
}
