// !!! DELIBERATELY VULNERABLE — DO NOT COPY !!!
import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module.js'
import { databaseFile } from './data-source.options.js'

const PORT = Number(process.env.PORT ?? 3038)

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule)
  app.enableShutdownHooks()
  await app.listen(PORT)
  console.log('')
  console.log('  !!! nest-vulnerable is DELIBERATELY INSECURE !!!')
  console.log('  SQL injection on GET /products/search, IDOR on GET /orders/:id.')
  console.log('  Never expose this port to a network you do not control.')
  console.log('')
  console.log(`  listening on http://localhost:${PORT} (db: ${databaseFile})`)
}

bootstrap().catch((err) => {
  console.error('failed to start', err)
  process.exit(1)
})
