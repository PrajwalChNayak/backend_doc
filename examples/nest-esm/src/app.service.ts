import { Injectable } from '@nestjs/common'

@Injectable()
export class AppService {
  private readonly bootedAt = new Date()

  health() {
    return { status: 'ok' }
  }

  info() {
    return {
      name: 'nest-esm',
      moduleSystem: 'ESM ("type": "module")',
      framework: 'NestJS 12 on Express 5',
      node: process.version,
      // import.meta is available because this file is a real ES module. In the
      // CommonJS examples this would be `__dirname`, which does not exist here.
      entryDir: import.meta.dirname,
      uptimeSeconds: Math.round((Date.now() - this.bootedAt.getTime()) / 1000),
    }
  }
}
