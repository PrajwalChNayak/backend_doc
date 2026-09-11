import { Controller, Get, ServiceUnavailableException } from '@nestjs/common'
import { InjectConnection } from '@nestjs/mongoose'
import { Connection } from 'mongoose'

const STATES: Record<number, string> = {
  0: 'disconnected',
  1: 'connected',
  2: 'connecting',
  3: 'disconnecting',
}

@Controller()
export class HealthController {
  constructor(@InjectConnection() private readonly connection: Connection) {}

  /** Liveness: the process is up. It says nothing about MongoDB on purpose. */
  @Get('health')
  health() {
    return { status: 'ok' }
  }

  /** Readiness: 503 when the driver is not connected, so a balancer stops routing here. */
  @Get('ready')
  ready() {
    const state = STATES[this.connection.readyState] ?? 'unknown'
    if (state !== 'connected') {
      throw new ServiceUnavailableException({ status: 'degraded', mongodb: state })
    }
    return { status: 'ok', mongodb: state, database: this.connection.name }
  }
}
