import { createApp } from './app.js'

const app = createApp()
const port = Number(process.env.PORT ?? 3005)

const server = app.listen(port, (err) => {
  if (err) {
    console.error('failed to bind port', port, err)
    process.exit(1)
  }
  console.log(`fixed-sql-injection listening on http://localhost:${port}`)
})

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close(() => process.exit(0))
    server.closeIdleConnections?.()
  })
}
