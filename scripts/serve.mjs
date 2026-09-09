#!/usr/bin/env node
/**
 * serve.mjs — a static preview server for docs/.
 *
 *   node scripts/serve.mjs            # http://localhost:8080
 *   node scripts/serve.mjs 3000
 *
 * Zero dependencies, like the rest of the toolchain. It exists so you can look
 * at the generated site before pushing it; GitHub Pages serves docs/ directly.
 */

import { createServer } from 'node:http'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs')
const PORT = Number(process.argv[2] || process.env.PORT || 8080)

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`)
  let rel = decodeURIComponent(url.pathname)
  if (rel.endsWith('/')) rel += 'index.html'

  // Containment check: resolve, then verify the result is still inside ROOT.
  const target = path.resolve(ROOT, '.' + rel)
  if (target !== ROOT && !target.startsWith(ROOT + path.sep)) {
    res.writeHead(403).end('Forbidden')
    return
  }

  try {
    const info = await stat(target)
    const file = info.isDirectory() ? path.join(target, 'index.html') : target
    await stat(file)
    res.writeHead(200, {
      'content-type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-store',
    })
    createReadStream(file).pipe(res)
  } catch {
    res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<h1>404</h1><p>Not found. Run <code>node scripts/build.mjs</code> first.</p>')
  }
})

server.listen(PORT, () => {
  console.log(`\n  Serving docs/ at http://localhost:${PORT}\n  Ctrl+C to stop\n`)
})
