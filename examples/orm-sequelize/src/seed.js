/**
 * Seed fixtures.
 *
 *   npm run seed      runs this file directly
 *   src/server.js     calls seedIfEmpty() after initSchema()
 *
 * Idempotent — it does nothing once the table has rows.
 */
import { pathToFileURL } from 'node:url'
import { sequelize, User, Post, initSchema, close } from './db.js'

export const FIXTURES = [
  {
    email: 'ada@example.com',
    name: 'Ada Lovelace',
    posts: [
      { title: 'Note G', body: 'The first published algorithm.' },
      { title: 'On the Analytical Engine', body: '' },
    ],
  },
  {
    email: 'grace@example.com',
    name: 'Grace Hopper',
    posts: [{ title: 'Compilers', body: 'A compiler translates, it does not interpret.' }],
  },
]

export async function seedIfEmpty() {
  const existing = await User.count()
  if (existing > 0) return { seeded: false, users: existing }

  await sequelize.transaction(async (transaction) => {
    for (const fixture of FIXTURES) {
      // `include` on create() writes the parent and its children in one call.
      // The alias here ('posts') must match the alias given to hasMany().
      await User.create(fixture, { include: [{ model: Post, as: 'posts' }], transaction })
    }
  })

  return { seeded: true, users: FIXTURES.length }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await initSchema()
  console.log('orm-sequelize seed:', await seedIfEmpty())
  await close()
}
