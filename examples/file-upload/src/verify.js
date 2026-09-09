/**
 * The step that actually decides whether an upload is accepted.
 *
 * Runs AFTER multer, because you cannot sniff bytes that have not arrived yet.
 * multer's `fileFilter` sees only the part headers — the client's claimed name
 * and type — which is exactly the information you must not trust.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { sniffType, isAllowed, SNIFF_BYTES, ALLOWED_MIME } from './sniff.js'
import { UPLOAD_DIR, storedName, discard } from './storage.js'

/** Read only the first `SNIFF_BYTES` bytes — never slurp the whole file. */
async function readHead(filePath) {
  const handle = await fs.open(filePath, 'r')
  try {
    const buffer = Buffer.alloc(SNIFF_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, SNIFF_BYTES, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

function rejection(sniffed, file) {
  return {
    ok: false,
    reason: sniffed
      ? `content is ${sniffed.mime}, which is not allowed`
      : 'content type not recognized',
    declaredType: file.mimetype,
    detectedType: sniffed?.mime ?? 'unknown',
  }
}

function accepted(id, file, sniffed) {
  return {
    ok: true,
    file: {
      id,
      // Echoed back for display only. It is NOT what the file is called on disk.
      originalName: sanitizeForDisplay(file.originalname),
      declaredType: file.mimetype,
      detectedType: sniffed.mime,
      size: file.size,
      storedAs: id,
    },
  }
}

/**
 * Sniff a quarantined file, then either promote it into UPLOAD_DIR under
 * `<uuid>.<sniffed-ext>` or delete it.
 */
export async function verifyDiskFile(file, allowList = ALLOWED_MIME) {
  const head = await readHead(file.path)
  const sniffed = sniffType(head)

  if (!isAllowed(sniffed, allowList)) {
    await discard(file.path)
    return rejection(sniffed, file)
  }

  const id = storedName(sniffed.ext)
  // rename() within a volume is atomic, so the file is never half-visible in the
  // accepted directory.
  await fs.rename(file.path, path.join(UPLOAD_DIR, id))
  return accepted(id, file, sniffed)
}

/** Memory variant: nothing is written until the sniff passes. */
export async function verifyMemoryFile(file, allowList = ALLOWED_MIME) {
  const sniffed = sniffType(file.buffer.subarray(0, SNIFF_BYTES))
  if (!isAllowed(sniffed, allowList)) return rejection(sniffed, file)

  const id = storedName(sniffed.ext)
  // `wx` creates and fails rather than overwriting. With a UUID a collision is
  // impossible, but "create, never clobber" is the right default for a file the
  // outside world caused to exist.
  await fs.writeFile(path.join(UPLOAD_DIR, id), file.buffer, { flag: 'wx' })
  return accepted(id, file, sniffed)
}

/**
 * `originalname` is echoed in JSON responses, so drop C0 control characters and
 * DEL and cap the length. This is display hygiene, not a path defence — the
 * filesystem never sees this string at all.
 */
function sanitizeForDisplay(name) {
  return [...String(name ?? '')]
    .filter((ch) => {
      const code = ch.codePointAt(0)
      return code >= 0x20 && code !== 0x7f
    })
    .join('')
    .slice(0, 120)
}
