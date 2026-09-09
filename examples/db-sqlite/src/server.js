import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createApp } from './app.js'
import { createNodeSqliteStore } from './node-sqlite-store.js'
import { createBetterSqliteStore } from './better-sqlite3-store.js'
import { seedStore } from './seed.js'

const here = dirname(fileURLToPath(import.meta.url))
const dataDir = process.env.DATA_DIR ?? join(here, '..', 'data')
mkdirSync(dataDir, { recursive: true })

// One file per driver so the two halves of the API stay independent.
const nodeSqlite = createNodeSqliteStore(join(dataDir, 'node-sqlite.db'))
const betterSqlite = createBetterSqliteStore(join(dataDir, 'better-sqlite3.db'))

// Each driver owns a separate file, so each one needs its own seed — otherwise
// only whichever half you happened to POST to has any rows in it, and the
// side-by-side comparison the example exists for does not work. seedStore() is
// idempotent, so restarting against an existing data/ directory is a no-op.
const seeded = [seedStore(nodeSqlite), seedStore(betterSqlite)]

const app = createApp({ nodeSqlite, betterSqlite })
const port = Number(process.env.PORT ?? 3010)

const server = app.listen(port, (err) => {
  if (err) throw err
  console.log(`db-sqlite listening on http://localhost:${port}`)
  console.log(`  data directory: ${dataDir}`)
  for (const s of seeded) {
    console.log(`  seed ${s.driver}: ${s.created} user(s) inserted, ${s.users} total`)
  }
})

function shutdown(signal) {
  console.log(`\n${signal} received, closing`)
  server.close(() => {
    nodeSqlite.close()
    betterSqlite.close()
    process.exit(0)
  })
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
