/**
 * Idempotent seed. It builds its own client — the same adapter the Nest service
 * uses — because a seed script has no Nest application around it.
 */
import 'reflect-metadata'
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3'
import { join } from 'node:path'
import { PrismaClient } from './generated/prisma/client.js'

const projectRoot = join(__dirname, '..')
const databaseFile = process.env.DATABASE_FILE ?? join(projectRoot, 'prisma', 'dev.db')

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
  const prisma = new PrismaClient({
    adapter: new PrismaBetterSqlite3({ url: `file:${databaseFile}` }),
  })
  try {
    for (const fixture of FIXTURES) {
      const existing = await prisma.user.findUnique({ where: { email: fixture.email } })
      if (existing) continue
      // A nested write. Prisma wraps it in one implicit transaction.
      await prisma.user.create({
        data: {
          email: fixture.email,
          name: fixture.name,
          posts: { create: fixture.posts },
        },
      })
    }
    const users = await prisma.user.count()
    const posts = await prisma.post.count()
    console.log(`seed complete: ${users} users, ${posts} posts in ${databaseFile}`)
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((err) => {
  console.error('seed failed', err)
  process.exit(1)
})
