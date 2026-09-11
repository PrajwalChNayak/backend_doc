/**
 * Entry point. The three global registrations here are the whole request
 * pipeline for this app:
 *
 *   ValidationPipe      every @Body/@Query becomes a checked DTO instance
 *   HttpExceptionFilter every failure gets one shape
 *   (the guard and the interceptor are controller-scoped — see tasks.controller)
 *
 * Order at runtime, for one request:
 *   middleware -> guard -> interceptor (pre) -> pipe -> handler
 *              -> interceptor (post) -> filter (only on the error path)
 */
import 'reflect-metadata'
import { ValidationPipe } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module.js'
import { HttpExceptionFilter } from './common/http-exception.filter.js'

const PORT = Number(process.env.PORT ?? 3031)

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule)

  app.useGlobalPipes(
    new ValidationPipe({
      // Drop any property the DTO does not declare…
      whitelist: true,
      // …and reject the request instead of dropping it silently. This is the
      // mass-assignment defence: {"title":"x","status":"done","isAdmin":true}
      // is a 400, not a task that quietly ignored one field.
      forbidNonWhitelisted: true,
      // Turn the plain body/query object into an instance of the DTO class, so
      // @Type(() => Number) and default values apply.
      transform: true,
      transformOptions: {
        // Leave implicit string->number coercion off: be explicit with @Type.
        enableImplicitConversion: false,
      },
    }),
  )

  app.useGlobalFilters(new HttpExceptionFilter())
  app.enableShutdownHooks()

  await app.listen(PORT)
  console.log(`nest-crud-module listening on http://localhost:${PORT}`)
}

bootstrap().catch((err) => {
  console.error('failed to start', err)
  process.exit(1)
})
