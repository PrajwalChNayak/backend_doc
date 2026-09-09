/**
 * Seed data, applied to BOTH stores at boot.
 *
 * The whole point of this example is reading the same rows through two drivers,
 * so an empty `better-sqlite3` half makes the comparison meaningless. Each store
 * owns its own file, so each one has to be seeded separately — there is no
 * shared database to seed once.
 *
 * The seed is idempotent: it looks the user up by its unique email first, so
 * restarting the server against an existing `data/` directory does not throw a
 * UNIQUE constraint error and does not duplicate rows. It goes through the
 * store's own `createUserWithPosts()`, which means the user and its posts land
 * in one transaction — and every value is bound, never interpolated.
 */

export const SEED_USERS = [
  {
    email: 'ada@example.com',
    name: 'Ada',
    posts: [
      { title: 'Notes on the Analytical Engine', body: 'Note G describes the first algorithm.' },
      { title: 'On Bernoulli numbers', body: 'A worked example for the engine.' },
    ],
  },
  {
    email: 'grace@example.com',
    name: 'Grace',
    posts: [{ title: 'Compilers', body: 'A-0 turned symbols into machine code.' }],
  },
]

/**
 * Inserts any missing seed user (with its posts) into one store.
 * Returns a small summary so the caller can log what actually happened.
 */
export function seedStore(store, seed = SEED_USERS) {
  let created = 0
  for (const { email, name, posts } of seed) {
    if (store.getUserByEmail(email)) continue
    store.createUserWithPosts({ email, name, posts })
    created += 1
  }
  return { driver: store.driver, created, users: store.health().users }
}
