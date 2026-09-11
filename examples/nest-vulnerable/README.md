# nest-vulnerable — a deliberately broken NestJS app

> # DANGER
>
> **Every file in this project contains an exploitable vulnerability on
> purpose.** It exists so `examples/nest-fixed` has something to fix and so the
> exploits in `exploit.md` have somewhere to run. Do not copy any code from it.
> Do not deploy it. Do not expose port 3038 to any network you do not fully
> control. It ships **no** input validation, **no** parameterised queries on the
> vulnerable paths, and **no** real authentication.

Two classic bugs, both from the OWASP Top 10:

1. **SQL injection** — `GET /products/search?q=` builds SQL by string
   concatenation in a TypeORM raw query.
2. **IDOR** (broken object-level authorization) — `GET /orders/:id` looks an
   order up by id alone and never checks who owns it.

The working attacks, with real output, are in **[`exploit.md`](./exploit.md)**.
The corrected app, with tests that replay each attack, is in
**`examples/nest-fixed`**.

## Why the directory layout looks the way it does

The assignment required the top-level directory to be named `nest-vulnerable`
(not `vulnerable-nest`). But `scripts/lint-sql.mjs` — which fails the build on
any SQL built by concatenation — grants its directory exemption to path
**segments** that start with `vulnerable-`, checked segment by segment
(CONTRIBUTING.md §7):

```js
const inVulnerableDir = rel.split('/').some((seg) => seg.startsWith('vulnerable-'))
```

So the injectable repository lives in `src/vulnerable-queries/`. That inner
segment earns the exemption cleanly, the top-level name stays `nest-vulnerable`,
and the linter reports:

```
· examples/nest-vulnerable/src/vulnerable-queries/products.repository.ts
    — directory is a `vulnerable-*` teaching example (3 findings)
...
No unmarked SQL string-building found.
```

Move that one file up into `src/` and the lint fails the build — which is the
whole point of the check.

## Prerequisites

Node **20.19+ / 22.12+ / 24 LTS**. SQLite, so no server. The override that keeps
`better-sqlite3` on a prebuilt v13 is the same as `nest-typeorm`'s.

## Run it (locally, once, to attack it)

```bash
cd examples/nest-vulnerable
npm install
npm run setup     # = npm run build
npm run seed
npm start
```

```
  !!! nest-vulnerable is DELIBERATELY INSECURE !!!
  SQL injection on GET /products/search, IDOR on GET /orders/:id.
  Never expose this port to a network you do not control.

  listening on http://localhost:3038 (db: ...\data\nest-vulnerable.sqlite)
```

## The two bugs, briefly

### SQL injection

`src/vulnerable-queries/products.repository.ts`:

```ts
// !!! DELIBERATELY VULNERABLE — DO NOT COPY !!!
const sql = `SELECT id, name, price_cents FROM products WHERE name LIKE '%${term}%' ORDER BY id`
return this.dataSource.query(sql)
```

`term` is the caller's `q`. `xxx' UNION SELECT id, email || ':' || resetToken, 0
FROM users --` turns a product search into a dump of every user's password-reset
token. Full walkthrough in `exploit.md` §1.

### IDOR

`src/orders.controller.ts`:

```ts
// !!! DELIBERATELY VULNERABLE — DO NOT COPY !!!
const order = await this.orders.findOne({ where: { id: Number(id) } })
```

The lookup is by `id` only. The caller's identity is read from `x-user-id`,
copied into the response, and then ignored, so any user can read any order by
counting `:id` upward. Full walkthrough in `exploit.md` §2.

The `GET /orders` **list** route on the same controller *is* scoped by owner —
the inconsistency is the lesson. A per-record read that forgets the ownership
check the list route remembered is exactly how IDOR ships.

## Where the fixes are

`examples/nest-fixed` is this app corrected:

- the search query binds its value (`… LIKE ?`, `['%' + term + '%']`);
- the sort column is checked against an allow-list before it is interpolated;
- `GET /orders/:id` scopes the `WHERE` clause by owner and returns **404** — not
  403 — when it does not match, so the route is not an existence oracle;
- `node:test` + supertest tests replay every payload from `exploit.md` and
  assert it now fails.

## Related examples

- `examples/nest-fixed` — the corrected version and its exploit-replay tests.
- `examples/vulnerable-sql-injection` — the Express 5 sibling of this app.
- `nest-typeorm` — how the same queries look when they are written correctly.
