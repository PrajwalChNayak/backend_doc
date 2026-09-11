import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module.js'
import { databaseFile } from './data-source.options.js'

const PORT = Number(process.env.PORT ?? 3039)

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule)
  app.enableShutdownHooks()
  await app.listen(PORT)
  console.log(`nest-fixed listening on http://localhost:${PORT} (db: ${databaseFile})`)
}

bootstrap().catch((err) => {
  console.error('failed to start', err)
  process.exit(1)
})
