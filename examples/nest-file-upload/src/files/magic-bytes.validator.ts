/**
 * A custom `FileValidator` that checks what the bytes ARE, not what the request
 * says they are.
 *
 * `file.mimetype` is copied from the `Content-Type` the client typed into the
 * multipart part, and the extension is part of a filename the client chose.
 * Both are claims. The first few bytes of a file are evidence.
 *
 * The signature table below is deliberately inline. The `file-type` package
 * (22.0.2) knows hundreds of formats and is the right answer for a general
 * uploader — but it is **ESM-only**, so a CommonJS Nest build can only reach it
 * through a dynamic `import()`. Nine formats' worth of magic bytes is a table,
 * not a dependency.
 */
import { FileValidator } from '@nestjs/common'

export interface Signature {
  /** Human-readable type name. */
  type: string
  /** Canonical media type. */
  mime: string
  /** Bytes that must appear at `offset`. */
  bytes: number[]
  offset: number
  /** Optional second run of bytes that must also match (WebP, for example). */
  also?: { bytes: number[]; offset: number }
  extension: string
}

/** Verified against the format specifications, not guessed. */
export const SIGNATURES: Signature[] = [
  { type: 'PNG', mime: 'image/png', extension: '.png', offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { type: 'JPEG', mime: 'image/jpeg', extension: '.jpg', offset: 0, bytes: [0xff, 0xd8, 0xff] },
  { type: 'GIF87a', mime: 'image/gif', extension: '.gif', offset: 0, bytes: [0x47, 0x49, 0x46, 0x38, 0x37, 0x61] },
  { type: 'GIF89a', mime: 'image/gif', extension: '.gif', offset: 0, bytes: [0x47, 0x49, 0x46, 0x38, 0x39, 0x61] },
  {
    type: 'WEBP',
    mime: 'image/webp',
    extension: '.webp',
    offset: 0,
    bytes: [0x52, 0x49, 0x46, 0x46], // "RIFF"
    also: { offset: 8, bytes: [0x57, 0x45, 0x42, 0x50] }, // "WEBP"
  },
  { type: 'PDF', mime: 'application/pdf', extension: '.pdf', offset: 0, bytes: [0x25, 0x50, 0x44, 0x46, 0x2d] }, // "%PDF-"
]

export function sniff(buffer: Buffer): Signature | undefined {
  return SIGNATURES.find((signature) => {
    const head = buffer.subarray(signature.offset, signature.offset + signature.bytes.length)
    if (!head.equals(Buffer.from(signature.bytes))) return false
    if (!signature.also) return true
    const second = buffer.subarray(signature.also.offset, signature.also.offset + signature.also.bytes.length)
    return second.equals(Buffer.from(signature.also.bytes))
  })
}

export interface MagicBytesValidatorOptions {
  /** Allowed `type` values from SIGNATURES, e.g. ['PNG', 'JPEG', 'PDF']. */
  allow: string[]
}

export class MagicBytesValidator extends FileValidator<MagicBytesValidatorOptions, Express.Multer.File> {
  constructor(options: MagicBytesValidatorOptions) {
    super(options)
  }

  isValid(file?: Express.Multer.File): boolean {
    if (!file?.buffer) return false
    const detected = sniff(file.buffer)
    return detected !== undefined && this.validationOptions.allow.includes(detected.type)
  }

  buildErrorMessage(file?: Express.Multer.File): string {
    const detected = file?.buffer ? sniff(file.buffer) : undefined
    const claimed = file?.mimetype ?? 'nothing'
    return detected
      ? `File contents are ${detected.type}; allowed: ${this.validationOptions.allow.join(', ')}`
      : `File contents match no known signature (the request claimed ${claimed}); allowed: ${this.validationOptions.allow.join(', ')}`
  }
}
