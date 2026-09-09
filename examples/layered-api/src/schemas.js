/**
 * Zod 4 schemas.
 *
 * Zod 4 moved the string formats to the top level: `z.email()`, `z.uuid()` —
 * NOT `z.string().email()`. The old chained form still parses but is deprecated.
 *
 * Every object schema is a `z.strictObject`, so an unexpected key is a 400
 * rather than something silently ignored. That is the cheapest possible defence
 * against mass assignment: a client that posts `{"title":"x","userId":"…"}`
 * gets rejected instead of quietly having the extra field dropped (or worse,
 * spread into an UPDATE).
 */
import { z } from 'zod'

export const registerBody = z.strictObject({
  email: z.email().max(254),
  name: z.string().trim().min(1).max(80),
  // 12 characters minimum; length beats composition rules. The upper bound
  // exists because the KDF cost is proportional to input length — an unbounded
  // password field is a denial-of-service vector.
  password: z.string().min(12).max(200),
})

export const loginBody = z.strictObject({
  email: z.email().max(254),
  password: z.string().min(1).max(200),
})

export const createNoteBody = z.strictObject({
  title: z.string().trim().min(1).max(200),
  body: z.string().max(10_000).default(''),
})

export const updateNoteBody = z
  .strictObject({
    title: z.string().trim().min(1).max(200).optional(),
    body: z.string().max(10_000).optional(),
  })
  .refine((v) => v.title !== undefined || v.body !== undefined, {
    message: 'Provide at least one of title or body',
  })

export const noteParams = z.strictObject({
  id: z.uuid(),
})

export const listNotesQuery = z.strictObject({
  // Query values are always strings. `z.coerce.*` converts before validating,
  // and `.default()` means the handler never has to write `?? 20`.
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
  q: z.string().trim().min(1).max(100).optional(),
})
