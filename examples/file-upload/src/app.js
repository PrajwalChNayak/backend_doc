import express from 'express'
import helmet from 'helmet'
import multer from 'multer'
import fs from 'node:fs'
import path from 'node:path'

import { diskUpload, memoryUpload, MAX_FILE_BYTES, MAX_FILES, LIMITS } from './upload.js'
import { verifyDiskFile, verifyMemoryFile } from './verify.js'
import {
  ensureDirs,
  UPLOAD_DIR,
  PUBLIC_DIR,
  resolveStored,
  discard,
} from './storage.js'
import { ALLOWED_MIME, ALLOWED_MIME_WITH_PDF } from './sniff.js'

export function createApp() {
  ensureDirs()

  const app = express()
  app.disable('x-powered-by')
  app.use(helmet())

  // The static root. Note what is NOT under it: `var/uploads` and
  // `var/quarantine` are siblings of `public/`, not children. An uploaded file
  // is never reachable by URL path traversal because it is not inside anything
  // `express.static` serves.
  app.use('/public', express.static(PUBLIC_DIR, { dotfiles: 'ignore', index: false }))

  app.get('/health', (req, res) => {
    res.json({ status: 'ok' })
  })

  app.get('/limits', (req, res) => {
    res.json({ limits: LIMITS, allowed: [...ALLOWED_MIME_WITH_PDF] })
  })

  /**
   * Single file to disk (quarantine), then sniffed.
   * Field name: `avatar`.
   */
  app.post('/uploads/avatar', diskUpload.single('avatar'), async (req, res) => {
    if (!req.file) {
      res.status(400).json({ error: { code: 'NO_FILE', message: 'Expected a file in field "avatar"' } })
      return
    }

    const result = await verifyDiskFile(req.file, ALLOWED_MIME)
    if (!result.ok) {
      res.status(415).json({
        error: {
          code: 'UNSUPPORTED_MEDIA_TYPE',
          message: `Rejected: ${result.reason}`,
          declaredType: result.declaredType,
          detectedType: result.detectedType,
        },
      })
      return
    }
    res.status(201).json({ data: result.file })
  })

  /**
   * Up to MAX_FILES files. Any file that fails the sniff is deleted; the
   * accepted ones are still stored and both lists come back, so the client knows
   * exactly what happened to each part.
   */
  app.post('/uploads/batch', diskUpload.array('documents', MAX_FILES), async (req, res) => {
    const files = req.files ?? []
    if (files.length === 0) {
      res.status(400).json({ error: { code: 'NO_FILE', message: 'Expected at least one file in field "documents"' } })
      return
    }

    const accepted = []
    const rejected = []
    for (const file of files) {
      const result = await verifyDiskFile(file, ALLOWED_MIME_WITH_PDF)
      if (result.ok) accepted.push(result.file)
      else rejected.push({ originalName: file.originalname, ...result, ok: undefined })
    }

    res.status(rejected.length > 0 && accepted.length === 0 ? 415 : 201).json({
      data: { accepted, rejected },
    })
  })

  /**
   * Memory-storage variant. The bytes never reach the filesystem unless they
   * pass the sniff — safer, but it costs RSS per concurrent request, so the
   * fileSize limit on this route is deliberately smaller.
   */
  app.post('/uploads/memory', memoryUpload.single('image'), async (req, res) => {
    if (!req.file) {
      res.status(400).json({ error: { code: 'NO_FILE', message: 'Expected a file in field "image"' } })
      return
    }

    const result = await verifyMemoryFile(req.file, ALLOWED_MIME)
    if (!result.ok) {
      res.status(415).json({
        error: {
          code: 'UNSUPPORTED_MEDIA_TYPE',
          message: `Rejected: ${result.reason}`,
          declaredType: result.declaredType,
          detectedType: result.detectedType,
        },
      })
      return
    }
    res.status(201).json({ data: { ...result.file, storage: 'memory' } })
  })

  /**
   * Retrieval. NOT `express.static` over the upload directory — an explicit
   * handler so the response headers are ours:
   *
   *   Content-Type            the type WE detected, never one the client sent
   *   X-Content-Type-Options  nosniff, so the browser does not second-guess it
   *   Content-Disposition     attachment, so nothing renders in the origin
   *   Content-Security-Policy sandbox, belt-and-braces for old browsers
   */
  app.get('/files/:id', (req, res) => {
    const full = resolveStored(req.params.id)
    if (!full || !fs.existsSync(full)) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No such file' } })
      return
    }

    const ext = path.extname(full).slice(1).toLowerCase()
    const type =
      { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', pdf: 'application/pdf' }[ext] ??
      'application/octet-stream'

    res.set({
      'Content-Type': type,
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': `attachment; filename="${path.basename(full)}"`,
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Cache-Control': 'private, max-age=0, no-store',
    })
    fs.createReadStream(full).pipe(res)
  })

  app.delete('/files/:id', async (req, res) => {
    const full = resolveStored(req.params.id)
    if (!full || !fs.existsSync(full)) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No such file' } })
      return
    }
    await discard(full)
    res.status(204).end()
  })

  // Express 5 catch-all: '/*' is invalid under path-to-regexp v8.
  app.use('/{*splat}', (req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: `Cannot ${req.method} ${req.originalUrl}` } })
  })

  app.use(uploadErrorHandler)
  return app
}

/**
 * multer signals every limit breach as a `MulterError` with a `code`. Mapping
 * them by hand is the difference between a client that can fix its request and
 * one that just sees "500 Internal Server Error".
 *
 * `LIMIT_FILE_SIZE` is the only one that is genuinely a 413 — the request was
 * well-formed, it was simply too big. Everything else is the client sending
 * something the endpoint never agreed to accept, which is a 400.
 */
// eslint-disable-next-line no-unused-vars
export function uploadErrorHandler(err, req, res, next) {
  if (err instanceof multer.MulterError) {
    const map = {
      LIMIT_FILE_SIZE: {
        status: 413,
        message: `File too large. The limit is ${MAX_FILE_BYTES} bytes.`,
      },
      LIMIT_FILE_COUNT: { status: 400, message: `Too many files. The limit is ${MAX_FILES}.` },
      LIMIT_PART_COUNT: { status: 400, message: 'Too many parts in the multipart body.' },
      LIMIT_FIELD_COUNT: { status: 400, message: 'Too many form fields.' },
      LIMIT_FIELD_KEY: { status: 400, message: 'A form field name is too long.' },
      LIMIT_FIELD_VALUE: { status: 400, message: 'A form field value is too long.' },
      LIMIT_UNEXPECTED_FILE: {
        status: 400,
        message: 'Unexpected file, unexpected field name, or a rejected filename.',
      },
    }
    const mapped = map[err.code] ?? { status: 400, message: 'Malformed upload.' }

    // A part-way-written quarantine file can be left behind when multer aborts
    // mid-stream. Clean it up rather than letting the directory grow forever.
    cleanupPartials(req)

    res.status(mapped.status).json({
      error: { code: err.code, message: mapped.message, field: err.field },
    })
    return
  }

  // Not every multipart failure is a MulterError. busboy throws a plain Error
  // for a body it cannot parse at all — a NUL byte in a part header, a missing
  // boundary, a truncated stream. That is still the client's fault, so it must
  // be a 400: returning 500 here both misleads the client and pollutes your
  // error budget with traffic you cannot fix.
  if (BUSBOY_PARSE_ERRORS.test(err.message ?? '')) {
    cleanupPartials(req)
    res.status(400).json({
      error: { code: 'MALFORMED_MULTIPART', message: 'Could not parse the multipart body.' },
    })
    return
  }

  console.error(err)
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Internal Server Error' } })
}

const BUSBOY_PARSE_ERRORS =
  /^(Malformed part header|Unexpected end of form|Malformed content type|Multipart: Boundary not found|Unsupported content type|Missing Content-Type)/

function cleanupPartials(req) {
  const files = [req.file, ...(req.files ?? [])].filter(Boolean)
  for (const file of files) {
    if (file.path) fs.rmSync(file.path, { force: true })
  }
}

export { UPLOAD_DIR }
export default createApp
