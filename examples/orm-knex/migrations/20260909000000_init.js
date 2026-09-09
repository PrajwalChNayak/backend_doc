/**
 * Knex migrations are ordinary modules exporting `up` and `down`. The schema
 * builder emits the DDL for whichever client is configured, which is the point:
 * the same file runs against SQLite here and Postgres in production.
 *
 * Both directions are written. A migration with no `down` is a migration you
 * cannot roll back, and you find that out during the incident, not before it.
 */
export async function up(knex) {
  await knex.schema.createTable('users', (table) => {
    table.increments('id').primary()
    table.string('email', 320).notNullable().unique()
    table.string('name', 120).notNullable()
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now())
  })

  await knex.schema.createTable('posts', (table) => {
    table.increments('id').primary()
    table
      .integer('user_id')
      .notNullable()
      .references('id')
      .inTable('users')
      .onDelete('CASCADE')
      .index('posts_user_id_idx')
    table.string('title', 200).notNullable()
    table.text('body').notNullable().defaultTo('')
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now())
  })
}

export async function down(knex) {
  // Reverse order: posts references users, so users cannot go first.
  await knex.schema.dropTableIfExists('posts')
  await knex.schema.dropTableIfExists('users')
}
