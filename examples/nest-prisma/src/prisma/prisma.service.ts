/**
 * The PrismaService pattern: one client for the process, owned by Nest.
 *
 * `OnModuleInit` connects at startup so the first request does not pay for the
 * handshake, and `OnModuleDestroy` disconnects on shutdown so the process can
 * actually exit. Creating a PrismaClient per request is the classic mistake —
 * each one opens its own pool, and on a serverless platform it is how you
 * exhaust the database's connection limit.
 *
 * Prisma 7 changed how the client reaches a database: instead of reading a URL
 * out of `schema.prisma`, you hand the constructor a **driver adapter**. The URL
 * now lives in exactly two places — `prisma.config.js` for the CLI and here for
 * the runtime — and the client ships no Rust query engine binary.
 */
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { PrismaClient } from '../generated/prisma/client.js'

const projectRoot = join(__dirname, '..', '..')

export const databaseFile =
  process.env.DATABASE_FILE ?? join(projectRoot, 'prisma', 'dev.db')

mkdirSync(dirname(databaseFile), { recursive: true })

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name)

  constructor() {
    super({
      adapter: new PrismaBetterSqlite3({ url: `file:${databaseFile}` }),
      log: process.env.PRISMA_LOG === 'query' ? ['query', 'warn', 'error'] : ['warn', 'error'],
    })
  }

  async onModuleInit(): Promise<void> {
    await this.$connect()
    this.logger.log(`connected to ${databaseFile}`)
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect()
  }
}
