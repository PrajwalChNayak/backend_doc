# nest-fixed — nest-vulnerable, corrected

The same app as `examples/nest-vulnerable`, with the two bugs fixed and a test
suite that replays every payload from that example's `exploit.md` and asserts it
now does nothing.

Read the two side by side. The diffs are small — that is the lesson. Neither the
SQL injection nor the IDOR needed an architecture change; each needed one line
written correctly.

## What changed

| Bug in `nest-vulnerable` | Fix here | File |
| --- | --- | --- |
| Search built SQL by interpolation | bind the value: `LIKE ?`, `['%' + term + '%']` | `src/queries/products.repository.ts` |
| Sort column pasted into `ORDER BY` | allow-list `Set`, then interpolate the vetted value + `// lint-sql:allow` | `src/queries/products.repository.ts` |
| `GET /orders/:id` looked up by id alone | scope the `WHERE` by `userId`, return **404** on a miss | `src/orders.controller.ts` |
| Endpoint echoed the raw SQL statement | removed | `src/catalog.controller.ts` |

The `vulnerable-queries/` directory is renamed to plain `queries/` — the fixed
code is parameterised, so it neither needs nor claims the SQL-linter exemption.

## Prerequisites

Node **20.19+ / 22.12+ / 24 LTS**. SQLite, no server.

## Install, build, seed, run, test

```bash
cd examples/nest-fixed
npm install
npm run setup     # = npm run build
npm run seed
npm start         # http://localhost:3039
npm test          # replays every exploit and asserts it fails
```

## The fixes, in full

### SQL injection → bind parameters

```ts
// examples/nest-vulnerable (broken)
const sql = `SELECT id, name, price_cents FROM products WHERE name LIKE '%${term}%' ORDER BY id`
return this.dataSource.query(sql)

// here (fixed)
return this.dataSource.query(
  'SELECT id, name, price_cents FROM products WHERE name LIKE ? ORDER BY id',
  [`%${term}%`],
)
```

The `%` wildcards go on the **value**, not into the SQL. `' OR '1'='1` is now a
product name that does not exist:

```bash
curl -s "http://localhost:3039/products/search?q=%25%27%20OR%20%271%27%3D%271"
```

```json
{"rows":[]}
```

And the UNION payload that dumped every reset token returns nothing:

```bash
curl -s "http://localhost:3039/products/search?q=xxx%27%20UNION%20SELECT%20id%2C%20email%20%7C%7C%20%27%3A%27%20%7C%7C%20resetToken%2C%200%20FROM%20users%20--"
```

```json
{"rows":[]}
```

### The one thing you cannot bind: an identifier → allow-list

You cannot bind a column name, so `?sort=` needs a different fix — validate it,
then interpolate only the vetted constant:

```ts
const SORTABLE = new Set(['id', 'name', 'price_cents'])
if (!SORTABLE.has(sortColumn)) throw new BadRequestException(`Cannot sort by ${sortColumn}`)
// lint-sql:allow sortColumn is checked against the SORTABLE allow-list above
return this.dataSource.query(`SELECT id, name, price_cents FROM products ORDER BY ${sortColumn}`)
```

The `// lint-sql:allow` marker is the mechanism `scripts/lint-sql.mjs` provides
(CONTRIBUTING.md §7) for exactly this — an interpolated identifier you have
proven safe against an allow-list. It is the *only* interpolation into SQL in
this example, and it is justified on the line above it.

```bash
curl -s "http://localhost:3039/products?sort=id;DROP+TABLE+users"
```

```json
{"message":"Cannot sort by id;DROP TABLE users","error":"Bad Request","statusCode":400}
```

### IDOR → owner-scoped lookup returning 404

```ts
// examples/nest-vulnerable (broken)
const order = await this.orders.findOne({ where: { id: Number(id) } })

// here (fixed)
const order = await this.orders.findOne({ where: { id, userId } })
if (!order) throw new NotFoundException(`No order with id ${id}`)
```

Ada (user 1) can no longer read Grace's order (id 2):

```bash
curl -s -i "http://localhost:3039/orders/2" -H "x-user-id: 1" | head -1
curl -s "http://localhost:3039/orders/2" -H "x-user-id: 1"
```

```
HTTP/1.1 404 Not Found
{"message":"No order with id 2","error":"Not Found","statusCode":404}
```

She still reads her own:

```bash
curl -s "http://localhost:3039/orders/1" -H "x-user-id: 1"
```

```json
{"requestedBy":1,"order":{"id":1,"description":"Analytical Engine","totalCents":999900,"shippingAddress":"12 Bletchley Road, London","cardLast4":"4242","userId":1,"createdAt":"2026-09-11T19:07:47.000Z"}}
```

**Why 404 and not 403.** A 403 tells the attacker the order exists — it just is
not theirs — which is a free enumeration oracle over every id. Because `userId`
is in the `WHERE` clause, "no such order" and "someone else's order" run the same
query and produce the same 404. There is no code path that could distinguish
them, so there is nothing to leak.

## Tests

```
✔ GET /health is ok
✔ a normal search still works
✔ exploit 1a: "%' OR '1'='1" no longer returns everything
✔ exploit 1b: UNION SELECT can no longer read the users table
✔ exploit 1c: an injected ORDER BY column is a 400
✔ exploit 2: IDOR — user 1 gets 404 for user 2's order
✔ a user can still read their OWN order
✔ the list route returns only the caller's orders
✔ a non-numeric order id is a 400, before any lookup
ℹ tests 9
ℹ pass 9
ℹ fail 0
```

Each `exploit` test uses the exact payload from
`examples/nest-vulnerable/exploit.md`, so the two examples cannot drift: if a
regression reopened a hole, the matching test here would fail.

## Related examples

- `examples/nest-vulnerable` — the broken version and the exploit walkthrough.
- `nest-typeorm` — the same parameterised-query and owner-scoping patterns in a
  fuller app.
- `nest-jwt-auth` — real authentication behind the `x-user-id` shortcut used here.
