# layered-api

The reference application for this handbook: **routes → controllers → services →
repositories**, with the security middleware, validation, auth, logging and
shutdown handling a real Express 5 API needs. It boots with `npm install && npm
start` and needs no database server, no Redis, and no `.env` file.

## What it demonstrates

| Concern | File | Point of interest |
| --- | --- | --- |
| Layering | `src/routes/`, `src/controllers/`, `src/services/`, `src/repositories/` | SQL exists in exactly one layer; `res` exists in exactly one layer |
| Zod 4 validation | `src/middleware/validate.js`, `src/schemas.js` | Output goes to `req.valid`, **never** `req.query` (Express 5 getter) |
| Mass-assignment defence | `src/schemas.js` | `z.strictObject` — an unknown key is a 400, not a silent drop |
| JWT auth | `src/lib/tokens.js`, `src/middleware/auth.js` | `algorithms: ['HS256']` + `issuer` + `audience` on verify |
| Password hashing | `src/lib/password.js` | promisified `node:crypto` scrypt, `timingSafeEqual`, dummy-hash on unknown user |
| IDOR defence | `src/repositories/note.repository.js` | every query is scoped by `user_id` in the `WHERE` clause; another user's note is **404**, not 403 |
| Error mapping | `src/middleware/error-handler.js` | `ZodError`→400, `AppError`→its status, unknown→500 with no stack in production |
| Logging | `src/logger.js` | pino `redact` for `authorization`, `cookie`, `password`, `token` |
| Headers / CORS / limits | `src/app.js` | helmet, an allow-list `origin` function, `express-rate-limit` v8 |
| Graceful shutdown | `src/server.js` | readiness off → `server.close()` + `closeIdleConnections()` → deadline → close DB → exit |
| Health vs readiness | `src/readiness.js` | `/health` is liveness, `/ready` goes 503 on SIGTERM |

## Prerequisites

- Node.js 24 LTS. Verify with `node --version`.

Nothing else. The database is a SQLite file created in your OS temp directory on
boot and deleted on clean shutdown.

## Install and run

```bash
cd examples/layered-api
npm install
npm start
```

```
{"level":30,...,"driver":"better-sqlite3","file":"...\\layered-api-7d28a2....sqlite","msg":"database ready"}
{"level":30,...,"port":3002,"env":"development","msg":"layered-api listening"}
```

Listens on `http://localhost:3002`. Run the tests with:

```bash
npm test
```

### Configuration

Everything is read in `src/config.js` and every value has a working default.

| Variable | Default | Notes |
| --- | --- | --- |
| `PORT` | `3002` | |
| `JWT_SECRET` | random per boot (dev), **required** in production | Tokens do not survive a restart in dev |
| `JWT_ISSUER` | `https://layered-api.example` | Checked on verify |
| `JWT_AUDIENCE` | `layered-api-clients` | Checked on verify |
| `JWT_EXPIRES_IN` | `15m` | |
| `DATABASE_FILE` | a temp file | Set it to keep data between runs |
| `CORS_ORIGINS` | `http://localhost:5173,http://localhost:3000` | Comma-separated exact origins |
| `RATE_LIMIT_MAX` / `RATE_LIMIT_AUTH_MAX` | `100` / `10` per minute | |
| `LOG_LEVEL` | `info` | `silent` in tests |
| `SHUTDOWN_DEADLINE_MS` | `10000` | Drain deadline |

Load them from a file with Node's own flag — no `dotenv` needed:

```bash
node --env-file=.env src/server.js
```

## Routes

### `GET /health` — liveness

```bash
curl -s http://localhost:3002/health
```

```json
{"status":"ok"}
```

### `GET /ready` — readiness

```bash
curl -s http://localhost:3002/ready
```

```json
{"status":"ok","driver":"better-sqlite3"}
```

After `SIGTERM` this becomes `503` with `{"status":"shutting_down"}` while
`/health` stays `200`. That is the whole point of having two probes.

### `POST /auth/register`

```bash
curl -s -X POST http://localhost:3002/auth/register \
  -H 'content-type: application/json' \
  -d '{"email":"ada@example.com","name":"Ada","password":"correct-horse-battery-staple"}'
```

```json
{"data":{"id":"c6493805-e304-4b72-80ba-2c4078370057","email":"ada@example.com","name":"Ada","createdAt":"2026-09-08T18:04:45.496Z"}}
```

No password hash is ever in a response — `publicUser()` in
`src/services/auth.service.js` is the only shape that leaves the service layer.

Registering the same address twice returns `409`.

### `POST /auth/login`

```bash
curl -s -X POST http://localhost:3002/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"ada@example.com","password":"correct-horse-battery-staple"}'
```

```json
{"data":{"token":"eyJhbGciOiJIUzI1NiIs…","tokenType":"Bearer","user":{"id":"c649…","email":"ada@example.com","name":"Ada","createdAt":"…"}}}
```

Save it for the calls below:

```bash
TOKEN=$(curl -s -X POST http://localhost:3002/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"ada@example.com","password":"correct-horse-battery-staple"}' \
  | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).data.token')
```

A wrong password and an unknown address both return the same body, and take
roughly the same time:

```json
{"error":{"code":"UNAUTHORIZED","message":"Invalid email or password"}}
```

### `GET /auth/me`

```bash
curl -s http://localhost:3002/auth/me -H "authorization: Bearer $TOKEN"
```

### `POST /notes`

```bash
curl -s -X POST http://localhost:3002/notes \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"title":"read the source","body":"start at src/app.js"}'
```

```json
{"data":{"id":"4eb4022c-48a3-403a-a3a3-5229510667ce","userId":"c649…","title":"read the source","body":"start at src/app.js","createdAt":"…","updatedAt":"…"}}
```

### `GET /notes?limit=&offset=&q=`

```bash
curl -s "http://localhost:3002/notes?limit=5" -H "authorization: Bearer $TOKEN"
```

```json
{"data":[{"id":"4eb4022c-…","userId":"c649…","title":"read the source","body":"start at src/app.js","createdAt":"…","updatedAt":"…"}],"meta":{"total":1,"limit":5,"offset":0}}
```

### `GET` / `PATCH` / `DELETE /notes/:id`

`:id` must be a UUID or you get a `400` before any query runs.

## The failure modes, and what they return

### 400 — validation

```bash
curl -s -X POST http://localhost:3002/notes \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"title":""}'
```

```json
{"error":{"code":"VALIDATION_FAILED","message":"Request validation failed","issues":[{"path":"body.title","code":"too_small","message":"Too small: expected string to have >=1 characters"}]}}
```

### 400 — query validation, without ever writing to `req.query`

```bash
curl -s "http://localhost:3002/notes?limit=9999" -H "authorization: Bearer $TOKEN"
```

```json
{"error":{"code":"VALIDATION_FAILED","message":"Request validation failed","issues":[{"path":"query.limit","code":"too_big","message":"Too big: expected number to be <=100"}]}}
```

### 400 — mass assignment

```bash
curl -s -X POST http://localhost:3002/notes \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"title":"ok","userId":"somebody-elses-id"}'
```

`z.strictObject` rejects the extra key with `unrecognized_keys` rather than
quietly dropping it.

### 401 — no token, bad signature, wrong issuer, expired

```bash
curl -s -i http://localhost:3002/notes | head -1
```

```
HTTP/1.1 401 Unauthorized
{"error":{"code":"UNAUTHORIZED","message":"Missing bearer token"}}
```

Every other token failure returns the identical `Invalid or expired token`. The
`WWW-Authenticate` header carries the coarse reason; the body never says whether
the signature or the audience was wrong.

### 404 — somebody else's resource

```bash
curl -s -i "http://localhost:3002/notes/<a-note-belonging-to-another-user>" \
  -H "authorization: Bearer $TOKEN" | head -1
```

```
HTTP/1.1 404 Not Found
```

**404, not 403.** A 403 confirms the id exists, which hands an attacker a free
enumeration oracle. Because the repository scopes on `user_id` in the `WHERE`
clause, there is no code path that could return the row in the first place.

## Password hashing: why scrypt here, argon2id in production

**In production, use `argon2@^0.45.1` with `argon2id`.** It is the current
password-hashing recommendation (OWASP, and the winner of the Password Hashing
Competition). It resists GPU and ASIC cracking better than scrypt at equivalent
cost, and its parameters (memory, iterations, parallelism) are easier to reason
about.

```js
import argon2 from 'argon2'

const hash = await argon2.hash(password, {
  type: argon2.argon2id,
  memoryCost: 19456, // 19 MiB — the OWASP minimum
  timeCost: 2,
  parallelism: 1,
})
const ok = await argon2.verify(hash, password)
```

This example uses `node:crypto` scrypt instead **because `argon2` requires a
native build**, and the contract for this repository is that every example runs
after a plain `npm install` on any machine, including CI images with no compiler
toolchain. scrypt is not a compromise on correctness — it is a memory-hard KDF
in its own right, it ships with Node, and everything else in
`src/lib/password.js` (random per-password salt, self-describing parameter
string, `timingSafeEqual` comparison, a dummy hash for unknown accounts) is
exactly what you would write around argon2 too. Swapping the two functions in
that file is the entire migration.

Note the `maxmem` option: `N=32768, r=8` needs about 32 MiB, which is Node's
default ceiling, so the call fails without raising it. That is the single most
common scrypt mistake.

## Database

`better-sqlite3@^13.0.3`, opened on a temp file at boot so there is nothing to
set up and nothing to clean up. **Every statement is parameterised** — look at
`src/repositories/`; there is no string interpolation anywhere near the SQL, and
the search term in `listNotesByUser` binds `%term%` as a *value* with the LIKE
wildcards escaped.

If `better-sqlite3`'s native binary is unavailable, `src/db/index.js` falls back
to `node:sqlite`, which is built into Node 24 and needs no build step. Both
drivers expose `prepare().get()/.all()/.run()`, so nothing above the driver
changes. `GET /ready` reports which one is in use. On this machine
`better-sqlite3@13.0.3` installed from a prebuilt binary with no compiler
involved.

## Graceful shutdown

```bash
# with the server running in another terminal
kill -TERM <pid>
```

```
{"level":30,...,"signal":"SIGTERM","msg":"shutdown requested"}
{"level":30,...,"drained":true,"msg":"shutdown complete"}
```

The order in `src/server.js` is deliberate:

1. **readiness false** so the load balancer stops sending new requests;
2. `server.close()` — refuses new connections, callback fires when the last
   in-flight request finishes;
3. `server.closeIdleConnections()` — without this, idle keep-alive sockets hold
   the server open for the full `keepAliveTimeout` and `server.close()` looks
   like it has hung;
4. a `SHUTDOWN_DEADLINE_MS` timer so one stuck request cannot block the deploy;
5. `closeDatabase()` — only after draining, because an in-flight request may
   have been querying;
6. `process.exit(0)` if drained, `1` if the deadline was hit.

:::note
Windows does not deliver POSIX `SIGTERM` to a Node process, so `kill -TERM` from
a Git Bash shell will not trigger this handler there. `SIGINT` (Ctrl-C) does.
:::

## What to read in the source

Start at `src/app.js` — the middleware order and the comment explaining why each
one sits where it does. Then follow one request all the way down:
`src/routes/note.routes.js` → `src/controllers/note.controller.js` →
`src/services/note.service.js` → `src/repositories/note.repository.js`. Notice
that the controller is three lines, the service holds the rule ("a note you do
not own is a 404"), and the repository holds the SQL. Nothing reaches across.

The two files with the highest surprise-per-line are
`src/middleware/validate.js` (the Express 5 `req.query` getter trap) and
`src/lib/password.js` (`maxmem`, `timingSafeEqual`, and the dummy hash).

## Tests

`node --test` runs `test/api.test.js` against the app object with supertest — no
port is bound.

```
✔ GET /health returns ok
✔ happy path: register, login, create a note, read it back
✔ the response never contains a password hash
✔ validation failure -> 400 with field-level issues
✔ validation failure -> unknown body keys are rejected (mass assignment)
✔ validation failure -> a bad query parameter is a 400, and req.query is untouched
✔ auth failure -> 401 with no token
✔ auth failure -> 401 for a token signed with the wrong secret
✔ auth failure -> 401 for a valid signature with the wrong issuer
✔ auth failure -> wrong password is 401 with a generic message
✔ authorization failure -> another user's note is 404, not 403
✔ duplicate registration is a 409
✔ unknown routes hit the splat 404 handler
✔ a disallowed CORS origin gets no allow-origin header
✔ helmet security headers are present
ℹ tests 15
ℹ pass 15
ℹ fail 0
```
