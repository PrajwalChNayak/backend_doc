/**
 * Entry point. Compiled to `dist/main.js` by `npm run build` and started with
 * `node dist/main.js` — there is no TypeScript at runtime.
 *
 * `reflect-metadata` must be imported before any decorated class is loaded:
 * `emitDecoratorMetadata` output calls `Reflect.metadata(...)`, which only
 * exists once the polyfill has run.
 */
import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module.js'

const PORT = Number(process.env.PORT ?? 3030)

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule)

  // Routes SIGTERM/SIGINT into Nest's onModuleDestroy / onApplicationShutdown
  // hooks instead of dropping the process where it stands.
  app.enableShutdownHooks()

  await app.listen(PORT)
  console.log(`nest-minimal-api listening on http://localhost:${PORT}`)
}

bootstrap().catch((err) => {
  console.error('failed to start', err)
  process.exit(1)
})
