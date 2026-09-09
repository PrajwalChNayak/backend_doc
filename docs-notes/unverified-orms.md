# Unverified / omitted — `content/orms/`

Author: ORMs section. Verification pass: **2026-09-08**, against the live npm registry
(`registry.npmjs.org`), published package tarballs (`.d.ts` and `lib/` inspected directly),
and official documentation sites.

Everything written in `content/orms/` was verified. This file records what was
**deliberately left out** because it could not be confirmed at the documented version,
plus the traps a future author will hit.

---

## 1. Versions confirmed (npm `dist-tags`, 2026-09-08)

| Package | Documented | npm `latest` | Notes |
| --- | --- | --- | --- |
| `prisma` | 7.10.0 | **`8.0.0-rc.13`** | `latest` is an RC. `prev` tag = `7.10.0`. `next` = `8.0.0-rc.10`. |
| `@prisma/client` | 7.10.0 | 7.10.0 | Stays on 7. Engines `^20.19 \|\| ^22.12 \|\| >=24.0`. |
| `@prisma/adapter-{pg,mariadb,better-sqlite3,mssql,libsql}` | 7.10.0 | 7.10.0 | All five confirmed to exist at 7.10.0. |
| `drizzle-orm` | 0.45.2 | 0.45.2 | `rc` tag = `1.0.0-rc.4`. No `engines` field. Zero runtime deps. |
| `drizzle-kit` | 0.31.10 | 0.31.10 | `rc` tag = `1.0.0-rc.4`. |
| `typeorm` | 1.1.1 | 1.1.1 | Engines `^20.19.0 \|\| ^22.13.0 \|\| >=24.11.0`. `legacy` tag = `0.3.31`. |
| `@typeorm/codemod` | 1.0.3 | 1.0.3 | Exists; the `npx @typeorm/codemod v1 src/` invocation is from the official v1 release notes. |
| `sequelize` | 6.37.8 | 6.37.8 | `alpha` tag = `7.0.0-alpha.9`. Engines `>=10.0.0` (legacy floor). |
| `sequelize-cli` | 6.6.5 | 6.6.5 | |
| `mongoose` | 9.9.5 | 9.9.5 | Engines `>=20.19.0`. Bundles `mongodb@~7.5`. |
| `knex` | 3.3.0 | 3.3.0 | Engines `>=16` (legacy floor). Pools via `tarn@^3.1.0`. |
| `kysely` | 0.29.5 | 0.29.5 | Mention only. |
| `objection` | 3.1.5 | 3.1.5 | Mention only. |
| `testcontainers`, `@testcontainers/postgresql`, `@testcontainers/mongodb` | 12.1.0 | 12.1.0 | Cited in `testing-with-a-database.md`. |
| `migrate-mongo` | 14.0.7 | 14.0.7 | Cited in `mongoose.md`. |
| `pg-mem` | 3.0.14 | 3.0.14 | Cited in `testing-with-a-database.md`. |

---

## 2. Omitted — could not verify at the documented version

- **Prisma `transactionOptions` client-constructor option.** Referenced in general Prisma
  material as a way to set default `maxWait`/`timeout`/`isolationLevel` globally, but the
  **v7-pinned** transactions page does not document it. Left out. Per-call options
  (`maxWait` 2000ms default, `timeout` 5000ms default, `isolationLevel`) **were** confirmed
  on the v7 page and are documented.

- **Prisma 8 changes beyond two confirmed items.** Only these are stated on `prisma.md`,
  both taken from the current (v8-default) docs: `$transaction` becomes a `transaction()`
  callback, and the array form is removed. No other v8 behaviour is claimed.

- **`drizzle-kit` top-level `casing` and `strict` config fields.** The config reference
  lists `dialect`, `schema`, `out`, `dbCredentials`, `driver`, `migrations`, `introspect`,
  `tablesFilter`, `schemaFilter`, `extensionsFilters`, `entities`, `verbose`, `breakpoints`.
  `casing` appears only nested under `introspect`. `strict` was not confirmed at top level.
  Only confirmed fields are used in the example.

- **Drizzle transaction isolation-level / access-mode options.** `db.transaction(fn)` is
  documented; the second-argument config shape was not verified at 0.45.2. Omitted.

- **Sequelize `pool.maxUses` semantics and default.** The option exists in the 6.37.8
  typings (`types/sequelize.d.ts`) alongside `min`, `max`, `idle`, `acquire`, `evict`, but
  its default was not confirmed. Removed from the example rather than guess. `evict` is
  shown with an explicit value, not presented as a default.

- **Sequelize `pool` defaults.** The v6 docs example shows `{ max: 5, min: 0, acquire: 30000,
  idle: 10000 }` but does not label those as defaults. `sequelize.md` presents them as an
  example configuration and only asserts the 30s `acquire` behaviour, which the docs state.

- **Sequelize 7 API surface.** Deliberately not documented — still alpha
  (`7.0.0-alpha.9`). Only its alpha status is stated.

- **Kysely and Objection API details.** Mention-only per the brief. No code shown.

---

## 3. Traps for future authors (verified, worth recording)

- **Prisma's public docs default to v8 (the RC).** The v7 pages live under a `/v7/` path
  segment, e.g. `.../docs/orm/v7/prisma-client/queries/transactions`. Anything fetched from
  the unversioned path describes v8 and may not apply to 7.10.0.

- **The Drizzle documentation site largely describes the 1.0 RC.** Most visibly, the
  relational-queries page shows `defineRelations()` — that API **does not exist** in
  `drizzle-orm@0.45.2`. Verified by unpacking the 0.45.2 tarball: `relations.d.ts` exports
  `relations(table, (helpers) => …)` with `{ fields, references }`, and there is no
  `defineRelations`. `drizzle.md` documents the 0.45.2 API and carries a callout about this.

- **TypeORM peer-dependency conflict with `better-sqlite3`.** `typeorm@1.1.1` declares
  `"better-sqlite3": "^12.0.0"`, but `CONTRIBUTING.md` §1.3 pins `better-sqlite3` at
  **13.0.3**. npm will report a peer conflict. Flagged in a `:::note` on `typeorm.md`.
  **Coordinator action:** decide whether `examples/orm-typeorm` pins `better-sqlite3@12`
  or uses PostgreSQL/`pg` instead.

- **TypeORM 1.1.1 requires Node `>=24.11.0` on the 24 line** (`^20.19.0 || ^22.13.0 ||
  >=24.11.0`). A Docker image on 24.10 does not satisfy the range. `CONTRIBUTING.md` §1.1
  lists Node 24.20.0 as current Active LTS, so this is satisfied — but any image pin below
  24.11 will fail.

- **`prisma` and `@prisma/client` `latest` tags disagree** (`8.0.0-rc.13` vs `7.10.0`). An
  unpinned `npm install` in a fresh container produces a mismatched major pair.
  `examples/orm-prisma` must pin `prisma@7` and `@prisma/client@7` exactly.

- **Prisma 7 has no MongoDB support.** Anything cross-linking Prisma from
  `content/databases/mongodb.md` should not imply otherwise.

- **Prisma 7 removed the `url` field from the schema `datasource` block** — it lives in
  `prisma.config.ts` now. Verified against the v7 data-sources page.

---

## 4. Cross-section dependencies

`content/orms/` links to pages owned by other authors. All resolve against `scripts/nav.mjs`;
none existed on disk at authoring time.

- `../security/sql-injection.md`, `../security/nosql-injection.md`,
  `../security/mass-assignment.md`, `../security/secrets-management.md`
- `../databases/`: `connection-pooling.md`, `transactions.md`, `migrations.md`,
  `n-plus-one-queries.md`, `indexing-basics.md`, `seeding.md`, `choosing-a-database.md`,
  `postgresql-with-pg.md`, `mongodb.md`, `sqlite.md`, `retries-and-timeouts.md`
- `../express-libraries/testing.md`, `../express-libraries/validation.md`
- `../production/ci.md`, `../production/deployment-checklist.md`
- `../../examples/orm-{prisma,drizzle,typeorm,sequelize,mongoose,knex}/README.md`
  — **not yet created**; one link from each ORM page.

---

## 5. SQL-linter exemptions used

Per `CONTRIBUTING.md` §7, `// lint-sql:allow` was used only for allow-listed identifier
interpolation. Four instances:

| File | What | Justification |
| --- | --- | --- |
| `when-to-use-an-orm.md` | `ORDER BY ${column} ${direction}` | Both from `Map`s of literals; `LIMIT` stays `$1` |
| `sequelize.md` | `ORDER BY ${column} ${direction}` | Same shape; `LIMIT` stays a `bind` parameter |
| `prisma.md` | `Prisma.raw(\`${column} ${direction}\`)` | Same shape; `LIMIT` stays a tagged-template bind |
| `drizzle.md` | `sql.identifier(column)` | Checked against an allow-list `Set`, then quoted |
| `testing-with-a-database.md` | `TRUNCATE ${tables…}` and `SET search_path TO ${schema}` | Table names from `pg_tables`; schema from a worker index |

**Assumption the linter must satisfy:** *tagged* templates (`` prisma.$queryRaw`…` ``,
`` sql`…` ``, `` Prisma.sql`…` ``) are treated as parameterized and are **not** flagged.
`CONTRIBUTING.md` §7 requires documenting these as the safe form, so flagging them would
make the mandated content unwritable. Untagged template literals and `+` concatenation are
flagged as expected. If `scripts/lint-sql.mjs` does flag tagged templates, the affected
lines are listed above and in the `good`-marked fences on `prisma.md` and `drizzle.md`.
