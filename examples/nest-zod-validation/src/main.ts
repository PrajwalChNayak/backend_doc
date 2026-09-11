/**
 * Two global registrations do all of the work:
 *
 *   StandardSchemaValidationPipe        reads `@Body({ schema })` / `@Query({ schema })`
 *   StandardSchemaSerializerInterceptor reads `@SerializeOptions({ schema })`
 *
 * Both are new in Nest 12 and both are library-agnostic — they only require an
 * object implementing the Standard Schema spec, which Zod 4, Valibot 1 and
 * ArkType 2 all do natively.
 */
import 'reflect-metadata'
import {
  BadRequestException,
  StandardSchemaSerializerInterceptor,
  StandardSchemaValidationPipe,
} from '@nestjs/common'
import { NestFactory, Reflector } from '@nestjs/core'
import { AppModule } from './app.module.js'

const PORT = Number(process.env.PORT ?? 3032)

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule)

  app.useGlobalPipes(
    new StandardSchemaValidationPipe({
      // Return the schema's OUTPUT (defaults applied, strings coerced).
      // Defaults to true; spelled out because it is the whole point.
      transform: true,
      // Parameters made with createParamDecorator are skipped unless you opt in.
      validateCustomDecorators: false,
      // Shape the 400 body yourself. `issues` is the Standard Schema issue list:
      // `{ message, path }`, where path entries may be keys or objects.
      exceptionFactory: (issues) =>
        new BadRequestException({
          error: {
            code: 'VALIDATION_FAILED',
            message: 'Request validation failed',
            issues: issues.map((issue) => ({
              path: (issue.path ?? [])
                .map((segment) =>
                  typeof segment === 'object' && segment !== null ? String(segment.key) : String(segment),
                )
                .join('.'),
              message: issue.message,
            })),
          },
        }),
    }),
  )

  // The serializer interceptor needs the Reflector to read @SerializeOptions.
  app.useGlobalInterceptors(new StandardSchemaSerializerInterceptor(app.get(Reflector)))

  app.enableShutdownHooks()
  await app.listen(PORT)
  console.log(`nest-zod-validation listening on http://localhost:${PORT}`)
}

bootstrap().catch((err) => {
  console.error('failed to start', err)
  process.exit(1)
})
