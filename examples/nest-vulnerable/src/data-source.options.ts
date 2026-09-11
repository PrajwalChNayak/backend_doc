// !!! DELIBERATELY VULNERABLE — DO NOT COPY !!!
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { DataSourceOptions } from 'typeorm'
import { Order } from './entities/order.entity.js'
import { Product } from './entities/product.entity.js'
import { User } from './entities/user.entity.js'

const projectRoot = join(__dirname, '..')

export const databaseFile =
  process.env.DATABASE_FILE ?? join(projectRoot, 'data', 'nest-vulnerable.sqlite')

mkdirSync(dirname(databaseFile), { recursive: true })

export const dataSourceOptions: DataSourceOptions = {
  type: 'better-sqlite3',
  database: databaseFile,
  entities: [User, Product, Order],
  synchronize: true,
  logging: process.env.TYPEORM_LOG === 'query' ? ['query', 'error'] : ['error'],
  prepareDatabase: (db: { pragma: (statement: string) => unknown }) => {
    db.pragma('foreign_keys = ON')
  },
}
