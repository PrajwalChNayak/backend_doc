/**
 * Builds the application WITHOUT binding a port, so tests can drive it through
 * supertest. `app.init()` runs the same module initialisation `listen()` would;
 * `app.getHttpServer()` hands supertest the underlying Node server.
 */
import 'reflect-metadata'
import { ValidationPipe, type INestApplication } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module.js'

export async function createTestApp(): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule, { logger: false })
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  )
  await app.init()
  return app
}
