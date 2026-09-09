/**
 * Entities defined with `EntitySchema` — TypeORM's decorator-free API.
 *
 * The decorator form (`@Entity()`, `@Column()`) needs `experimentalDecorators`
 * and `emitDecoratorMetadata`, which means a TypeScript compile step: Node 24's
 * built-in type stripping removes types but refuses decorators, because they
 * *emit* code rather than just annotate it. `EntitySchema` is plain objects, so
 * this example is ESM JavaScript that runs with `node src/server.js` and nothing
 * else. The runtime behaviour is identical — the decorators build one of these.
 */
import { EntitySchema } from 'typeorm'

export const User = new EntitySchema({
  name: 'User',
  tableName: 'users',
  columns: {
    id: { type: Number, primary: true, generated: 'increment' },
    email: { type: String, length: 320, unique: true },
    name: { type: String, length: 120 },
    createdAt: { name: 'created_at', type: 'datetime', createDate: true },
  },
  relations: {
    posts: {
      type: 'one-to-many',
      target: 'Post',
      // `inverseSide` names the property on Post that owns the foreign key.
      // Without it TypeORM cannot join the two halves and eager loading fails
      // at query time rather than at startup.
      inverseSide: 'author',
      cascade: ['insert'],
    },
  },
})

export const Post = new EntitySchema({
  name: 'Post',
  tableName: 'posts',
  columns: {
    id: { type: Number, primary: true, generated: 'increment' },
    title: { type: String, length: 200 },
    body: { type: String, default: '' },
    createdAt: { name: 'created_at', type: 'datetime', createDate: true },
  },
  relations: {
    author: {
      type: 'many-to-one',
      target: 'User',
      // The many-to-one side owns the FK column, so this is where the column
      // name, nullability and ON DELETE live.
      joinColumn: { name: 'user_id' },
      nullable: false,
      onDelete: 'CASCADE',
    },
  },
  indices: [{ name: 'posts_user_id_idx', columns: ['author'] }],
})

/**
 * Columns a client may sort by. The query builder's `orderBy()` takes a string
 * that goes into the statement as an identifier — TypeORM does not validate it
 * — so it is checked against this Set before it is used.
 */
export const SORTABLE_USER_COLUMNS = new Set(['id', 'email', 'name', 'created_at'])

/** Maps the allow-listed column onto the alias the query builder uses. */
export const USER_SORT_ALIAS = {
  id: 'user.id',
  email: 'user.email',
  name: 'user.name',
  created_at: 'user.createdAt',
}
