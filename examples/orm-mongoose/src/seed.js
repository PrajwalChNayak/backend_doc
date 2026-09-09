/**
 * Seed fixtures.
 *
 *   npm run seed      connects, seeds, exits (needs MongoDB)
 *   src/server.js     calls seedIfEmpty() once the connection is up
 *
 * Idempotent — it does nothing once the collection has documents.
 */
import { pathToFileURL } from 'node:url'
import { connect, close, connectionHelp } from './db.js'
import { User, Post } from './models.js'

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
  const existing = await User.countDocuments()
  if (existing > 0) return { seeded: false, users: existing }

  for (const fixture of FIXTURES) {
    const user = await User.create({ email: fixture.email, name: fixture.name })
    await Post.insertMany(fixture.posts.map((p) => ({ ...p, author: user._id })))
  }

  return { seeded: true, users: FIXTURES.length }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await connect()
  } catch (err) {
    console.error(connectionHelp(err))
    process.exit(1)
  }
  console.log('orm-mongoose seed:', await seedIfEmpty())
  await close()
}
