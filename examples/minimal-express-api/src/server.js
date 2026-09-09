/**
 * src/server.js — the only file that binds a port.
 */
import app from './app.js'

const port = Number(process.env.PORT ?? 3001)

// Express 5 change: `app.listen()` passes a server 'error' to the callback
// instead of throwing it. Handle the first argument or you will silently ignore
// EADDRINUSE.
const server = app.listen(port, (err) => {
  if (err) {
    console.error('failed to bind port', port, err)
    process.exit(1)
  }
  console.log(`minimal-express-api listening on http://localhost:${port}`)
})

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    console.log(`${signal} received, closing server`)
    server.close(() => process.exit(0))
    server.closeIdleConnections?.()
  })
}
