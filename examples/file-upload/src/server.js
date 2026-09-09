import { createApp } from './app.js'
import { UPLOAD_DIR, QUARANTINE_DIR } from './storage.js'

const app = createApp()
const port = Number(process.env.PORT ?? 3003)

// Express 5 hands a bind error to the callback rather than throwing it.
const server = app.listen(port, (err) => {
  if (err) {
    console.error('failed to bind port', port, err)
    process.exit(1)
  }
  console.log(`file-upload listening on http://localhost:${port}`)
  console.log(`  quarantine: ${QUARANTINE_DIR}`)
  console.log(`  accepted:   ${UPLOAD_DIR}`)
})

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    console.log(`${signal} received, closing server`)
    server.close(() => process.exit(0))
    server.closeIdleConnections?.()
  })
}
