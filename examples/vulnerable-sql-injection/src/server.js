// !!! DELIBERATELY VULNERABLE — DO NOT COPY !!!
// Teaching material. Never deploy. Binds to localhost only, on purpose.

import { createApp } from './app.js'

const app = createApp()
const port = Number(process.env.PORT ?? 3004)

// Bind to loopback only. This app must never be reachable from another machine.
const server = app.listen(port, '127.0.0.1', (err) => {
  if (err) {
    console.error('failed to bind port', port, err)
    process.exit(1)
  }
  console.log('')
  console.log('  !!! DELIBERATELY VULNERABLE SQL-INJECTION DEMO !!!')
  console.log(`  listening on http://127.0.0.1:${port}  (loopback only)`)
  console.log('  This app is intentionally exploitable. Do not deploy it.')
  console.log('  See exploit.md for the payloads.')
  console.log('')
})

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close(() => process.exit(0))
    server.closeIdleConnections?.()
  })
}
