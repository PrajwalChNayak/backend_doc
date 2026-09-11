import 'reflect-metadata'
import type { INestApplication } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module.js'

/**
 * There is deliberately no multer exception filter here.
 *
 * In bare Express you must catch `MulterError` yourself or a size-limit breach
 * becomes a 500. `@nestjs/platform-express@12` already does it: its
 * `transformException` maps multer's messages onto HTTP exceptions —
 * "File too large" → 413 PayloadTooLargeException, and "Too many files",
 * "Too many parts", "Field name too long", "Unexpected field" and the busboy
 * parse errors → 400 BadRequestException. A filter of your own here is dead
 * code; the mapping happens before any filter sees the error.
 */
export async function createApp(options: { silent?: boolean } = {}): Promise<INestApplication> {
  return NestFactory.create(AppModule, options.silent ? { logger: false } : {})
}
