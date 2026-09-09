/**
 * Seed data, importable and runnable.
 *
 *   npm run seed          re-runs it by hand
 *   src/server.js         calls seedIfEmpty() at boot
 *
 * It is idempotent: if the users table already has a row it does nothing, so a
 * restart never duplicates the fixtures and `npm run seed` is safe to repeat.
 */
import { pathToFileURL } from 'node:url'
import { sql } from 'drizzle-orm'
import { db, close } from './db.js'
import { users, posts } from './schema.js'

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

export function seedIfEmpty() {
  const [{ n }] = db.all(sql`SELECT COUNT(*) AS n FROM users`)
  if (n > 0) return { seeded: false, users: n }

  // One transaction for the whole fixture set: a half-seeded database is worse
  // than an empty one, because every later "is it seeded?" check lies.
  return db.transaction((tx) => {
    for (const fixture of FIXTURES) {
      const [user] = tx.insert(users).values({ email: fixture.email, name: fixture.name }).returning().all()
      for (const post of fixture.posts) {
        tx.insert(posts).values({ userId: user.id, title: post.title, body: post.body }).run()
      }
    }
    return { seeded: true, users: FIXTURES.length }
  })
}

// Only run standalone when invoked directly, so importing this file from the
// server does not re-seed as a side effect of the import. `pathToFileURL` is the
// portable form — comparing raw strings breaks on Windows drive letters.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log('orm-drizzle seed:', seedIfEmpty())
  close()
}
