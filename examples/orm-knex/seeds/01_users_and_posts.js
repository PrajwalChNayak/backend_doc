/**
 * `knex seed:run` executes every file in this directory in filename order, which
 * is why the file is numbered. Seeds are not migrations: they are re-runnable
 * fixtures, so this one clears the tables first rather than trying to be clever
 * about duplicates.
 */
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

export async function seed(knex) {
  // One transaction: a seed that fails halfway leaves fixtures that no test can
  // rely on, which is worse than no fixtures at all.
  await knex.transaction(async (trx) => {
    // Children first: posts.user_id references users.id.
    await trx('posts').del()
    await trx('users').del()

    // Deleting rows does NOT reset an AUTOINCREMENT counter — SQLite keeps the
    // high-water mark in `sqlite_sequence`, so a re-seeded database would hand
    // out ids starting at 4 and every fixture-based test that hardcodes id 1
    // would break on the second run. Clearing it makes the seed reproducible.
    await trx('sqlite_sequence').whereIn('name', ['users', 'posts']).del()

    for (const fixture of FIXTURES) {
      const [user] = await trx('users')
        .insert({ email: fixture.email, name: fixture.name })
        .returning(['id'])
      for (const post of fixture.posts) {
        await trx('posts').insert({ user_id: user.id, title: post.title, body: post.body })
      }
    }
  })
}
