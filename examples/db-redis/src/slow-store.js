/**
 * Stands in for the expensive thing you are caching — a relational database, an
 * upstream HTTP API, a report query. It sleeps for `SLOW_MS` so the difference
 * between a cache hit and a cache miss is visible in the response.
 */
import { setTimeout as sleep } from 'node:timers/promises'

const SLOW_MS = Number(process.env.SLOW_MS ?? 250)

const USERS = new Map(
  [
    { id: 1, email: 'ada@example.com', name: 'Ada Lovelace' },
    { id: 2, email: 'grace@example.com', name: 'Grace Hopper' },
    { id: 3, email: 'alan@example.com', name: 'Alan Turing' },
  ].map((u) => [u.id, u]),
)

export const stats = { reads: 0 }

export async function findUser(id) {
  await sleep(SLOW_MS)
  stats.reads += 1
  return USERS.get(id) ?? null
}

export async function updateUserName(id, name) {
  await sleep(SLOW_MS)
  const user = USERS.get(id)
  if (!user) return null
  const updated = { ...user, name }
  USERS.set(id, updated)
  return updated
}

export const SLOW_MS_VALUE = SLOW_MS
