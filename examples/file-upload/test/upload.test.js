import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import request from 'supertest'

// Point storage at a throwaway directory before src/storage.js is evaluated.
const testRoot = path.join(os.tmpdir(), `file-upload-test-${crypto.randomUUID()}`)
process.env.QUARANTINE_DIR = path.join(testRoot, 'quarantine')
process.env.UPLOAD_DIR = path.join(testRoot, 'uploads')

const { createApp } = await import('../src/app.js')
const {
  PNG_1X1,
  GIF_1X1,
  HTML_PRETENDING_TO_BE_PNG,
  PHP_PRETENDING_TO_BE_PNG,
  oversizedPng,
} = await import('../fixtures/upload-fixtures.js')

const app = createApp()

after(() => {
  fs.rmSync(testRoot, { recursive: true, force: true })
})

function quarantineFiles() {
  return fs.readdirSync(process.env.QUARANTINE_DIR)
}

before(() => {
  assert.equal(quarantineFiles().length, 0)
})

test('GET /health returns ok', async () => {
  const res = await request(app).get('/health')
  assert.equal(res.status, 200)
  assert.deepEqual(res.body, { status: 'ok' })
})

test('a real PNG is accepted and stored under a generated name', async () => {
  const res = await request(app)
    .post('/uploads/avatar')
    .attach('avatar', PNG_1X1, { filename: 'my photo.png', contentType: 'image/png' })

  assert.equal(res.status, 201, JSON.stringify(res.body))
  assert.equal(res.body.data.detectedType, 'image/png')

  // The stored name is a UUID plus the SNIFFED extension. Nothing of
  // `originalname` survives into the filesystem.
  assert.match(res.body.data.storedAs, /^[0-9a-f-]{36}\.png$/)
  assert.equal(res.body.data.storedAs.includes('my photo'), false)
  assert.ok(fs.existsSync(path.join(process.env.UPLOAD_DIR, res.body.data.storedAs)))

  // The quarantine directory is empty again: accepted files are moved out.
  assert.equal(quarantineFiles().length, 0)
})

test('an oversized file is a 413, not a 500', async () => {
  const res = await request(app)
    .post('/uploads/avatar')
    .attach('avatar', oversizedPng(), { filename: 'huge.png', contentType: 'image/png' })

  assert.equal(res.status, 413, JSON.stringify(res.body))
  assert.equal(res.body.error.code, 'LIMIT_FILE_SIZE')
  assert.match(res.body.error.message, /File too large/)

  // And the partial write multer left behind is cleaned up.
  assert.equal(quarantineFiles().length, 0)
})

test('HTML named .png and declared image/png is rejected with 415', async () => {
  const res = await request(app)
    .post('/uploads/avatar')
    .attach('avatar', HTML_PRETENDING_TO_BE_PNG, {
      filename: 'logo.png',
      contentType: 'image/png',
    })

  assert.equal(res.status, 415, JSON.stringify(res.body))
  assert.equal(res.body.error.code, 'UNSUPPORTED_MEDIA_TYPE')
  assert.equal(res.body.error.declaredType, 'image/png')
  assert.equal(res.body.error.detectedType, 'unknown')

  // Nothing was kept, anywhere.
  assert.equal(quarantineFiles().length, 0)
  assert.equal(
    fs.readdirSync(process.env.UPLOAD_DIR).some((f) => f.includes('logo')),
    false,
  )
})

test('PHP named .png and declared image/png is rejected with 415', async () => {
  const res = await request(app)
    .post('/uploads/avatar')
    .attach('avatar', PHP_PRETENDING_TO_BE_PNG, {
      filename: 'shell.php.png',
      contentType: 'image/png',
    })

  assert.equal(res.status, 415)
  assert.equal(res.body.error.detectedType, 'unknown')
  assert.equal(quarantineFiles().length, 0)
})

/**
 * superagent strips directories out of `filename` before it builds the
 * multipart body, so `.attach()` cannot express this attack. A real attacker is
 * not using superagent — so build the multipart body by hand.
 */
function rawMultipart({ field, filename, contentType, body }) {
  const boundary = `----test${crypto.randomUUID()}`
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${field}"; filename="${filename}"\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`,
    'utf8',
  )
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8')
  return { boundary, payload: Buffer.concat([head, body, tail]) }
}

test('a traversal filename cannot escape the upload directory', async () => {
  const { boundary, payload } = rawMultipart({
    field: 'avatar',
    filename: '../../../../etc/passwd.png',
    contentType: 'image/png',
    body: PNG_1X1,
  })

  const res = await request(app)
    .post('/uploads/avatar')
    .set('content-type', `multipart/form-data; boundary=${boundary}`)
    .send(payload)

  // multer 2 (via busboy) already reduces `filename` to its basename, so the
  // fileFilter's separator check never fires for this payload — worth knowing,
  // because it means people who *do* build paths from `originalname` often get
  // away with it right up until they hit a client that encodes the separator
  // differently. This app is safe for the structural reason instead: the stored
  // name is a generated UUID and `originalname` never reaches the filesystem.
  assert.equal(res.status, 201, JSON.stringify(res.body))
  assert.equal(res.body.data.originalName, 'passwd.png')
  assert.match(res.body.data.storedAs, /^[0-9a-f-]{36}\.png$/)

  // Nothing was created outside the upload directory.
  const stray = path.join(testRoot, '..', '..', '..', '..', 'etc', 'passwd.png')
  assert.equal(fs.existsSync(stray), false)
  assert.equal(quarantineFiles().length, 0)
})

test('a filename containing a NUL byte is a 400, not a 500', async () => {
  const { boundary, payload } = rawMultipart({
    field: 'avatar',
    filename: `shell.php${String.fromCharCode(0)}.png`,
    contentType: 'image/png',
    body: PNG_1X1,
  })

  const res = await request(app)
    .post('/uploads/avatar')
    .set('content-type', `multipart/form-data; boundary=${boundary}`)
    .send(payload)

  // busboy refuses to parse the part header at all, so this never reaches the
  // fileFilter. It arrives as a plain Error, and the handler still has to turn
  // it into a client error rather than a 500.
  assert.equal(res.status, 400, JSON.stringify(res.body))
  assert.equal(res.body.error.code, 'MALFORMED_MULTIPART')
  assert.equal(quarantineFiles().length, 0)
})

test('a wrong field name is a 400 LIMIT_UNEXPECTED_FILE', async () => {
  const res = await request(app)
    .post('/uploads/avatar')
    .attach('not-avatar', PNG_1X1, { filename: 'a.png', contentType: 'image/png' })

  assert.equal(res.status, 400)
  assert.equal(res.body.error.code, 'LIMIT_UNEXPECTED_FILE')
})

test('too many files is a 400 LIMIT_FILE_COUNT', async () => {
  let req = request(app).post('/uploads/batch')
  for (let i = 0; i < 5; i += 1) {
    req = req.attach('documents', PNG_1X1, { filename: `f${i}.png`, contentType: 'image/png' })
  }
  const res = await req

  assert.equal(res.status, 400, JSON.stringify(res.body))
  assert.equal(res.body.error.code, 'LIMIT_FILE_COUNT')
  assert.equal(quarantineFiles().length, 0)
})

test('too many fields is a 400 LIMIT_FIELD_COUNT', async () => {
  let req = request(app).post('/uploads/batch')
  for (let i = 0; i < 25; i += 1) req = req.field(`k${i}`, 'v')
  const res = await req.attach('documents', PNG_1X1, { filename: 'a.png', contentType: 'image/png' })

  assert.equal(res.status, 400, JSON.stringify(res.body))
  assert.ok(['LIMIT_FIELD_COUNT', 'LIMIT_PART_COUNT'].includes(res.body.error.code))
})

test('the batch route reports accepted and rejected files separately', async () => {
  const res = await request(app)
    .post('/uploads/batch')
    .attach('documents', PNG_1X1, { filename: 'good.png', contentType: 'image/png' })
    .attach('documents', GIF_1X1, { filename: 'good.gif', contentType: 'image/gif' })
    .attach('documents', HTML_PRETENDING_TO_BE_PNG, {
      filename: 'bad.png',
      contentType: 'image/png',
    })

  assert.equal(res.status, 201, JSON.stringify(res.body))
  assert.equal(res.body.data.accepted.length, 2)
  assert.equal(res.body.data.rejected.length, 1)
  assert.deepEqual(
    res.body.data.accepted.map((f) => f.detectedType).sort(),
    ['image/gif', 'image/png'],
  )
  assert.equal(quarantineFiles().length, 0)
})

test('the memory-storage route accepts a real image and rejects a fake one', async () => {
  const good = await request(app)
    .post('/uploads/memory')
    .attach('image', GIF_1X1, { filename: 'x.gif', contentType: 'image/gif' })

  assert.equal(good.status, 201, JSON.stringify(good.body))
  assert.equal(good.body.data.storage, 'memory')
  assert.equal(good.body.data.detectedType, 'image/gif')
  assert.match(good.body.data.storedAs, /\.gif$/)

  const bad = await request(app)
    .post('/uploads/memory')
    .attach('image', HTML_PRETENDING_TO_BE_PNG, { filename: 'x.png', contentType: 'image/png' })

  assert.equal(bad.status, 415)
  // Nothing was written for the rejected one.
  assert.equal(
    fs.readdirSync(process.env.UPLOAD_DIR).some((f) => f.endsWith('.html')),
    false,
  )
})

test('GET /files/:id serves the detected type with nosniff and attachment', async () => {
  const created = await request(app)
    .post('/uploads/avatar')
    .attach('avatar', PNG_1X1, { filename: 'a.png', contentType: 'image/png' })

  const res = await request(app).get(`/files/${created.body.data.id}`)
  assert.equal(res.status, 200)
  assert.equal(res.headers['content-type'], 'image/png')
  assert.equal(res.headers['x-content-type-options'], 'nosniff')
  assert.match(res.headers['content-disposition'], /^attachment/)
})

test('GET /files/:id refuses a traversal attempt', async () => {
  const res = await request(app).get('/files/..%2F..%2Fpackage.json')
  assert.equal(res.status, 404)
})

test('uploaded files are not reachable through the static root', async () => {
  const created = await request(app)
    .post('/uploads/avatar')
    .attach('avatar', PNG_1X1, { filename: 'a.png', contentType: 'image/png' })

  const viaStatic = await request(app).get(`/public/${created.body.data.id}`)
  assert.equal(viaStatic.status, 404)
})
