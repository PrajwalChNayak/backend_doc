# vulnerable-sql-injection

> # ⚠️ DANGER — DELIBERATELY VULNERABLE ⚠️
>
> **This application is intentionally broken. It is teaching material for the SQL
> injection page and nothing else. Never deploy it, never expose it beyond
> `127.0.0.1`, and never copy a single query from `src/` into real code.** Every
> query in `src/app.js` is assembled by string interpolation and is trivially
> exploitable. The whole point is to show the attack working so the fix means
> something.
>
> The corrected version — same routes, same seed data — is
> [`examples/fixed-sql-injection`](../fixed-sql-injection/README.md).

## Why this directory is allowed to exist

The repository's SQL-injection linter (`scripts/lint-sql.mjs`) fails the build on
any interpolated SQL. This example is exempt for exactly one reason: its
directory name starts with `vulnerable-`. That prefix is the only thing keeping
it in the tree, and every source file additionally opens with a
`// !!! DELIBERATELY VULNERABLE — DO NOT COPY !!!` banner. There are **no**
`// lint-sql:allow` suppression comments here — this code is not "allowed", it is
quarantined.

## What it demonstrates

Two endpoints, three classic attacks:

| Endpoint | Vulnerability | Attack shown in `exploit.md` |
| --- | --- | --- |
| `POST /login` | auth bypass | `' OR '1'='1`, and `admin' --` |
| `GET /users/search?q=` | data exfiltration | UNION column theft, schema dump, boolean-blind |

## Prerequisites

- Node.js 24 LTS.

## Install and run

```bash
cd examples/vulnerable-sql-injection
npm install
npm start
```

```
  !!! DELIBERATELY VULNERABLE SQL-INJECTION DEMO !!!
  listening on http://127.0.0.1:3004  (loopback only)
```

The server binds to `127.0.0.1` only. The port defaults to `3004` (`PORT`
overrides it). The database is in-memory and reseeded on every boot, so nothing
you do to it persists. There are no tests here — the exploits *are* the
demonstration, and the fixed example holds the assertions that they no longer
work.

## Routes

### `GET /health`

```bash
curl -s http://127.0.0.1:3004/health
```

```json
{"status":"ok"}
```

The one honest route. Used by the validator to know the app is up.

### `POST /login`

```bash
curl -s -X POST http://127.0.0.1:3004/login \
  -H 'content-type: application/json' \
  -d '{"username":"alice","password":"alice-password"}'
```

With real credentials it returns the user; with a payload it hands you somebody
else's account. See `exploit.md` §1.

### `GET /users/search?q=`

```bash
curl -s 'http://127.0.0.1:3004/users/search?q=ali'
```

```json
{"ok":true,"count":1,"rows":[{"username":"alice","email":"alice@example.com"}]}
```

With a payload it returns any column of any table. See `exploit.md` §2 and §3.

## The exploits

Full walkthrough with copy-paste `curl` commands and their real output:
**[`exploit.md`](./exploit.md)**. It covers:

1. **Authentication bypass** — `' OR '1'='1` and comment-truncation (`admin' --`).
2. **UNION extraction** — reading `secret_token` and dumping `sqlite_master`
   through an endpoint that only meant to return usernames.
3. **Boolean-blind** — reconstructing a secret one character at a time using only
   whether the response has rows.

Each one prints the exact SQL it produced to the server console, so you can watch
the injected string become part of the statement.

## What to read in the source

`src/app.js`. The two vulnerable lines are the template literals that build
`sql`:

```js
// login
const sql = `SELECT ... WHERE username = '${username}' AND password = '${password}'`
// search
const sql = `SELECT username, email FROM users WHERE username LIKE '%${q}%'`
```

Then read the same two lines in `examples/fixed-sql-injection/src/app.js`, where
the values are bound with `?` placeholders and the payloads become inert. The
schema in `src/db.js` is byte-for-byte identical between the two examples, so the
only thing that changed is how the query is built.

## Related note on error leakage

Both handlers return `err.message` and the raw `sql` in their 500 responses. That
is a second, separate vulnerability — verbose SQL errors hand an attacker the
column names and dialect for free. It is left in on purpose so you can see it;
the fixed example returns a generic message and logs the detail server-side.
