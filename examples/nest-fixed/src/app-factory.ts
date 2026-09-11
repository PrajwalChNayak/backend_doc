import 'reflect-metadata'
import type { INestApplication } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module.js'

export async function createApp(options: { silent?: boolean } = {}): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule, options.silent ? { logger: false } : {})
  await app.init()
  return app
}
