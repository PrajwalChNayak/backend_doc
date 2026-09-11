import 'reflect-metadata'
import { ValidationPipe } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module.js'
import { databaseFile } from './prisma/prisma.service.js'

const PORT = Number(process.env.PORT ?? 3034)

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule)
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  )
  // Without this, PrismaService.onModuleDestroy never runs on SIGTERM and the
  // process holds the database file open.
  app.enableShutdownHooks()
  await app.listen(PORT)
  console.log(`nest-prisma listening on http://localhost:${PORT} (db: ${databaseFile})`)
}

bootstrap().catch((err) => {
  console.error('failed to start', err)
  process.exit(1)
})
