/**
 * The point of this example is that `node:sqlite` and `better-sqlite3` are
 * interchangeable behind one interface. These tests assert exactly that: both
 * stores are driven through the same HTTP surface and must agree, and the
 * `ORDER BY` allow-list must reject anything not on it.
 *
 *   node --test
 *
 * Each run gets its own temporary database files, so the suite is independent
 * of whatever is in ./data.
 */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import request from 'supertest'

import { createApp } from '../src/app.js'
import { createNodeSqliteStore } from '../src/node-sqlite-store.js'
import { createBetterSqliteStore } from '../src/better-sqlite3-store.js'
import { seedStore, SEED_USERS } from '../src/seed.js'

const SEED_EMAILS = new Set(SEED_USERS.map((u) => u.email))

let dir
let app
let nodeSqlite
let betterSqlite

before(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'db-sqlite-test-'))
  nodeSqlite = createNodeSqliteStore(path.join(dir, 'node.db'))
  betterSqlite = createBetterSqliteStore(path.join(dir, 'better.db'))
  seedStore(nodeSqlite)
  seedStore(betterSqlite)
  app = createApp({ nodeSqlite, betterSqlite })
})

after(() => {
  nodeSqlite?.close?.()
  betterSqlite?.close?.()
  rmSync(dir, { recursive: true, force: true })
})

const MOUNTS = ['/node-sqlite', '/better-sqlite3']

test('health reports both drivers with their seeded row counts', async () => {
  const res = await request(app).get('/health').expect(200)
  assert.equal(res.body.status, 'ok')
  assert.equal(res.body.drivers['node:sqlite'].users, 2)
  assert.equal(res.body.drivers['better-sqlite3'].users, 2)
})

for (const mount of MOUNTS) {
  test(`${mount}: seed data is present`, async () => {
    const res = await request(app).get(`${mount}/users`).expect(200)
    assert.equal(res.body.users.length, 2)
    assert.deepEqual(
      res.body.users.map((u) => u.email).sort(),
      ['ada@example.com', 'grace@example.com']
    )
  })

  test(`${mount}: a user's posts come back through the relation`, async () => {
    const res = await request(app).get(`${mount}/users/1/posts`).expect(200)
    assert.ok(res.body.posts.length >= 1)
    assert.ok(res.body.posts.every((p) => p.user_id === 1))
  })

  test(`${mount}: an unknown id is 404, not 500`, async () => {
    await request(app).get(`${mount}/users/999999`).expect(404)
  })

  test(`${mount}: a sort column outside the allow-list is rejected`, async () => {
    // `sort` is interpolated into ORDER BY, so it is validated against a fixed
    // set. Anything else must be refused before it reaches the SQL text.
    for (const bad of [';DROP TABLE users', 'password', '1', 'name; --']) {
      const res = await request(app).get(`${mount}/users`).query({ sort: bad })
      assert.equal(res.status, 400, `sort=${bad} should be rejected`)
    }
  })

  test(`${mount}: a value containing SQL is stored and returned literally`, async () => {
    const email = `injection-${mount.slice(1)}@example.com`
    const name = "Robert'); DROP TABLE users;--"

    await request(app).post(`${mount}/users`).send({ email, name }).expect(201)

    // The table still exists and the name round-tripped as data, not as SQL.
    const list = await request(app).get(`${mount}/users`).expect(200)
    const stored = list.body.users.find((u) => u.email === email)
    assert.ok(stored, 'the row was inserted')
    assert.equal(stored.name, name, 'stored verbatim — it was bound, not concatenated')
    assert.ok(list.body.users.length >= 3, 'no table was dropped')
  })
}

test('both drivers return identical rows for the same seed', async () => {
  const [a, b] = await Promise.all([
    request(app).get('/node-sqlite/users').expect(200),
    request(app).get('/better-sqlite3/users').expect(200),
  ])
  // Compare only the seeded rows: the tests above deliberately insert a
  // differently-named row into each store, which is not a parity concern.
  const seeded = (rows) =>
    rows
      .filter((u) => SEED_EMAILS.has(u.email))
      .map(({ id, email, name }) => ({ id, email, name }))
      .sort((x, y) => x.id - y.id)

  assert.deepEqual(seeded(a.body.users), seeded(b.body.users))
  assert.equal(seeded(a.body.users).length, 2)
})
