// Prisma 7 reads this file for CLI commands (migrate, generate, studio).
// CommonJS, because this package has no "type": "module".
const { defineConfig } = require('prisma/config')

module.exports = defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: process.env.DATABASE_URL ?? 'file:./prisma/dev.db' },
})
