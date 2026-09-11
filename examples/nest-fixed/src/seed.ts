// Idempotent fixtures: two users with orders that belong to exactly one of them,
// and a reset token in the users table for the SQL-injection exploit to steal.
import 'reflect-metadata'
import { DataSource } from 'typeorm'
import { dataSourceOptions, databaseFile } from './data-source.options.js'
import { Order } from './entities/order.entity.js'
import { Product } from './entities/product.entity.js'
import { User } from './entities/user.entity.js'

const USERS = [
  { email: 'ada@example.com', name: 'Ada Lovelace', resetToken: 'reset-ada-9f2c41ab' },
  { email: 'grace@example.com', name: 'Grace Hopper', resetToken: 'reset-grace-77d0e5bb' },
]

const PRODUCTS = [
  { name: 'Analytical Engine', priceCents: 999900 },
  { name: 'Punch card reader', priceCents: 24900 },
  { name: 'Mechanical keyboard', priceCents: 12900 },
]

const ORDERS = [
  {
    ownerEmail: 'ada@example.com',
    description: 'Analytical Engine',
    totalCents: 999900,
    shippingAddress: '12 Bletchley Road, London',
    cardLast4: '4242',
  },
  {
    ownerEmail: 'grace@example.com',
    description: 'Punch card reader',
    totalCents: 24900,
    shippingAddress: '400 Navy Yard, Arlington',
    cardLast4: '1881',
  },
]

async function main(): Promise<void> {
  const dataSource = await new DataSource(dataSourceOptions).initialize()
  try {
    const users = dataSource.getRepository(User)
    const products = dataSource.getRepository(Product)
    const orders = dataSource.getRepository(Order)

    for (const fixture of USERS) {
      const existing = await users.findOne({ where: { email: fixture.email } })
      if (!existing) await users.save(users.create(fixture))
    }
    for (const fixture of PRODUCTS) {
      const existing = await products.findOne({ where: { name: fixture.name } })
      if (!existing) await products.save(products.create(fixture))
    }
    for (const fixture of ORDERS) {
      const owner = await users.findOneOrFail({ where: { email: fixture.ownerEmail } })
      const existing = await orders.findOne({
        where: { description: fixture.description, userId: owner.id },
      })
      if (existing) continue
      await orders.save(
        orders.create({
          description: fixture.description,
          totalCents: fixture.totalCents,
          shippingAddress: fixture.shippingAddress,
          cardLast4: fixture.cardLast4,
          userId: owner.id,
        }),
      )
    }

    console.log(
      `seed complete: ${await users.count()} users, ${await products.count()} products, ` +
        `${await orders.count()} orders in ${databaseFile}`,
    )
  } finally {
    await dataSource.destroy()
  }
}

main().catch((err) => {
  console.error('seed failed', err)
  process.exit(1)
})
