# fixed-sql-injection

The [`vulnerable-sql-injection`](../vulnerable-sql-injection/README.md) app, put
right. Same routes, same seed data, same schema — the only change is how the
queries are built. Every exploit from that example's `exploit.md` is run against
this app by the test suite and asserted to fail.

## What it demonstrates

- **Parameterised statements** for every client-controlled value — the fix for
  the auth bypass and the UNION / boolean-blind exfiltration.
- **The case parameters do not cover:** a `?sort=` column in `ORDER BY`.
  Placeholders bind *values*, not *identifiers*, so a column name has to be
  validated against an allow-list and only then interpolated — with the
  `// lint-sql:allow` marker the repository's linter requires.
- **Not leaking DB errors** — generic message to the client, detail to the log.

## Prerequisites

- Node.js 24 LTS.

## Install and run

```bash
cd examples/fixed-sql-injection
npm install
npm start          # http://localhost:3005
npm test           # runs every exploit payload and asserts it now fails
```

`PORT` overrides the port (default `3005`). The database is in-memory.

## Before / after

### 1. Login — `POST /login`

The value is the same; only the query construction differs.

```js
// vulnerable — the payload becomes part of the SQL
const sql = `SELECT ... WHERE username = '${username}' AND password = '${password}'`
db.prepare(sql).get()
```

```js
// fixed — the payload is bound as data and compared as a string
db.prepare('SELECT id, username, email, role FROM users WHERE username = ? AND password = ?')
  .get(String(username), String(password))
```

```bash
# the auth-bypass payload that returned alice in the vulnerable app:
curl -s -X POST http://localhost:3005/login \
  -H 'content-type: application/json' \
  -d '{"username":"x'\'' OR '\''1'\''='\''1","password":"x'\'' OR '\''1'\''='\''1"}'
```

```json
{"ok":false,"error":"invalid credentials"}
```

`' OR '1'='1` is now compared, literally, against the `username` column. No user
is called that, so it matches nothing — `401`.

### 2. Search — `GET /users/search?q=`

```js
// vulnerable
const sql = `SELECT username, email FROM users WHERE username LIKE '%${q}%'`
```

```js
// fixed — q binds as a value; the LIKE wildcards live in the parameter, and the
// user's own %/_ are escaped so they match literally
const likeValue = `%${escapeLike(q)}%`
db.prepare("SELECT username, email FROM users WHERE username LIKE ? ESCAPE '\\' ...").all(likeValue)
```

```bash
# the UNION payload that dumped every secret_token:
curl -s 'http://localhost:3005/users/search?q=zzz%27%20UNION%20SELECT%20username%2C%20secret_token%20FROM%20users--'
```

```json
{"ok":true,"count":0,"rows":[],"sortedBy":"username ASC"}
```

The entire payload is treated as one literal search string. It matches no
username, so zero rows and nothing leaks.

## The part parameters cannot fix: `ORDER BY`

A placeholder binds a *value*. It cannot stand in for an *identifier* like a
column name — `ORDER BY ?` is a syntax error, and `ORDER BY ?` with the column
name as a string sorts every row by the same constant. So a user-selectable sort
column is the one legitimate place you must build SQL from input, and the only
safe way is an allow-list:

```js
const SORTABLE = new Map([
  ['username', 'username'],
  ['email', 'email'],
  ['id', 'id'],
])
const SORT_DIRECTIONS = new Set(['asc', 'desc'])

// ...validate, 400 on anything not in the allow-lists...
const sortColumn = SORTABLE.get(requestedSort)   // one of exactly three strings
const sortDir = requestedDir === 'desc' ? 'DESC' : 'ASC'

// lint-sql:allow sortColumn and sortDir are validated against the SORTABLE / SORT_DIRECTIONS allow-lists above
const sql = `SELECT username, email FROM users WHERE username LIKE ? ESCAPE '\\' ORDER BY ${sortColumn} ${sortDir}`
```

The `// lint-sql:allow` comment is mandatory here — `scripts/lint-sql.mjs` flags
every interpolated query, and this marker is how you tell it "I validated this
identifier against an allow-list", with the justification on the same line
(CONTRIBUTING §7). It is **not** a general escape hatch: it is only ever correct
when the interpolated thing can only be one of a fixed set of constant strings
your own code defines.

```bash
# a real column sorts:
curl -s 'http://localhost:3005/users/search?sort=username&dir=desc'
# an injection attempt in ?sort= is a 400, never executed:
curl -s 'http://localhost:3005/users/search?sort=username;%20DROP%20TABLE%20users--'
```

```json
{"ok":true,"count":4,"rows":[{"username":"carol",...},...],"sortedBy":"username DESC"}
{"ok":false,"error":"cannot sort by 'username; DROP TABLE users--'","allowed":["username","email","id"]}
```

## How to verify the fix

`npm test` runs each payload from the vulnerable example's `exploit.md` and
asserts it now fails:

```
✔ GET /health returns ok
✔ real credentials still log in
✔ wrong password is 401
✔ exploit 1a: ' OR '1'='1 no longer bypasses auth
✔ exploit 1b: admin' -- no longer bypasses auth
✔ exploit 2a: UNION cannot exfiltrate secret_token
✔ exploit 2b: UNION cannot dump the schema
✔ exploit 3: boolean-blind probes return the SAME result (no oracle)
✔ a literal percent in the search term is matched literally, not as a wildcard
✔ allow-listed ORDER BY: a known column sorts
✔ allow-listed ORDER BY: an injection in ?sort= is a 400, not executed
✔ allow-listed ORDER BY: an unknown direction is a 400
ℹ tests 12
ℹ pass 12
ℹ fail 0
```

Or run the two apps side by side and fire the same `curl` at both: the vulnerable
one on `:3004` leaks, this one on `:3005` returns `401` / `400` / zero rows.

## What to read in the source

`src/app.js`. Compare it line-for-line with
`examples/vulnerable-sql-injection/src/app.js` — `src/db.js` is identical between
the two, so the diff is exactly the set of changes that matter: `?` placeholders,
the LIKE escaping, the `ORDER BY` allow-list, and the generic error responses.
