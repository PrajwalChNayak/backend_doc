# Unverified / deliberately omitted — Reference section

Author: Reference section pass, 2026-09-08.
Pages: `content/reference/express-4-to-5-migration.md`, `cheat-sheet.md`, `library-index.md`, `troubleshooting.md`.

Everything actually written on those four pages was verified against CONTRIBUTING.md §1.1–§1.3, the
official [Express 5 migration guide](https://expressjs.com/en/guide/migrating-5.html) (fetched
2026-09-08), or the npm registry. This file records what was **left out** and why, plus the few
judgement calls a reviewer should sanity-check.

## Omitted because it could not be verified

- **`express-rate-limit` `standardHeaders` draft values.** The `'draft-6'` / `'draft-7'` / `'draft-8'`
  string values are widely used, but I could not confirm from official docs which of them
  `express-rate-limit@8.7.0` accepts. The cheat sheet uses `standardHeaders: true`, which is
  unambiguous. If the rate-limiting page author verifies the draft values, the cheat sheet can be
  upgraded to name one.
- **A canonical documentation URL for several packages.** Where I could not confirm an official docs
  site, the `library-index.md` "Docs" column links to the npm package page
  (`https://www.npmjs.com/package/<name>`), which is guaranteed to exist and is authoritative for the
  version. Packages with a confirmed site (express, helmet, zod, pino, prisma, drizzle, typeorm,
  sequelize, mongoose, knex, kysely, objection, sharp, undici, pm2, bullmq, eslint, vitest,
  typescript, node-postgres, MongoDB driver) link there instead.
- **`oslo` replacement URL.** CONTRIBUTING §1.3 says it is superseded by "oslojs.dev". That is
  recorded as prose in the deprecated list, not as a hyperlink, because I did not verify the site.
- **Exact `mysql2` / `better-sqlite3` pool-exhaustion error strings.** Only the `pg` message
  (`timeout exceeded when trying to connect`) is quoted in `troubleshooting.md`, because that is the
  one I could confirm. The other drivers' wording is described, not quoted.

## Judgement calls worth a reviewer's eye

- **The "Deprecated — do not use" section in `library-index.md` is a `:::deprecated` callout with a
  bulleted list, not a GFM table.** The brief asked for a table. It cannot be one: the row for
  `express-async-handler` contains a string that `scripts/check.mjs` fails the build on unless it sits
  inside a `:::legacy` / `:::deprecated` callout, and CONTRIBUTING §5 states callouts may contain only
  paragraphs, lists and code fences — not tables. The list carries the same columns (package, reason,
  replacement, link) as prose.
- **Browser CORS message text in `troubleshooting.md` is Chrome's wording.** Firefox and Safari phrase
  the same failures differently. The messages are labelled as browser-console output, and the causes
  and fixes are browser-independent.
- **The "you are done when" grep in the migration page uses `grep -rnE`.** It is written for a POSIX
  shell; Windows readers need `Select-String` or Git Bash. Not called out on the page.
- **`process.on('unhandledRejection', (reason) => { throw reason })`** appears in the cheat sheet and
  troubleshooting page as the fail-loudly pattern. It is deliberate (crash and let the supervisor
  restart), not an oversight, but it is a policy choice the Production section may want to align with.

## Confirmed by absence (not a gap)

The official guide lists exactly eleven codemod packages — one recipe plus ten individual codemods —
and all eleven are named in `express-4-to-5-migration.md`. There is **no** codemod for the four
changes that actually break production: route path syntax, deleting async wrappers, the
`express.static()` `dotfiles` default, and `req.body` becoming `undefined`. The page says so
explicitly rather than leaving readers to assume the recipe finished the job.
