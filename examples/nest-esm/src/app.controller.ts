// Note the `.js` on the relative import below, even though the source file is
// `app.service.ts`. Under nodenext, relative specifiers must carry the
// extension of the EMITTED file, which is `.js`. TypeScript resolves it back to
// app.service.ts at compile time; Node loads app.service.js at runtime.
import { Controller, Get } from '@nestjs/common'
import { AppService } from './app.service.js'

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get('health')
  health() {
    return this.appService.health()
  }

  @Get()
  root() {
    return this.appService.info()
  }
}
