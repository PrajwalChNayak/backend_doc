/**
 * The multer configuration.
 *
 * EVERY limit is set. Not because every one is exciting, but because multer's
 * defaults for most of them are `Infinity`, and each unbounded field is a way to
 * make the process do unbounded work before your handler ever runs.
 */
import multer from 'multer'
import path from 'node:path'
import { QUARANTINE_DIR, quarantineName } from './storage.js'
import { SNIFF_BYTES } from './sniff.js'

export const MAX_FILE_BYTES = Number(process.env.MAX_FILE_BYTES ?? 2 * 1024 * 1024) // 2 MiB
export const MAX_FILES = 3

/**
 * `busboy` limits, all of them.
 *
 * | limit         | what it caps                         | multer default |
 * | ------------- | ------------------------------------ | -------------- |
 * | fileSize      | bytes per file                       | Infinity       |
 * | files         | number of file parts                 | Infinity       |
 * | fields        | number of non-file fields            | Infinity       |
 * | parts         | file + field parts combined          | Infinity       |
 * | fieldNameSize | bytes in a field NAME                | 100            |
 * | fieldSize     | bytes in a field VALUE               | 1 MiB          |
 * | headerPairs   | headers parsed per multipart part    | 2000           |
 *
 * `parts` is the one people forget. Without it a request with a hundred thousand
 * tiny fields is perfectly legal: each one is under `fieldSize` and there are no
 * files at all, so `fileSize` and `files` never fire.
 */
export const LIMITS = {
  fileSize: MAX_FILE_BYTES,
  files: MAX_FILES,
  fields: 10,
  parts: MAX_FILES + 10,
  fieldNameSize: 100,
  fieldSize: 8 * 1024,
  headerPairs: 32,
}

/**
 * A cheap pre-filter on the declared type. This is NOT the security control —
 * `file.mimetype` is client-supplied — it just avoids writing an obviously wrong
 * file to disk before the real check. The real check is the magic-byte sniff in
 * `src/verify.js`, which runs after the bytes have actually arrived.
 */
function fileFilter(req, file, cb) {
  const declared = String(file.mimetype ?? '').toLowerCase()
  if (!declared.startsWith('image/') && declared !== 'application/pdf') {
    cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', file.fieldname))
    return
  }
  // Reject a filename that is trying to be a path. multer 2 already reduces
  // `originalname` to a basename via busboy, so in practice this branch rarely
  // fires — keep it anyway: it documents the intent, and it is the thing that
  // saves you the day somebody "helpfully" puts `originalname` back into the
  // storage code. (A NUL byte does not even get this far; busboy refuses to
  // parse the part header, which src/app.js maps to a 400.)
  const name = String(file.originalname ?? '')
  if (name.includes('/') || name.includes('\\') || name.includes('\0') || name.length > 255) {
    cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', file.fieldname))
    return
  }
  cb(null, true)
}

/**
 * Disk variant. Files land in the quarantine directory under a random name with
 * NO extension, so even if something else were ever pointed at that directory
 * there is nothing there a web server would agree to execute.
 */
export const diskUpload = multer({
  storage: multer.diskStorage({
    destination(req, file, cb) {
      cb(null, QUARANTINE_DIR)
    },
    filename(req, file, cb) {
      // `path.extname(file.originalname)` is what most tutorials write here.
      // Do not. The extension is decided after sniffing, in src/verify.js.
      cb(null, quarantineName())
    },
  }),
  limits: LIMITS,
  fileFilter,
})

/**
 * Memory variant. The buffer never touches the filesystem unless it passes the
 * sniff, which is strictly safer — but it costs `fileSize` bytes of RSS per
 * concurrent upload, so the limit has to be small and you have to mean it.
 */
export const memoryUpload = multer({
  storage: multer.memoryStorage(),
  limits: { ...LIMITS, fileSize: Math.min(MAX_FILE_BYTES, 1024 * 1024), files: 1 },
  fileFilter,
})

export { SNIFF_BYTES, path }
