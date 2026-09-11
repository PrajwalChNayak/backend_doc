# nest-jwt-auth — JWT authentication and role authorization in NestJS 12

`@nestjs/jwt` 12 for signing, `@nestjs/passport` 12 with a `passport-jwt`
strategy for verifying, a `@Roles()` decorator with a `RolesGuard` for
authorization, and `node:crypto` scrypt for password hashing. In-memory users, so
it runs with nothing installed but npm packages.

## What it demonstrates

| Thing | Where |
| --- | --- |
| `JwtModule.register()` with `algorithm`, `issuer`, `audience`, `expiresIn` | `src/auth/auth.module.ts` |
| A `passport-jwt` strategy **pinned to HS256 on verify** | `src/auth/jwt.strategy.ts` |
| `issuer` / `audience` checked on verify, not just set on sign | `src/auth/jwt.strategy.ts` |
| `validate()` re-reading the user, so a demoted account stops working now | `src/auth/jwt.strategy.ts` |
| `JwtAuthGuard extends AuthGuard('jwt')` | `src/auth/jwt-auth.guard.ts` |
| `@Roles()` + `RolesGuard` via `Reflector.getAllAndOverride` | `src/auth/roles.*.ts` |
| Guard **order** — authenticate, then authorize | `src/admin.controller.ts` |
| scrypt hashing with `maxmem`, `timingSafeEqual`, and a dummy hash | `src/lib/password.ts` |
| Identical 401 for "wrong password" and "no such user" | `src/auth/auth.service.ts` |
| 13 `node:test` + supertest tests, including a positive control | `test/auth.test.js` |

## Prerequisites

Node **20.19+ / 22.12+ / 24 LTS**. Nothing else.

## Install, build, run

```bash
cd examples/nest-jwt-auth
npm install
npm run setup     # = npm run build
npm start
npm test          # node --test
```

Port **3036** (`PORT`).

| Variable | Default | Notes |
| --- | --- | --- |
| `JWT_SECRET` | random per boot | Tokens do not survive a restart in dev. **Required** in production — the app throws at boot without it when `NODE_ENV=production`. |
| `JWT_ISSUER` | `https://nest-jwt-auth.example` | Checked on verify |
| `JWT_AUDIENCE` | `nest-jwt-auth-clients` | Checked on verify |
| `JWT_EXPIRES_IN` | `15m` | |

Seeded users:

| Username | Password | Roles |
| --- | --- | --- |
| `alice` | `correct-horse-battery-staple` | `user` |
| `root` | `admin-password-not-for-production` | `user`, `admin` |

## Routes

### `POST /auth/login`

```bash
curl -s -X POST http://localhost:3036/auth/login \
  -H 'content-type: application/json' \
  -d '{"username":"alice","password":"correct-horse-battery-staple"}'
```

```json
{"accessToken":"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiI3ODY1YmI5Mi0zNGQwLTQ2NjMtYTgxZS04NDkxYWUzMTI0ODgiLCJ1c2VybmFtZSI6ImFsaWNlIiwicm9sZXMiOlsidXNlciJdLCJpYXQiOjE3ODkxNTI1NTYsImV4cCI6MTc4OTE1MzQ1NiwiYXVkIjoibmVzdC1qd3QtYXV0aC1jbGllbnRzIiwiaXNzIjoiaHR0cHM6Ly9uZXN0LWp3dC1hdXRoLmV4YW1wbGUifQ.…","tokenType":"Bearer","expiresIn":"15m","issuer":"https://nest-jwt-auth.example","audience":"nest-jwt-auth-clients","user":{"id":"7865bb92-34d0-4663-a81e-8491ae312488","username":"alice","roles":["user"]}}
```

**200, not 201** — logging in creates no resource.

Save the token:

```bash
TOKEN=$(curl -s -X POST http://localhost:3036/auth/login \
  -H 'content-type: application/json' \
  -d '{"username":"alice","password":"correct-horse-battery-staple"}' \
  | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).accessToken')
```

A wrong password and an unknown username return the **same body** and take a
similar amount of time:

```bash
curl -s -X POST http://localhost:3036/auth/login -H 'content-type: application/json' \
  -d '{"username":"alice","password":"nope"}'
curl -s -X POST http://localhost:3036/auth/login -H 'content-type: application/json' \
  -d '{"username":"nobody","password":"nope"}'
```

```json
{"message":"Invalid username or password","error":"Unauthorized","statusCode":401}
{"message":"Invalid username or password","error":"Unauthorized","statusCode":401}
```

The service verifies against a throwaway dummy hash when the user does not
exist. An early `return` for an unknown username makes the endpoint answer
faster for missing accounts, and that timing difference is a user-enumeration
oracle.

### `GET /auth/me` — authenticated

```bash
curl -s http://localhost:3036/auth/me -H "authorization: Bearer $TOKEN"
```

```json
{"user":{"id":"7865bb92-34d0-4663-a81e-8491ae312488","username":"alice","roles":["user"]}}
```

```bash
curl -s -i http://localhost:3036/auth/me | head -1
curl -s http://localhost:3036/auth/me
```

```
HTTP/1.1 401 Unauthorized
{"message":"Unauthorized","statusCode":401}
```

### `GET /admin/stats` — authenticated **and** authorized

As `alice`:

```bash
curl -s -i http://localhost:3036/admin/stats -H "authorization: Bearer $TOKEN" | head -1
curl -s http://localhost:3036/admin/stats -H "authorization: Bearer $TOKEN"
```

```
HTTP/1.1 403 Forbidden
{"message":"Requires one of: admin","error":"Forbidden","statusCode":403}
```

As `root`:

```json
{"users":2,"generatedAt":"2026-09-11T18:49:17.870Z"}
```

**403 here, not 404.** The caller is authenticated and the route exists — they
are simply not allowed. A 404 is the right answer when the *existence* of a
resource is itself privileged; see `nest-fixed` for that case.

## The five details that matter

### 1. Pin the algorithm on verify

```ts
algorithms: ['HS256']
```

Without it, a verifier accepts whatever the token's own `alg` header asks for.
That is how `alg: "none"` and the RS256→HS256 confusion attack work: the
attacker picks the algorithm, and in the second case your *public* key becomes
the HMAC secret. The accepted list is yours to state, not the token's.

### 2. Check `issuer` and `audience` on verify, not just on sign

Signing with `issuer` and doing nothing with it on the way back in is decoration.
Both are in the strategy options, so a token minted by a sibling service that
happens to share the secret is still rejected.

### 3. Guard order is authenticate, then authorize

```ts
@UseGuards(JwtAuthGuard, RolesGuard)
```

They run in that order. Swapped, `RolesGuard` runs before anything has set
`request.user` and sees every request as anonymous. `RolesGuard` also fails
closed — no user with `@Roles()` present is a 403, never a pass.

### 4. Re-read the user in `validate()`

The token says `roles: ['user']`, but the strategy ignores that and looks the
user up. One test proves it: a token hand-signed with the correct secret
claiming `roles: ['admin']` still gets a 403 on `/admin/stats`. The cost is one
lookup per request; the benefit is that a revoked or demoted account stops
working immediately instead of at token expiry.

### 5. `PassportModule` has to be **exported**

`AdminController` lives in `AppModule` and uses `JwtAuthGuard`, which injects
`AuthModuleOptions` from `PassportModule`. Importing `PassportModule` inside
`AuthModule` is not enough — it must be re-exported:

```ts
exports: [AuthService, PassportModule]
```

Without that line, the app dies at boot. This is the real error, from this
example before the fix:

```
ERROR [ExceptionHandler] UnknownDependenciesException [Error]: Nest can't resolve
dependencies of the JwtAuthGuard (?). Please make sure that the argument
AuthModuleOptions at index [0] is available in the AppModule module.
```

## Password hashing: scrypt here, argon2id in production

**In production use `argon2@^0.45.1` with `argon2id`.** It is the current OWASP
recommendation and the Password Hashing Competition winner; it resists GPU and
ASIC cracking better than scrypt at equivalent cost, and its parameters are
easier to reason about.

```ts
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
native build**, and every example in this repository must install on a bare CI
image with no C++ toolchain. scrypt is not a compromise: it is a memory-hard KDF
in its own right, it ships with Node, and everything around it in
`src/lib/password.ts` — a random per-password salt, a self-describing parameter
string, `timingSafeEqual`, and the dummy hash for unknown users — is exactly what
you would write around argon2. Swapping the two functions in that one file is the
entire migration.

Note `maxmem`. `N=32768, r=8` needs about 32 MiB, which is Node's default
ceiling, so the call fails with "memory limit exceeded" unless you raise it.
That is the single most common scrypt mistake.

## Tests

```bash
npm test
```

```
✔ GET /health is ok
✔ login returns a bearer token and a user without a password hash
✔ a wrong password and an unknown user give the same 401 body
✔ GET /auth/me needs a token
✔ GET /auth/me returns the token subject
✔ control: a hand-signed token with the right secret and claims IS accepted
✔ a token signed with the wrong secret is rejected
✔ a token with the right secret but the wrong issuer is rejected
✔ a token with the right secret but the wrong audience is rejected
✔ an expired token is rejected
✔ roles in the TOKEN do not override the roles in the store
✔ roles: a user token is 403 on the admin route, an admin token is 200
✔ the admin route rejects an anonymous caller before RolesGuard runs
ℹ tests 13
ℹ pass 13
ℹ fail 0
```

The **control** test earns its place: without it, every "is rejected" test could
be passing for an unrelated reason — a subject that does not exist, a malformed
token, a secret that was random because the env var was set too late. It proves
the rejections are caused by the thing each test names.

## Related examples

- `nest-crud-module` — the same guard mechanism with a shared secret instead of
  a user.
- `examples/layered-api` — the Express 5 version of this auth stack.
