/**
 * One Sequelize instance for the process, plus the models it owns.
 *
 * `new Sequelize(...)` creates a connection pool; models are bound to the
 * instance that defined them. Two instances over one SQLite file means two
 * writers and a stream of SQLITE_BUSY, so this module is the only place either
 * is created.
 */
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createSequelize, defineModels } from './models.js'

const here = dirname(fileURLToPath(import.meta.url))
const dataDir = process.env.DATA_DIR ?? join(here, '..', 'data')
mkdirSync(dataDir, { recursive: true })

export const databaseFile = process.env.DATABASE_FILE ?? join(dataDir, 'app.db')

export const sequelize = createSequelize(databaseFile)
export const { User, Post } = defineModels(sequelize)

/**
 * `sync()` creates any missing table from the model definitions. Like TypeORM's
 * `synchronize`, it is a development convenience — it will not write the
 * migration you need to review, and `sync({ alter: true })` can drop a column
 * it does not recognise. Real deployments use `sequelize-cli` migrations.
 */
export async function initSchema() {
  // SQLite ignores foreign keys unless the connection asks for them, and
  // Sequelize does not set the pragma for you.
  await sequelize.query('PRAGMA foreign_keys = ON')
  await sequelize.query('PRAGMA journal_mode = WAL')
  await sequelize.query('PRAGMA busy_timeout = 5000')
  await sequelize.sync()
}

export async function close() {
  await sequelize.close()
}
