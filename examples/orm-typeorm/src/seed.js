/**
 * Seed fixtures.
 *
 *   npm run seed          runs this file directly
 *   src/server.js         calls seedIfEmpty() after the DataSource initialises
 *
 * Idempotent: it does nothing when the table already has rows.
 */
import { pathToFileURL } from 'node:url'
import { dataSource } from './data-source.js'
import { User } from './entities.js'

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
  const users = dataSource.getRepository(User)
  const existing = await users.count()
  if (existing > 0) return { seeded: false, users: existing }

  // `cascade: ['insert']` on User.posts is what lets a nested `posts` array be
  // saved in the same call. Without it, `save()` would insert the user and
  // silently ignore the posts — a quiet data-loss bug.
  await users.save(FIXTURES.map((f) => ({ email: f.email, name: f.name, posts: f.posts })))
  return { seeded: true, users: FIXTURES.length }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await dataSource.initialize()
  console.log('orm-typeorm seed:', await seedIfEmpty())
  await dataSource.destroy()
}
