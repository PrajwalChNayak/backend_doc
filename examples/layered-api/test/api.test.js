/**
 * These run against the real app object via supertest — no port is bound and no
 * external service is involved. The database is a fresh temp file per run.
 *
 * Environment has to be set BEFORE src/config.js is first evaluated, so the app
 * is pulled in with a dynamic `import()` after the assignments below rather than
 * a hoisted static import.
 */
process.env.NODE_ENV = 'test'
process.env.LOG_LEVEL = 'silent'
process.env.JWT_SECRET = 'test-secret-that-is-long-enough-for-hs256'
process.env.RATE_LIMIT_MAX = '100000'
process.env.RATE_LIMIT_AUTH_MAX = '100000'

import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import request from 'supertest'

const { initDatabase, closeDatabase } = await import('../src/db/index.js')
const { createApp } = await import('../src/app.js')

await initDatabase()
const app = createApp()

after(() => closeDatabase())

/** Registers a user and returns { token, user }. */
async function makeUser(label) {
  const email = `${label}-${crypto.randomUUID()}@example.com`
  const password = 'correct-horse-battery-staple'

  const registered = await request(app)
    .post('/auth/register')
    .send({ email, name: label, password })
  assert.equal(registered.status, 201, JSON.stringify(registered.body))

  const loggedIn = await request(app).post('/auth/login').send({ email, password })
  assert.equal(loggedIn.status, 200, JSON.stringify(loggedIn.body))

  return { token: loggedIn.body.data.token, user: loggedIn.body.data.user, password }
}

let alice
let bob

before(async () => {
  alice = await makeUser('alice')
  bob = await makeUser('bob')
})

test('GET /health returns ok', async () => {
  const res = await request(app).get('/health')
  assert.equal(res.status, 200)
  assert.deepEqual(res.body, { status: 'ok' })
})

test('happy path: register, login, create a note, read it back', async () => {
  const created = await request(app)
    .post('/notes')
    .set('authorization', `Bearer ${alice.token}`)
    .send({ title: 'first note', body: 'hello' })

  assert.equal(created.status, 201, JSON.stringify(created.body))
  assert.equal(created.body.data.title, 'first note')
  assert.equal(created.body.data.userId, alice.user.id)
  assert.equal(created.headers.location, `/notes/${created.body.data.id}`)

  const fetched = await request(app)
    .get(`/notes/${created.body.data.id}`)
    .set('authorization', `Bearer ${alice.token}`)

  assert.equal(fetched.status, 200)
  assert.equal(fetched.body.data.body, 'hello')

  const listed = await request(app)
    .get('/notes?limit=5')
    .set('authorization', `Bearer ${alice.token}`)

  assert.equal(listed.status, 200)
  assert.ok(listed.body.data.some((n) => n.id === created.body.data.id))
  assert.equal(listed.body.meta.limit, 5)
})

test('the response never contains a password hash', async () => {
  const res = await request(app).get('/auth/me').set('authorization', `Bearer ${alice.token}`)
  assert.equal(res.status, 200)
  assert.equal(res.body.data.id, alice.user.id)
  assert.equal(JSON.stringify(res.body).includes('scrypt$'), false)
  assert.equal('passwordHash' in res.body.data, false)
})

test('validation failure -> 400 with field-level issues', async () => {
  const res = await request(app)
    .post('/notes')
    .set('authorization', `Bearer ${alice.token}`)
    .send({ title: '' })

  assert.equal(res.status, 400)
  assert.equal(res.body.error.code, 'VALIDATION_FAILED')
  assert.ok(res.body.error.issues.some((i) => i.path === 'body.title'))
})

test('validation failure -> unknown body keys are rejected (mass assignment)', async () => {
  const res = await request(app)
    .post('/notes')
    .set('authorization', `Bearer ${alice.token}`)
    .send({ title: 'ok', userId: bob.user.id })

  assert.equal(res.status, 400)
  assert.ok(res.body.error.issues.some((i) => i.code === 'unrecognized_keys'))
})

test('validation failure -> a bad query parameter is a 400, and req.query is untouched', async () => {
  const res = await request(app)
    .get('/notes?limit=9999')
    .set('authorization', `Bearer ${alice.token}`)

  assert.equal(res.status, 400)
  assert.ok(res.body.error.issues.some((i) => i.path === 'query.limit'))
})

test('auth failure -> 401 with no token', async () => {
  const res = await request(app).get('/notes')
  assert.equal(res.status, 401)
  assert.equal(res.body.error.code, 'UNAUTHORIZED')
  assert.match(res.headers['www-authenticate'], /^Bearer/)
})

test('auth failure -> 401 for a token signed with the wrong secret', async () => {
  const jwt = (await import('jsonwebtoken')).default
  const forged = jwt.sign({ email: 'mallory@example.com' }, 'not-the-real-secret', {
    algorithm: 'HS256',
    subject: alice.user.id,
    issuer: 'https://layered-api.example',
    audience: 'layered-api-clients',
    expiresIn: '15m',
  })

  const res = await request(app).get('/notes').set('authorization', `Bearer ${forged}`)
  assert.equal(res.status, 401)
  assert.equal(res.body.error.message, 'Invalid or expired token')
})

test('auth failure -> 401 for a valid signature with the wrong issuer', async () => {
  const jwt = (await import('jsonwebtoken')).default
  const wrongIssuer = jwt.sign({ email: alice.user.email }, process.env.JWT_SECRET, {
    algorithm: 'HS256',
    subject: alice.user.id,
    issuer: 'https://some-other-service.example',
    audience: 'layered-api-clients',
    expiresIn: '15m',
  })

  const res = await request(app).get('/notes').set('authorization', `Bearer ${wrongIssuer}`)
  assert.equal(res.status, 401)
})

test('auth failure -> wrong password is 401 with a generic message', async () => {
  const res = await request(app)
    .post('/auth/login')
    .send({ email: alice.user.email, password: 'definitely-not-the-password' })

  assert.equal(res.status, 401)
  assert.equal(res.body.error.message, 'Invalid email or password')
})

test('authorization failure -> another user\'s note is 404, not 403', async () => {
  const bobsNote = await request(app)
    .post('/notes')
    .set('authorization', `Bearer ${bob.token}`)
    .send({ title: "bob's secret" })
  assert.equal(bobsNote.status, 201)

  const stolen = await request(app)
    .get(`/notes/${bobsNote.body.data.id}`)
    .set('authorization', `Bearer ${alice.token}`)

  // 404 rather than 403: a 403 would confirm the id exists.
  assert.equal(stolen.status, 404)
  assert.equal(stolen.body.error.code, 'NOT_FOUND')
  assert.equal(JSON.stringify(stolen.body).includes("bob's secret"), false)

  const deleteAttempt = await request(app)
    .delete(`/notes/${bobsNote.body.data.id}`)
    .set('authorization', `Bearer ${alice.token}`)
  assert.equal(deleteAttempt.status, 404)

  // And it is genuinely still there for Bob.
  const stillThere = await request(app)
    .get(`/notes/${bobsNote.body.data.id}`)
    .set('authorization', `Bearer ${bob.token}`)
  assert.equal(stillThere.status, 200)
})

test('duplicate registration is a 409', async () => {
  const res = await request(app)
    .post('/auth/register')
    .send({ email: alice.user.email, name: 'imposter', password: 'correct-horse-battery-staple' })
  assert.equal(res.status, 409)
})

test('unknown routes hit the splat 404 handler', async () => {
  const res = await request(app).get('/not/a/route')
  assert.equal(res.status, 404)
  assert.equal(res.body.error.message, 'Cannot GET /not/a/route')
})

test('a disallowed CORS origin gets no allow-origin header', async () => {
  const blocked = await request(app).get('/health').set('origin', 'https://evil.example')
  assert.equal(blocked.status, 200)
  assert.equal(blocked.headers['access-control-allow-origin'], undefined)

  const allowed = await request(app).get('/health').set('origin', 'http://localhost:5173')
  assert.equal(allowed.headers['access-control-allow-origin'], 'http://localhost:5173')
})

test('helmet security headers are present', async () => {
  const res = await request(app).get('/health')
  assert.equal(res.headers['x-content-type-options'], 'nosniff')
  assert.equal(res.headers['x-powered-by'], undefined)
  assert.ok(res.headers['content-security-policy'])
})
