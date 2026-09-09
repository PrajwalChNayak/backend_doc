import { MongoClient } from 'mongodb'

export const MONGODB_URL = process.env.MONGODB_URL ?? 'mongodb://localhost:27017'
export const DB_NAME = process.env.MONGODB_DB ?? 'backend_doc_example'

/**
 * ONE MongoClient for the whole process, created at module load and reused.
 *
 * The driver keeps its own connection pool and its own topology monitor behind
 * this object. Creating a client per request (or per route) means a new pool and
 * a new server-discovery cycle each time — it is the single most common way to
 * make a Mongo-backed service slow.
 */
/** The one-liner every "database unreachable" message points at. */
export const DOCKER_RUN = 'docker run --rm -p 27017:27017 mongo:8'

export const client = new MongoClient(MONGODB_URL, {
  // Fail fast when nothing is listening instead of retrying for 30s (the default).
  // Every operation waits on server selection, so this number *is* the worst-case
  // latency of every route when Mongo is down. Leave it at 30s and a single
  // outage turns into 30s of hung requests holding sockets open.
  serverSelectionTimeoutMS: Number(process.env.MONGO_SERVER_SELECTION_MS ?? 3_000),
  // Cap the TCP/TLS handshake too — server selection can succeed against a host
  // that then never finishes connecting (a black-holing firewall, for example).
  connectTimeoutMS: Number(process.env.MONGO_CONNECT_TIMEOUT_MS ?? 3_000),
  // Bound how long a single operation may wait for a socket.
  socketTimeoutMS: 20_000,
  maxPoolSize: Number(process.env.MONGO_POOL_MAX ?? 10),
  minPoolSize: 0,
  appName: 'db-mongodb-example',
})

export const db = client.db(DB_NAME)
export const users = db.collection('users')
export const posts = db.collection('posts')

/**
 * Indexes at boot. createIndex is idempotent — calling it every start is the
 * normal pattern for small schemas, and it is the only thing standing between a
 * `unique: true` claim and duplicate rows.
 */
export async function ensureIndexes() {
  await users.createIndex({ email: 1 }, { unique: true, name: 'users_email_unique' })
  await posts.createIndex({ userId: 1, createdAt: -1 }, { name: 'posts_user_created' })
}

/** Cheap liveness probe; `ping` never touches a collection. */
export async function ping() {
  const result = await db.command({ ping: 1 })
  return result.ok === 1
}

/**
 * Is this error "the database is not reachable" rather than "your query was wrong"?
 *
 * The driver has several names for it and you need all of them, or the ones you
 * miss surface as a 500 with a stack trace:
 *
 *   MongoServerSelectionError  nothing answered within serverSelectionTimeoutMS
 *   MongoNetworkError / …TimeoutError  the socket died mid-operation
 *   MongoTopologyClosedError   the client gave up and closed itself — this is what
 *                              you get for every operation after a failed initial
 *                              connect, so it is the common case, not an edge case
 *   MongoNotConnectedError     an operation raced the initial connect
 */
const UNAVAILABLE_ERRORS = new Set([
  'MongoServerSelectionError',
  'MongoNetworkError',
  'MongoNetworkTimeoutError',
  'MongoTopologyClosedError',
  'MongoNotConnectedError',
])

export function isDatabaseUnavailable(err) {
  if (!err) return false
  if (UNAVAILABLE_ERRORS.has(err.name)) return true
  if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND' || err.code === 'ETIMEDOUT') return true
  // MongoServerSelectionError wraps the per-host failures in `err.errors`.
  return err.errors instanceof Map && [...err.errors.values()].some(isDatabaseUnavailable)
}

/** The 503 body: say what is wrong and exactly how to fix it. */
export function unavailableBody(err) {
  return {
    error: 'database unreachable',
    database: 'mongodb',
    url: MONGODB_URL,
    detail: err?.message?.split('\n')[0] ?? String(err),
    hint: `start MongoDB with: ${DOCKER_RUN}`,
  }
}

export function connectionHelp(err) {
  const detail =
    err.message ||
    (Array.isArray(err.errors) ? err.errors.map((e) => e.message).join('; ') : '') ||
    String(err)

  return [
    '',
    '  Cannot reach MongoDB.',
    '',
    `    MONGODB_URL : ${MONGODB_URL}`,
    `    database    : ${DB_NAME}`,
    `    error       : ${err.name ? `${err.name} — ` : ''}${detail.split('\n')[0]}`,
    '',
    '  Start one with Docker:',
    '',
    `    ${DOCKER_RUN}`,
    '',
    '  Then re-run, optionally pointing somewhere else:',
    '',
    '    MONGODB_URL=mongodb://localhost:27017 npm start',
    '',
  ].join('\n')
}
