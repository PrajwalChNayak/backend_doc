import { createApp } from './app-factory.js'
import { UPLOAD_DIR } from './uploads/uploads.service.js'

const PORT = Number(process.env.PORT ?? 3037)

async function bootstrap(): Promise<void> {
  const app = await createApp()
  app.enableShutdownHooks()
  await app.listen(PORT)
  console.log(`nest-file-upload listening on http://localhost:${PORT}`)
  console.log(`uploads are written to ${UPLOAD_DIR} (outside any static root)`)
}

bootstrap().catch((err) => {
  console.error('failed to start', err)
  process.exit(1)
})
