/**
 * The controller is the HTTP layer and only the HTTP layer: it maps a method
 * and a path onto a service call and returns a plain object. Nest serialises
 * the return value to JSON and picks the status code (200, or 201 for POST).
 */
import { Controller, Get, NotFoundException, Param, Post, Query } from '@nestjs/common'
import { AppService } from './app.service.js'

@Controller()
export class AppController {
  // Constructor injection. `emitDecoratorMetadata` writes the parameter type
  // into `design:paramtypes`, which is how Nest knows to pass an AppService.
  constructor(private readonly appService: AppService) {}

  @Get('health')
  health() {
    return this.appService.health()
  }

  @Get()
  root() {
    return this.appService.info()
  }

  @Get('greet/:name')
  greet(@Param('name') name: string) {
    if (!/^[\p{L}\p{N} _-]{1,40}$/u.test(name)) {
      throw new NotFoundException(`No greeting for ${JSON.stringify(name)}`)
    }
    return this.appService.greet(name)
  }

  /**
   * `@Query()` reads `req.query`, which is a getter in Express 5 and therefore
   * read-only. Nest hands you a copy, so you never assign to it.
   */
  @Get('echo')
  echo(@Query('msg') msg?: string) {
    return { echo: msg ?? null, received: new Date().toISOString() }
  }

  /**
   * A POST returns 201 by default in Nest. Override it with `@HttpCode(200)`
   * when the route is not creating anything.
   */
  @Post('echo')
  echoBody(@Query('tag') tag?: string) {
    return { tag: tag ?? null, ok: true }
  }
}
