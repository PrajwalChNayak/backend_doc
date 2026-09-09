/**
 * One PrismaClient for the process.
 *
 * Prisma 7 changed how the client reaches a database: instead of reading the
 * connection URL out of `schema.prisma`, you hand the constructor a **driver
 * adapter**. The URL now lives in exactly two places — `prisma.config.js` for
 * the CLI (migrate, studio) and here for the runtime — and the client no longer
 * ships a Rust query engine binary.
 *
 * Creating a client per request is the classic Prisma mistake: each one opens
 * its own pool, and on a serverless platform it is how you exhaust the database
 * connection limit.
 */
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PrismaClient } from './generated/prisma/client.ts'
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3'

const here = dirname(fileURLToPath(import.meta.url))
const projectRoot = join(here, '..')

// Default matches prisma.config.js so the CLI and the server share one file.
export const databaseFile = process.env.DATABASE_FILE ?? join(projectRoot, 'prisma', 'dev.db')
mkdirSync(dirname(databaseFile), { recursive: true })

const adapter = new PrismaBetterSqlite3({ url: `file:${databaseFile}` })

export const prisma = new PrismaClient({
  adapter,
  // 'query' logs every statement Prisma generates, which is the fastest way to
  // see what an `include` actually costs.
  log: process.env.PRISMA_LOG === 'query' ? ['query', 'warn', 'error'] : ['warn', 'error'],
})

export async function close() {
  await prisma.$disconnect()
}

/**
 * Columns a client may sort by. Prisma's `orderBy` takes a key of the generated
 * type, not a string that reaches SQL — so an unknown key is a client error,
 * never an injection. The Set exists to turn that into a clean 400.
 */
export const SORTABLE_USER_COLUMNS = new Set(['id', 'email', 'name', 'createdAt'])
