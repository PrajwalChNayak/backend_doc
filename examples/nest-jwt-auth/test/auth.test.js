/**
 * node --test
 *
 * Plain CommonJS JavaScript against the COMPILED app in dist/, so the tests run
 * with no TypeScript loader. Run `npm run build` first.
 */
// Set BEFORE the app is required: src/config.ts reads process.env at import
// time, so setting this inside a `before` hook would leave the app on a random
// per-boot secret and the "correct secret" tests below would pass for the wrong
// reason.
process.env.JWT_SECRET ||= 'test-secret-for-node-test'

const test = require('node:test')
const assert = require('node:assert/strict')
const jwt = require('jsonwebtoken')
const request = require('supertest')

const { createTestApp } = require('../dist/app-factory.js')

const ALICE = { username: 'alice', password: 'correct-horse-battery-staple' }
const ROOT = { username: 'root', password: 'admin-password-not-for-production' }

let app
let server

test.before(async () => {
  app = await createTestApp()
  server = app.getHttpServer()
})

test.after(async () => {
  await app.close()
})

async function login(credentials) {
  const res = await request(server).post('/auth/login').send(credentials).expect(200)
  return res.body.accessToken
}

test('GET /health is ok', async () => {
  const res = await request(server).get('/health').expect(200)
  assert.deepEqual(res.body, { status: 'ok' })
})

test('login returns a bearer token and a user without a password hash', async () => {
  const res = await request(server).post('/auth/login').send(ALICE).expect(200)
  assert.equal(res.body.tokenType, 'Bearer')
  assert.match(res.body.accessToken, /^[\w-]+\.[\w-]+\.[\w-]+$/)
  assert.deepEqual(Object.keys(res.body.user).sort(), ['id', 'roles', 'username'])
  assert.equal(JSON.stringify(res.body).includes('scrypt$'), false)
})

test('a wrong password and an unknown user give the same 401 body', async () => {
  const wrong = await request(server)
    .post('/auth/login')
    .send({ username: 'alice', password: 'nope' })
    .expect(401)
  const unknown = await request(server)
    .post('/auth/login')
    .send({ username: 'nobody', password: 'nope' })
    .expect(401)
  assert.deepEqual(wrong.body, unknown.body)
})

test('GET /auth/me needs a token', async () => {
  await request(server).get('/auth/me').expect(401)
  await request(server).get('/auth/me').set('authorization', 'Bearer not.a.token').expect(401)
})

test('GET /auth/me returns the token subject', async () => {
  const token = await login(ALICE)
  const res = await request(server).get('/auth/me').set('authorization', `Bearer ${token}`).expect(200)
  assert.equal(res.body.user.username, 'alice')
  assert.deepEqual(res.body.user.roles, ['user'])
})

/** The id of a real user, so a hand-signed token fails only for the reason under test. */
async function aliceId() {
  const token = await login(ALICE)
  const res = await request(server).get('/auth/me').set('authorization', `Bearer ${token}`).expect(200)
  return res.body.user.id
}

const GOOD_CLAIMS = {
  algorithm: 'HS256',
  expiresIn: '5m',
  issuer: 'https://nest-jwt-auth.example',
  audience: 'nest-jwt-auth-clients',
}

test('control: a hand-signed token with the right secret and claims IS accepted', async () => {
  // Without this control, every rejection test below could be passing for an
  // unrelated reason (a subject that does not exist, a malformed token, …).
  const sub = await aliceId()
  const token = jwt.sign({ sub, username: 'alice', roles: ['user'] }, process.env.JWT_SECRET, GOOD_CLAIMS)
  const res = await request(server).get('/auth/me').set('authorization', `Bearer ${token}`).expect(200)
  assert.equal(res.body.user.username, 'alice')
})

test('a token signed with the wrong secret is rejected', async () => {
  const sub = await aliceId()
  const forged = jwt.sign({ sub, username: 'alice', roles: ['admin'] }, 'not-the-secret', GOOD_CLAIMS)
  await request(server).get('/auth/me').set('authorization', `Bearer ${forged}`).expect(401)
})

test('a token with the right secret but the wrong issuer is rejected', async () => {
  const sub = await aliceId()
  const forged = jwt.sign({ sub, username: 'alice', roles: ['admin'] }, process.env.JWT_SECRET, {
    ...GOOD_CLAIMS,
    issuer: 'https://someone-else.example',
  })
  await request(server).get('/auth/me').set('authorization', `Bearer ${forged}`).expect(401)
})

test('a token with the right secret but the wrong audience is rejected', async () => {
  const sub = await aliceId()
  const forged = jwt.sign({ sub, username: 'alice', roles: ['admin'] }, process.env.JWT_SECRET, {
    ...GOOD_CLAIMS,
    audience: 'some-other-api',
  })
  await request(server).get('/auth/me').set('authorization', `Bearer ${forged}`).expect(401)
})

test('an expired token is rejected', async () => {
  const sub = await aliceId()
  const expired = jwt.sign({ sub, username: 'alice', roles: ['user'] }, process.env.JWT_SECRET, {
    ...GOOD_CLAIMS,
    expiresIn: '-1s',
  })
  await request(server).get('/auth/me').set('authorization', `Bearer ${expired}`).expect(401)
})

test('roles in the TOKEN do not override the roles in the store', async () => {
  // The strategy re-reads the user, so claiming to be an admin is not enough.
  const sub = await aliceId()
  const claimsAdmin = jwt.sign({ sub, username: 'alice', roles: ['admin'] }, process.env.JWT_SECRET, GOOD_CLAIMS)
  await request(server).get('/admin/stats').set('authorization', `Bearer ${claimsAdmin}`).expect(403)
})

test('roles: a user token is 403 on the admin route, an admin token is 200', async () => {
  const userToken = await login(ALICE)
  const adminToken = await login(ROOT)

  const denied = await request(server)
    .get('/admin/stats')
    .set('authorization', `Bearer ${userToken}`)
    .expect(403)
  assert.match(denied.body.message, /admin/)

  const allowed = await request(server)
    .get('/admin/stats')
    .set('authorization', `Bearer ${adminToken}`)
    .expect(200)
  assert.equal(typeof allowed.body.users, 'number')
})

test('the admin route rejects an anonymous caller before RolesGuard runs', async () => {
  await request(server).get('/admin/stats').expect(401)
})
