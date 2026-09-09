/**
 * Connection handling and the friendly failure message.
 *
 * Mongoose keeps ONE connection pool per `mongoose.connect()` call, on the
 * default connection. Calling it again with a different URL does not open a
 * second one — it throws. So it is called once, from server.js.
 */
import mongoose from 'mongoose'

export const MONGODB_URL = process.env.MONGODB_URL ?? 'mongodb://127.0.0.1:27017'
export const DB_NAME = process.env.MONGODB_DB ?? 'orm_mongoose_example'

/**
 * `sanitizeFilter` is set globally here rather than per query.
 *
 * It wraps any filter value that is a plain object containing `$` keys in
 * `{ $eq: value }`, so a body of `{"email":{"$ne":null}}` becomes a search for a
 * document whose email literally equals that object — which matches nothing —
 * instead of an operator the client chose. It is the belt to the braces of
 * validating request bodies into primitives, which app.js also does.
 *
 * It does NOT protect `$where`, aggregation pipelines you build from user input,
 * or `Model.find(req.query)` where the *keys* come from the client.
 */
mongoose.set('sanitizeFilter', true)

// Fail fast instead of buffering queries while the connection is down. Without
// this, a query issued before/after a disconnect sits in a queue and the caller
// sees a 10s hang rather than an error.
mongoose.set('bufferCommands', false)

// `autoCreate` makes Mongoose issue `createCollection` when a model initialises.
// It is off here for two reasons: MongoDB creates a collection implicitly on the
// first insert anyway, and in mongoose 9.9.5 the autoCreate path throws
// `TypeError: Cannot read properties of undefined (reading 'createCollection')`
// when `bufferCommands` is false and the models were compiled before the
// connection opened. `createIndexes()` below does the part that actually matters.
mongoose.set('autoCreate', false)

export async function connect() {
  await mongoose.connect(MONGODB_URL, {
    dbName: DB_NAME,
    // 3s beats the 30s default when the answer is "there is no server".
    serverSelectionTimeoutMS: Number(process.env.MONGO_SERVER_SELECTION_MS ?? 3_000),
    connectTimeoutMS: 5_000,
    socketTimeoutMS: 20_000,
    maxPoolSize: Number(process.env.MONGO_POOL_MAX ?? 10),
    appName: 'orm-mongoose-example',
  })
  // Index builds are asynchronous. Awaiting them means the `unique` index really
  // exists before the first request relies on it — `unique: true` in a schema is
  // an index request, not a validator, so until this resolves nothing is
  // stopping a duplicate.
  await Promise.all([
    mongoose.model('User').createIndexes(),
    mongoose.model('Post').createIndexes(),
  ])
}

export async function ping() {
  const result = await mongoose.connection.db.command({ ping: 1 })
  return result.ok === 1
}

export async function close() {
  await mongoose.connection.close()
}

/** True when the deployment supports multi-document transactions. */
export async function supportsTransactions() {
  try {
    const info = await mongoose.connection.db.admin().command({ hello: 1 })
    return Boolean(info.setName || info.msg === 'isdbgrid')
  } catch {
    return false
  }
}

/**
 * A readable failure, not a stack trace. A stack trace tells a reader that
 * something threw; this tells them what to run.
 */
export function connectionHelp(err) {
  const detail =
    err?.message ||
    (Array.isArray(err?.errors) ? err.errors.map((e) => e.message).join('; ') : '') ||
    String(err)

  return [
    '',
    '  Cannot reach MongoDB — orm-mongoose needs a running server.',
    '',
    `    MONGODB_URL : ${MONGODB_URL}`,
    `    database    : ${DB_NAME}`,
    `    error       : ${err?.name ? `${err.name} — ` : ''}${detail.split('\n')[0]}`,
    '',
    '  Start one with Docker:',
    '',
    '    docker run --rm -p 27017:27017 mongo:8',
    '',
    '  For POST /users-with-posts (a multi-document transaction) MongoDB has to',
    '  be a replica set, which a standalone server is not:',
    '',
    '    docker run --rm -p 27017:27017 mongo:8 --replSet rs0',
    '    docker exec -it $(docker ps -qf ancestor=mongo:8) mongosh --eval "rs.initiate()"',
    '',
    '  Then re-run, optionally pointing somewhere else:',
    '',
    '    MONGODB_URL=mongodb://127.0.0.1:27017 npm start',
    '',
    '  Or keep the process up with /health reporting "degraded":',
    '',
    '    DEGRADED_OK=1 npm start',
    '',
  ].join('\n')
}
