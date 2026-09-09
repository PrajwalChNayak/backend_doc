/**
 * Magic-byte content sniffing.
 *
 * WHY THIS EXISTS: `file.mimetype` from multer is whatever the client typed into
 * the multipart `Content-Type` header, and `file.originalname` is whatever the
 * client typed as the filename. Both are attacker-controlled strings. Trusting
 * either one is how `payload.php.png` and `logo.png` (actually HTML with a
 * <script> tag) get onto a server.
 *
 * The bytes are the only thing the client cannot lie about, because they *are*
 * the file. So: read the first few bytes and decide the type yourself.
 *
 * PRODUCTION NOTE: use `file-type@^22.0.2`. It knows hundreds of formats,
 * handles container formats properly, and is maintained. It is ESM-only, which
 * is fine for this project — it is left out here purely so this example has one
 * fewer dependency and the detection logic is visible rather than hidden behind
 * an import.
 *
 *     import { fileTypeFromBuffer } from 'file-type'
 *     const type = await fileTypeFromBuffer(buffer)   // { ext, mime } | undefined
 *
 * AND NOTE THE LIMIT OF THIS WHOLE TECHNIQUE: a valid JPEG can carry a PHP
 * payload in its EXIF comment. Sniffing proves "this is a JPEG"; it does not
 * prove "this is harmless". The other defences in this example — storage outside
 * any served directory, a generated filename, no execute permission, an explicit
 * Content-Type with `nosniff` on the way back out — are what make a hostile but
 * well-formed image inert.
 */

/**
 * Signature table. Each entry: the bytes that must appear at `offset`, plus an
 * optional second check for container formats.
 * Ordered longest-signature-first so a more specific match wins.
 */
const SIGNATURES = [
  {
    mime: 'image/png',
    ext: 'png',
    offset: 0,
    bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  },
  {
    mime: 'image/gif',
    ext: 'gif',
    offset: 0,
    bytes: [0x47, 0x49, 0x46, 0x38], // "GIF8" — covers 87a and 89a
  },
  {
    mime: 'application/pdf',
    ext: 'pdf',
    offset: 0,
    bytes: [0x25, 0x50, 0x44, 0x46, 0x2d], // "%PDF-"
  },
  {
    mime: 'image/webp',
    ext: 'webp',
    offset: 0,
    bytes: [0x52, 0x49, 0x46, 0x46], // "RIFF"
    // A RIFF container is only a WebP if bytes 8..11 say so.
    also: { offset: 8, bytes: [0x57, 0x45, 0x42, 0x50] }, // "WEBP"
  },
  {
    mime: 'image/jpeg',
    ext: 'jpg',
    offset: 0,
    bytes: [0xff, 0xd8, 0xff], // SOI + first marker
  },
]

/** How many bytes the table needs to see. */
export const SNIFF_BYTES = 16

function matches(buffer, offset, bytes) {
  if (buffer.length < offset + bytes.length) return false
  for (let i = 0; i < bytes.length; i += 1) {
    if (buffer[offset + i] !== bytes[i]) return false
  }
  return true
}

/**
 * @param {Buffer} buffer at least the first `SNIFF_BYTES` bytes of the file
 * @returns {{ mime: string, ext: string } | null} null when nothing matched —
 *   which is the correct answer for HTML, scripts, ZIPs, and anything else not
 *   on the allow-list.
 */
export function sniffType(buffer) {
  if (!Buffer.isBuffer(buffer)) return null
  for (const sig of SIGNATURES) {
    if (!matches(buffer, sig.offset, sig.bytes)) continue
    if (sig.also && !matches(buffer, sig.also.offset, sig.also.bytes)) continue
    return { mime: sig.mime, ext: sig.ext }
  }
  return null
}

/** Everything this API will accept. Anything else is a 415. */
export const ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

export const ALLOWED_MIME_WITH_PDF = new Set([...ALLOWED_MIME, 'application/pdf'])

export function isAllowed(sniffed, allowList = ALLOWED_MIME) {
  return Boolean(sniffed) && allowList.has(sniffed.mime)
}
