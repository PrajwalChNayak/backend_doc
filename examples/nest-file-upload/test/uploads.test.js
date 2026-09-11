/**
 * node --test
 *
 * Plain CommonJS against the compiled app in dist/. Run `npm run build` first.
 */
const test = require('node:test')
const assert = require('node:assert/strict')
const request = require('supertest')

const { createApp } = require('../dist/app-factory.js')
const { MAX_BYTES } = require('../dist/files/uploads.controller.js')

/** Smallest honest fixtures: a real GIF89a header, a real %PDF- header. */
const GIF = Buffer.concat([
  Buffer.from('GIF89a', 'ascii'),
  Buffer.from([0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00]),
])
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n', 'ascii')
const TEXT = Buffer.from('hello world, not an image', 'utf8')

let app
let server

test.before(async () => {
  app = await createApp({ silent: true })
  await app.init()
  server = app.getHttpServer()
})

test.after(async () => {
  await app.close()
})

test('GET /health is ok', async () => {
  const res = await request(server).get('/health').expect(200)
  assert.deepEqual(res.body, { status: 'ok' })
})

test('a real GIF is accepted and stored under a UUID name', async () => {
  const res = await request(server)
    .post('/uploads')
    .attach('file', GIF, { filename: 'tiny.gif', contentType: 'image/gif' })
    .expect(201)

  assert.equal(res.body.type, 'GIF89a')
  assert.match(res.body.storedAs, /^[0-9a-f-]{36}\.gif$/)
  assert.equal(res.body.originalNameReported, 'tiny.gif')
})

test('a real PDF is accepted', async () => {
  const res = await request(server)
    .post('/uploads')
    .attach('file', PDF, { filename: 'tiny.pdf', contentType: 'application/pdf' })
    .expect(201)
  assert.equal(res.body.type, 'PDF')
})

test('text claiming to be a PNG is rejected by the magic-byte validator', async () => {
  const res = await request(server)
    .post('/uploads')
    .attach('file', TEXT, { filename: 'notes.png', contentType: 'image/png' })
    .expect(422)
  assert.match(res.body.message, /no known signature/)
})

test('a dangerous filename never reaches the filesystem', async () => {
  const res = await request(server)
    .post('/uploads')
    .attach('file', GIF, { filename: '../../../etc/passwd.gif', contentType: 'image/gif' })
    .expect(201)
  // The stored name is a UUID plus the SNIFFED extension — no path, no dots.
  assert.match(res.body.storedAs, /^[0-9a-f-]{36}\.gif$/)
  assert.equal(res.body.storedAs.includes('..'), false)
})

test('a .png filename on PDF bytes is stored as .pdf', async () => {
  const res = await request(server)
    .post('/uploads')
    .attach('file', PDF, { filename: 'invoice.png', contentType: 'application/pdf' })
    .expect(201)
  assert.equal(res.body.type, 'PDF')
  assert.match(res.body.storedAs, /\.pdf$/)
})

test('an oversize file is a 413 from the multer limit', async () => {
  const big = Buffer.concat([GIF, Buffer.alloc(MAX_BYTES + 1024, 0x41)])
  const res = await request(server)
    .post('/uploads')
    .attach('file', big, { filename: 'big.gif', contentType: 'image/gif' })
    .expect(413)
  assert.equal(res.body.message, 'File too large')
})

test('two files is a 400 from the files limit', async () => {
  const res = await request(server)
    .post('/uploads')
    .attach('file', GIF, { filename: 'a.gif', contentType: 'image/gif' })
    .attach('file', GIF, { filename: 'b.gif', contentType: 'image/gif' })
    .expect(400)
  assert.equal(res.body.message, 'Too many files')
})

test('an unexpected field name is a 400', async () => {
  const res = await request(server)
    .post('/uploads')
    .attach('avatar', GIF, { filename: 'a.gif', contentType: 'image/gif' })
    .expect(400)
  assert.match(res.body.message, /Unexpected field/)
})

test('no file at all is a 422, not a crash', async () => {
  await request(server).post('/uploads').field('note', 'hello').expect(422)
})

test('GET /uploads lists what was stored, and metadata is fetched by id', async () => {
  const created = await request(server)
    .post('/uploads')
    .attach('file', GIF, { filename: 'listed.gif', contentType: 'image/gif' })
    .expect(201)

  const list = await request(server).get('/uploads').expect(200)
  assert.ok(list.body.data.some((row) => row.id === created.body.id))

  const one = await request(server).get(`/uploads/${created.body.id}`).expect(200)
  assert.equal(one.body.sha256, created.body.sha256)

  await request(server).get('/uploads/not-a-uuid').expect(400)
})
