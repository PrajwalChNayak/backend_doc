import 'reflect-metadata'
import { ValidationPipe } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module.js'

const PORT = Number(process.env.PORT ?? 3036)

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule)
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  )
  app.enableShutdownHooks()
  await app.listen(PORT)
  console.log(`nest-jwt-auth listening on http://localhost:${PORT}`)
  if (!process.env.JWT_SECRET) {
    console.log('JWT_SECRET not set: using a random secret for this boot only')
  }
}

bootstrap().catch((err) => {
  console.error('failed to start', err)
  process.exit(1)
})
