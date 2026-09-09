/**
 * Seed fixtures.
 *
 *   npm run seed      runs this file directly
 *   src/server.js     calls seedIfEmpty() at boot
 *
 * Idempotent — it does nothing once the table has rows.
 */
import { pathToFileURL } from 'node:url'
import { prisma, close } from './db.js'

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
  const existing = await prisma.user.count()
  if (existing > 0) return { seeded: false, users: existing }

  for (const fixture of FIXTURES) {
    // A nested `create` writes the user and its posts inside one implicit
    // transaction — Prisma wraps nested writes for you.
    await prisma.user.create({
      data: {
        email: fixture.email,
        name: fixture.name,
        posts: { create: fixture.posts },
      },
    })
  }

  return { seeded: true, users: FIXTURES.length }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log('orm-prisma seed:', await seedIfEmpty())
  await close()
}
