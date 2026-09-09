/**
 * Sequelize 6 model definitions.
 *
 * Sequelize is CommonJS, but its named exports are detected by Node's ESM/CJS
 * interop, so `import { Sequelize, DataTypes } from 'sequelize'` works with no
 * build step.
 *
 * Two things worth copying:
 *  - `underscored: true` keeps snake_case columns (`created_at`) while the JS
 *    side stays camelCase. Mixing the two conventions per model is how you end
 *    up with `createdAt` in one table and `created_at` in the next.
 *  - The association is declared in BOTH directions with an explicit `as` alias.
 *    Without an alias, eager loading has to guess the property name and the
 *    include silently changes shape when you add a second association to the
 *    same model.
 */
import { Sequelize, DataTypes } from 'sequelize'

export function createSequelize(storage) {
  return new Sequelize({
    dialect: 'sqlite',
    storage,
    // Sequelize logs every statement at info level by default, which drowns a
    // real log. Set `logging: console.log` while you are debugging a query.
    logging: false,
    // `timestamps` is on by default, so every model gains createdAt/updatedAt.
    // With `underscored` they land as `created_at` / `updated_at` columns while
    // staying camelCase in JavaScript.
    define: { underscored: true, timestamps: true },
    // SQLite is a single file: one connection is the honest pool size. On
    // Postgres or MySQL this is where you would size the real pool.
    pool: { max: 1, idle: 10_000 },
  })
}

export function defineModels(sequelize) {
  const User = sequelize.define(
    'User',
    {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      email: {
        type: DataTypes.STRING(320),
        allowNull: false,
        unique: true,
        // Model-level validation runs before the INSERT. It is a convenience,
        // not a security boundary — the UNIQUE index is what actually holds.
        validate: { isEmail: true },
      },
      name: { type: DataTypes.STRING(120), allowNull: false },
    },
    { tableName: 'users' },
  )

  const Post = sequelize.define(
    'Post',
    {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      title: { type: DataTypes.STRING(200), allowNull: false },
      body: { type: DataTypes.TEXT, allowNull: false, defaultValue: '' },
    },
    { tableName: 'posts' },
  )

  // One user has many posts. `onDelete: 'CASCADE'` is emitted into the DDL that
  // `sync()` generates — but SQLite still ignores foreign keys unless the
  // connection has `PRAGMA foreign_keys = ON`, which db.js sets.
  User.hasMany(Post, { as: 'posts', foreignKey: { name: 'userId', allowNull: false }, onDelete: 'CASCADE' })
  Post.belongsTo(User, { as: 'author', foreignKey: { name: 'userId', allowNull: false } })

  return { User, Post }
}

/**
 * Columns a client may sort by. Sequelize will quote an identifier you pass to
 * `order`, but it will not tell you the column does not exist until the database
 * complains — and an unvalidated value reaches the SQL text either way. Check it
 * against a fixed Set first.
 */
export const SORTABLE_USER_COLUMNS = new Set(['id', 'email', 'name', 'created_at'])
