/**
 * Where uploads live, and how they are named.
 *
 * Two directories, both OUTSIDE `public/`:
 *
 *   var/quarantine/  multer writes here first, under a random name with NO
 *                    extension. Nothing serves this directory. A file that fails
 *                    sniffing is deleted from here and never moves.
 *   var/uploads/     accepted files, named `<uuid>.<ext-from-the-sniffed-type>`.
 *                    Also not served statically — `GET /files/:id` reads them
 *                    explicitly, so there is no path where the web server could
 *                    be talked into executing one.
 *
 * The one rule that matters: `originalname` never touches the filesystem. It is
 * an attacker-controlled string and it has produced every one of
 * `../../etc/passwd`, `shell.php`, a 4 KB filename, and a NUL-byte truncation
 * bug at some point in some real application.
 */
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

export const PUBLIC_DIR = path.join(root, 'public')
export const QUARANTINE_DIR = process.env.QUARANTINE_DIR ?? path.join(root, 'var', 'quarantine')
export const UPLOAD_DIR = process.env.UPLOAD_DIR ?? path.join(root, 'var', 'uploads')

export function ensureDirs() {
  fsSync.mkdirSync(QUARANTINE_DIR, { recursive: true })
  fsSync.mkdirSync(UPLOAD_DIR, { recursive: true })
}

/** `<uuid>` — no extension yet, because the type is not known until we sniff. */
export function quarantineName() {
  return crypto.randomUUID()
}

/**
 * The final stored name. The extension comes from the SNIFFED type, never from
 * `originalname`, so `evil.php.png` cannot become `evil.php` on disk.
 */
export function storedName(ext) {
  return `${crypto.randomUUID()}.${ext}`
}

/**
 * Resolve an id to a path inside UPLOAD_DIR, refusing anything that escapes it.
 * Belt and braces: ids are generated UUIDs, but a lookup helper that can be
 * handed `../../` is a liability regardless of who currently calls it.
 */
export function resolveStored(id) {
  if (!/^[0-9a-f-]{36}\.[a-z0-9]{2,5}$/i.test(id)) return null
  const full = path.resolve(UPLOAD_DIR, id)
  const rel = path.relative(UPLOAD_DIR, full)
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null
  return full
}

export async function discard(fullPath) {
  if (!fullPath) return
  await fs.rm(fullPath, { force: true }).catch(() => {})
}
