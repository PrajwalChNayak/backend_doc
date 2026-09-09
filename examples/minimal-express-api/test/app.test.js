import test from 'node:test'
import assert from 'node:assert/strict'
import request from 'supertest'
import { createApp } from '../src/app.js'
import { resetNotes } from '../src/store.js'

const app = createApp()

test.beforeEach(() => resetNotes())

test('GET /health returns ok', async () => {
  const res = await request(app).get('/health')
  assert.equal(res.status, 200)
  assert.deepEqual(res.body, { status: 'ok' })
})

test('POST /notes then GET /notes/:id round-trips', async () => {
  const created = await request(app).post('/notes').send({ title: 'buy milk' })
  assert.equal(created.status, 201)
  assert.equal(created.body.data.title, 'buy milk')

  const fetched = await request(app).get(`/notes/${created.body.data.id}`)
  assert.equal(fetched.status, 200)
  assert.equal(fetched.body.data.id, created.body.data.id)
})

test('POST /notes without a title is a 400', async () => {
  const res = await request(app).post('/notes').send({})
  assert.equal(res.status, 400)
  assert.match(res.body.error.message, /title/)
})

test('unknown paths hit the Express 5 splat 404 handler', async () => {
  const res = await request(app).get('/definitely/not/here')
  assert.equal(res.status, 404)
  assert.equal(res.body.error.message, 'Cannot GET /definitely/not/here')
})

test('a throwing async route reaches the error handler as a 500', async () => {
  const res = await request(app).get('/boom')
  assert.equal(res.status, 500)
  assert.deepEqual(res.body, { error: { message: 'Internal Server Error' } })
})

test('DELETE /notes/:id removes the note', async () => {
  const created = await request(app).post('/notes').send({ title: 'temp' })
  const del = await request(app).delete(`/notes/${created.body.data.id}`)
  assert.equal(del.status, 204)
  const after = await request(app).get(`/notes/${created.body.data.id}`)
  assert.equal(after.status, 404)
})
