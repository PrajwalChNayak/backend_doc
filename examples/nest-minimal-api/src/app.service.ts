/**
 * The service holds the logic. It is a plain class — `@Injectable()` only marks
 * it as something Nest is allowed to construct and inject.
 */
import { Injectable } from '@nestjs/common'

export interface HealthReport {
  status: 'ok'
}

export interface Greeting {
  message: string
  at: string
}

@Injectable()
export class AppService {
  private readonly bootedAt = new Date()

  /**
   * Liveness. It answers "this process is up and the event loop is turning",
   * nothing more — no database ping, no downstream call. A liveness probe that
   * checks a dependency restarts healthy processes during a database blip.
   */
  health(): HealthReport {
    return { status: 'ok' }
  }

  info() {
    return {
      name: 'nest-minimal-api',
      framework: 'NestJS 12 on Express 5',
      node: process.version,
      uptimeSeconds: Math.round((Date.now() - this.bootedAt.getTime()) / 1000),
    }
  }

  greet(name: string): Greeting {
    return { message: `Hello, ${name}!`, at: new Date().toISOString() }
  }
}
