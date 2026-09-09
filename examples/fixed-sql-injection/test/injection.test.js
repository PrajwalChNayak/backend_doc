/**
 * Runs the EXACT payloads from examples/vulnerable-sql-injection/exploit.md
 * against the fixed app and asserts each one now fails: auth bypass → 401, data
 * exfiltration → zero attacker rows, and a sort-column probe → 400.
 *
 * If any of these ever passes, the fix regressed.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import request from 'supertest'
import { createApp } from '../src/app.js'

const app = createApp()

test('GET /health returns ok', async () => {
  const res = await request(app).get('/health')
  assert.equal(res.status, 200)
  assert.deepEqual(res.body, { status: 'ok' })
})

test('real credentials still log in', async () => {
  const res = await request(app).post('/login').send({ username: 'alice', password: 'alice-password' })
  assert.equal(res.status, 200)
  assert.equal(res.body.user.username, 'alice')
})

test('wrong password is 401', async () => {
  const res = await request(app).post('/login').send({ username: 'alice', password: 'nope' })
  assert.equal(res.status, 401)
})

test("exploit 1a: ' OR '1'='1 no longer bypasses auth", async () => {
  const res = await request(app)
    .post('/login')
    .send({ username: "x' OR '1'='1", password: "x' OR '1'='1" })
  assert.equal(res.status, 401)
  assert.equal(res.body.ok, false)
})

test("exploit 1b: admin' -- no longer bypasses auth", async () => {
  const res = await request(app).post('/login').send({ username: "admin' -- ", password: 'anything' })
  assert.equal(res.status, 401)
})

test('exploit 2a: UNION cannot exfiltrate secret_token', async () => {
  const res = await request(app)
    .get('/users/search')
    .query({ q: "zzz' UNION SELECT username, secret_token FROM users--" })

  assert.equal(res.status, 200)
  // The whole payload is treated as a literal search string; it matches no
  // username, so zero rows — and crucially no token leaks.
  assert.equal(res.body.count, 0)
  assert.equal(JSON.stringify(res.body).includes('tok_'), false)
})

test('exploit 2b: UNION cannot dump the schema', async () => {
  const res = await request(app)
    .get('/users/search')
    .query({ q: "zzz' UNION SELECT name, sql FROM sqlite_master--" })

  assert.equal(res.status, 200)
  assert.equal(res.body.count, 0)
  assert.equal(JSON.stringify(res.body).includes('CREATE TABLE'), false)
})

test('exploit 3: boolean-blind probes return the SAME result (no oracle)', async () => {
  const truthy = await request(app).get('/users/search').query({ q: "a%' AND '1'='1' -- " })
  const falsy = await request(app).get('/users/search').query({ q: "a%' AND '1'='2' -- " })

  // In the vulnerable app these differed (3 rows vs 0). Here both are treated as
  // the same literal search for the string `a%' AND ...`, which matches nothing,
  // so the attacker learns nothing from the difference — there is none.
  assert.equal(truthy.body.count, 0)
  assert.equal(falsy.body.count, 0)
  assert.deepEqual(truthy.body.rows, falsy.body.rows)
})

test('a literal percent in the search term is matched literally, not as a wildcard', async () => {
  // Seed the point: normal search still works.
  const normal = await request(app).get('/users/search').query({ q: 'ali' })
  assert.equal(normal.body.count, 1)
  assert.equal(normal.body.rows[0].username, 'alice')

  // A bare '%' would match everything if wildcards were not escaped.
  const percent = await request(app).get('/users/search').query({ q: '%' })
  assert.equal(percent.body.count, 0)
})

test('allow-listed ORDER BY: a known column sorts', async () => {
  const asc = await request(app).get('/users/search').query({ q: '', sort: 'username', dir: 'asc' })
  const desc = await request(app).get('/users/search').query({ q: '', sort: 'username', dir: 'desc' })

  assert.equal(asc.status, 200)
  assert.equal(asc.body.count, 4)
  assert.deepEqual(
    asc.body.rows.map((r) => r.username),
    ['admin', 'alice', 'bob', 'carol'],
  )
  assert.deepEqual(
    desc.body.rows.map((r) => r.username),
    ['carol', 'bob', 'alice', 'admin'],
  )
})

test('allow-listed ORDER BY: an injection in ?sort= is a 400, not executed', async () => {
  const res = await request(app)
    .get('/users/search')
    .query({ q: '', sort: 'username; DROP TABLE users--' })

  assert.equal(res.status, 400)
  assert.match(res.body.error, /cannot sort by/)

  // Prove the table is intact afterwards.
  const after = await request(app).get('/users/search').query({ q: 'ali' })
  assert.equal(after.status, 200)
  assert.equal(after.body.count, 1)
})

test('allow-listed ORDER BY: an unknown direction is a 400', async () => {
  const res = await request(app)
    .get('/users/search')
    .query({ q: '', sort: 'username', dir: 'asc; DELETE FROM users' })
  assert.equal(res.status, 400)
})
