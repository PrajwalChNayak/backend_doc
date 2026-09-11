/**
 * The schemas are the contract. There is no DTO class and no decorator — Nest
 * 12 accepts any Standard Schema object, so Zod, Valibot and ArkType all work
 * here unchanged.
 */
import { z } from 'zod'

export const taskStatus = z.enum(['todo', 'doing', 'done'])

/**
 * `strictObject` rejects unknown keys instead of stripping them. It is the Zod
 * equivalent of `forbidNonWhitelisted: true` on the class-validator pipe, and
 * it is the mass-assignment defence: `{"title":"x","isAdmin":true}` is a 400.
 */
export const createTaskSchema = z.strictObject({
  title: z.string().min(1).max(120),
  notes: z.string().max(2000).optional(),
  status: taskStatus.default('todo'),
  /** Optional contact, validated with Zod 4's top-level `z.email()`. */
  ownerEmail: z.email().optional(),
})

export const updateTaskSchema = createTaskSchema.partial()

/**
 * Query strings are strings. `z.coerce.number()` converts before the range
 * check runs, which is the Zod counterpart of `@Type(() => Number)`.
 */
export const listTasksSchema = z.strictObject({
  status: taskStatus.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
})

/**
 * The RESPONSE schema. A plain (non-strict) object, so Zod strips every key it
 * does not name — `ownerEmail` and `internalNote` never reach the client even
 * though the stored record has them.
 */
export const publicTaskSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  notes: z.string(),
  status: taskStatus,
  createdAt: z.iso.datetime(),
})

export const publicTaskListSchema = z.object({
  data: z.array(publicTaskSchema),
  total: z.number().int(),
})

export type CreateTaskInput = z.infer<typeof createTaskSchema>
export type UpdateTaskInput = z.infer<typeof updateTaskSchema>
export type ListTasksInput = z.infer<typeof listTasksSchema>
