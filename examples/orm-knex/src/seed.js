/**
 * Seeding, two ways.
 *
 *   npm run seed      runs this file, which calls knex.seed.run() — the same
 *                     thing `knex seed:run` does, without depending on the CLI
 *                     shim resolving an ESM knexfile. It WIPES and re-inserts.
 *   src/server.js     calls seedIfEmpty(), which only fills an empty database so
 *                     a restart never duplicates rows.
 */
import { pathToFileURL } from 'node:url'
import { knex, close } from './db.js'
import { FIXTURES } from '../seeds/01_users_and_posts.js'

export async function seedIfEmpty() {
  const row = await knex('users').count({ n: '*' }).first()
  const existing = Number(row.n)
  if (existing > 0) return { seeded: false, users: existing }

  await knex.transaction(async (trx) => {
    for (const fixture of FIXTURES) {
      const [user] = await trx('users')
        .insert({ email: fixture.email, name: fixture.name })
        .returning(['id'])
      for (const post of fixture.posts) {
        await trx('posts').insert({ user_id: user.id, title: post.title, body: post.body })
      }
    }
  })

  return { seeded: true, users: FIXTURES.length }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [files] = await knex.seed.run()
  console.log(`orm-knex seed: ran ${files.length} seed file(s): ${files.join(', ')}`)
  await close()
}
