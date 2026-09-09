/**
 * The Drizzle schema, in plain JavaScript.
 *
 * Drizzle is usually shown in TypeScript because the table objects are what give
 * you typed rows. None of that is required at runtime: `sqliteTable()` is an
 * ordinary function call, so the same file works as `.js` with no build step and
 * no type-stripping. You lose the editor types, not the behaviour.
 *
 * Two halves that people mix up:
 *  - the table objects (`users`, `posts`) drive `db.select()` / `db.insert()`
 *  - the `relations()` objects drive the *relational query* API
 *    (`db.query.users.findMany({ with: { posts: true } })`).
 * Passing only the tables into `drizzle()` leaves `db.query` empty, which is the
 * single most common "why is db.query.users undefined" question.
 */
import { relations, sql } from 'drizzle-orm'
import { sqliteTable, integer, text, index } from 'drizzle-orm/sqlite-core'

export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  // `sql` here is a *default expression*, evaluated by SQLite, not by Node.
  createdAt: text('created_at')
    .notNull()
    .default(sql`(datetime('now'))`),
})

export const posts = sqliteTable(
  'posts',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id')
      .notNull()
      // onDelete only reaches the DDL. SQLite still ignores foreign keys unless
      // the connection sets `PRAGMA foreign_keys = ON` — see src/db.js.
      .references(() => users.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    body: text('body').notNull().default(''),
    createdAt: text('created_at')
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => [index('posts_user_id_idx').on(table.userId)],
)

export const usersRelations = relations(users, ({ many }) => ({
  posts: many(posts),
}))

export const postsRelations = relations(posts, ({ one }) => ({
  author: one(users, { fields: [posts.userId], references: [users.id] }),
}))

/** Everything `drizzle()` needs for both the query builder and `db.query`. */
export const schema = { users, posts, usersRelations, postsRelations }

/**
 * Columns a client may sort by. Drizzle's `orderBy` takes a column *object*, not
 * a string, so the lookup below is what turns a client string into one — and an
 * unknown key simply has no entry, which is the allow-list.
 */
export const SORTABLE_USER_COLUMNS = {
  id: users.id,
  email: users.email,
  name: users.name,
  created_at: users.createdAt,
}
