import { Injectable, Logger, NotFoundException } from '@nestjs/common'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { sniff } from './magic-bytes.validator.js'

/**
 * Uploads land OUTSIDE any directory the app serves statically. If an uploaded
 * file can be fetched back from the same origin, a "harmless" upload becomes
 * stored XSS (an SVG or an HTML file), and anything the server might execute
 * becomes remote code execution.
 */
export const UPLOAD_DIR = resolve(process.env.UPLOAD_DIR ?? join(tmpdir(), 'nest-file-upload'))

mkdirSync(UPLOAD_DIR, { recursive: true })

export interface StoredFile {
  id: string
  storedAs: string
  type: string
  mime: string
  size: number
  sha256: string
  originalNameReported: string
  uploadedAt: string
}

@Injectable()
export class UploadsService {
  private readonly logger = new Logger(UploadsService.name)
  private readonly index = new Map<string, StoredFile>()

  async store(file: Express.Multer.File): Promise<StoredFile> {
    const detected = sniff(file.buffer)!

    // The filename is generated, never derived from the client's. A client
    // filename can be "../../etc/passwd", "..\\web.config", a 4 KB unicode
    // string, or "index.html" — and the extension comes from the SNIFFED type,
    // so a .png that is really a PDF cannot be stored as .png.
    const id = randomUUID()
    const storedAs = `${id}${detected.extension}`
    const absolute = join(UPLOAD_DIR, storedAs)

    await writeFile(absolute, file.buffer, { flag: 'wx' }) // wx: never overwrite

    const record: StoredFile = {
      id,
      storedAs,
      type: detected.type,
      mime: detected.mime,
      size: file.size,
      sha256: createHash('sha256').update(file.buffer).digest('hex'),
      // Kept for display only, and never used to build a path.
      originalNameReported: file.originalname.slice(0, 200),
      uploadedAt: new Date().toISOString(),
    }
    this.index.set(id, record)
    this.logger.log(`stored ${storedAs} (${detected.type}, ${file.size} bytes)`)
    return record
  }

  list(): StoredFile[] {
    return [...this.index.values()].sort((a, b) => a.uploadedAt.localeCompare(b.uploadedAt))
  }

  get(id: string): StoredFile {
    const record = this.index.get(id)
    if (!record) throw new NotFoundException(`No upload with id ${id}`)
    return record
  }

  /** Reads a stored file back by ID — never by a path the caller supplied. */
  async read(id: string): Promise<{ record: StoredFile; bytes: Buffer }> {
    const record = this.get(id)
    const bytes = await readFile(join(UPLOAD_DIR, record.storedAs))
    return { record, bytes }
  }

  async diskUsage(): Promise<{ directory: string; files: number; bytes: number }> {
    const names = await readdir(UPLOAD_DIR)
    let bytes = 0
    for (const name of names) bytes += (await stat(join(UPLOAD_DIR, name))).size
    return { directory: UPLOAD_DIR, files: names.length, bytes }
  }
}
