import { createApp } from './app.js'
import { prisma, close, databaseFile } from './db.js'
import { seedIfEmpty } from './seed.js'

// Prisma does not create tables at boot — that is `prisma migrate deploy`, run
// by `npm run setup`. If the migration has not been applied, the first query
// fails with a "no such table" error, so check for it here and say so plainly.
try {
  await prisma.$queryRaw`SELECT 1`
  await prisma.user.count()
} catch (err) {
  console.error(
    [
      '',
      '  The database schema is not ready.',
      '',
      `    database : ${databaseFile}`,
      // Prisma's message starts with a blank line and the failing invocation,
      // so take the first line that actually says something.
      `    error    : ${String(err.message).split('\n').map((l) => l.trim()).find(Boolean) ?? err.name}`,
      '',
      '  Apply the migrations first:',
      '',
      '    npm run setup      # prisma migrate deploy && prisma generate',
      '',
    ].join('\n'),
  )
  await close()
  process.exit(1)
}

const seeded = await seedIfEmpty()

const app = createApp()
const port = Number(process.env.PORT ?? 3020)

const server = app.listen(port, (err) => {
  if (err) throw err
  console.log(`orm-prisma listening on http://localhost:${port}`)
  console.log(`  database: ${databaseFile}`)
  console.log(`  seed:     ${seeded.seeded ? 'inserted fixtures' : `already had ${seeded.users} users`}`)
})

function shutdown(signal) {
  console.log(`\n${signal} received, closing`)
  server.close(async () => {
    await close()
    process.exit(0)
  })
  server.closeIdleConnections?.()
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
