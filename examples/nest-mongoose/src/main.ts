/**
 * This is the one example in the NestJS set that needs a real server.
 *
 * A pre-flight connection attempt happens BEFORE Nest boots so the failure is a
 * sentence a human can act on, rather than a Mongoose stack trace with a
 * thirty-second retry loop in front of it.
 */
import 'reflect-metadata'
import { ValidationPipe } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import mongoose from 'mongoose'
import { AppModule } from './app.module.js'
import { DOCKER_HINT, MONGODB_URI } from './config.js'

const PORT = Number(process.env.PORT ?? 3035)

async function preflight(): Promise<void> {
  const connection = await mongoose
    .createConnection(MONGODB_URI, {
      serverSelectionTimeoutMS: 3000,
      connectTimeoutMS: 3000,
    })
    .asPromise()
  await connection.close()
}

async function bootstrap(): Promise<void> {
  try {
    await preflight()
  } catch (err) {
    console.error(DOCKER_HINT)
    console.error(`  (driver said: ${(err as Error).message})`)
    process.exit(1)
  }

  const app = await NestFactory.create(AppModule)
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  )
  app.enableShutdownHooks()
  await app.listen(PORT)
  console.log(`nest-mongoose listening on http://localhost:${PORT} (mongodb: ${MONGODB_URI})`)
}

bootstrap().catch((err) => {
  console.error('failed to start', err)
  process.exit(1)
})
