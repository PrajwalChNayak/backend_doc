/**
 * Pure-ESM entry point. Differences from the CommonJS examples:
 *
 *   - package.json has "type": "module", so `dist/main.js` is loaded as ESM.
 *   - Relative imports carry a `.js` extension (see app.controller.ts).
 *   - `import.meta.dirname` replaces `__dirname` (see app.service.ts).
 *   - tsconfig sets module/moduleResolution to "nodenext" and
 *     resolvePackageJsonExports: true.
 *
 * Nest 12's own packages are ESM, so consuming them from an ESM app is the
 * native path — no require(esm) interop involved.
 */
import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module.js'

const PORT = Number(process.env.PORT ?? 3040)

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule)
  app.enableShutdownHooks()
  await app.listen(PORT)
  console.log(`nest-esm listening on http://localhost:${PORT}`)
}

bootstrap().catch((err) => {
  console.error('failed to start', err)
  process.exit(1)
})
