/**
 * Idempotent seed. Run with `npm run seed` — it opens its own DataSource from
 * the same options the app uses, writes if the table is empty, and closes.
 */
import 'reflect-metadata'
import { DataSource } from 'typeorm'
import { dataSourceOptions, databaseFile } from './data-source.options.js'
import { User } from './users/user.entity.js'
import { Post } from './posts/post.entity.js'

const FIXTURES = [
  {
    email: 'ada@example.com',
    name: 'Ada Lovelace',
    posts: [
      { title: 'Notes on the Analytical Engine', body: 'Note G.' },
      { title: 'On bind parameters', body: 'Never concatenate.' },
    ],
  },
  {
    email: 'grace@example.com',
    name: 'Grace Hopper',
    posts: [{ title: 'A compiler is possible', body: '' }],
  },
  { email: 'alan@example.com', name: 'Alan Turing', posts: [] },
]

async function main(): Promise<void> {
  const dataSource = await new DataSource(dataSourceOptions).initialize()
  try {
    for (const fixture of FIXTURES) {
      const existing = await dataSource.getRepository(User).findOne({
        where: { email: fixture.email },
      })
      if (existing) continue
      await dataSource.transaction(async (manager) => {
        const user = await manager.save(
          manager.create(User, { email: fixture.email, name: fixture.name }),
        )
        if (fixture.posts.length) {
          await manager.save(
            fixture.posts.map((p) => manager.create(Post, { ...p, userId: user.id })),
          )
        }
      })
    }
    const users = await dataSource.getRepository(User).count()
    const posts = await dataSource.getRepository(Post).count()
    console.log(`seed complete: ${users} users, ${posts} posts in ${databaseFile}`)
  } finally {
    await dataSource.destroy()
  }
}

main().catch((err) => {
  console.error('seed failed', err)
  process.exit(1)
})
