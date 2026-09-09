import pg from 'pg'

const { Pool } = pg

export const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/postgres'

/**
 * One Pool for the whole process. Creating a Pool per request is the classic
 * node-postgres mistake: you get a new TCP connection and a new Postgres backend
 * process for every call, and you exhaust `max_connections` under trivial load.
 */
export const pool = new Pool({
  connectionString: DATABASE_URL,

  // Cap concurrent server-side connections. Postgres' own default max_connections
  // is 100 *for the whole cluster*, so keep this well below it per app instance.
  max: Number(process.env.PG_POOL_MAX ?? 10),

  // Give up acquiring a connection rather than queueing forever. Without this a
  // dead database turns into requests that hang until the client times out.
  connectionTimeoutMillis: 3_000,

  // Return idle connections to the OS so a restarted database does not leave the
  // pool holding dead sockets.
  idleTimeoutMillis: 30_000,

  // Server-side cap on how long any single statement may run, applied to every
  // connection this pool opens. A runaway query is cancelled by Postgres itself,
  // which is the only kind of timeout that actually frees the backend.
  statement_timeout: Number(process.env.PG_STATEMENT_TIMEOUT_MS ?? 5_000),

  // Belt and braces: kill a session that holds a transaction open doing nothing.
  idle_in_transaction_session_timeout: 10_000,

  application_name: 'db-postgres-pg-example',
})

/**
 * A pool emits 'error' when an *idle* connection dies (database restarted,
 * network dropped, an admin ran pg_terminate_backend). Without this listener the
 * event is unhandled and Node kills the process.
 */
pool.on('error', (err) => {
  console.error('[pg] idle client error:', err.message)
})

/**
 * Run `fn` inside a single transaction on a single connection.
 *
 * Two things make this correct and are easy to get wrong:
 *   1. Every statement must use the SAME client. `pool.query()` inside a
 *      transaction grabs a *different* connection, so it runs outside your
 *      BEGIN and is not rolled back.
 *   2. `client.release()` must be in a `finally`. Miss it once on an error path
 *      and the pool leaks a connection; do it `max` times and the app deadlocks.
 */
export async function withTransaction(fn) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    try {
      await client.query('ROLLBACK')
    } catch (rollbackErr) {
      // The connection is already broken; log and move on so the original error wins.
      console.error('[pg] rollback failed:', rollbackErr.message)
    }
    throw err
  } finally {
    client.release()
  }
}

/** Cheap liveness probe. `SELECT 1` never touches a table or a lock. */
export async function ping() {
  const { rows } = await pool.query('SELECT 1 AS ok')
  return rows[0].ok === 1
}

/**
 * The message a developer actually needs when the database is not there:
 * what failed, what the app tried to reach, and the exact command to fix it.
 */
export function connectionHelp(err) {
  // A failed TCP connect on a dual-stack host arrives as an AggregateError whose
  // own `message` is empty — the useful text is on `err.errors`.
  const detail =
    err.message ||
    (Array.isArray(err.errors) ? err.errors.map((e) => e.message).join('; ') : '') ||
    String(err)

  return [
    '',
    '  Cannot reach PostgreSQL.',
    '',
    `    DATABASE_URL : ${DATABASE_URL}`,
    `    error        : ${err.code ? `${err.code} — ` : ''}${detail}`,
    '',
    '  Start one with Docker:',
    '',
    '    docker run --rm -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:17',
    '',
    '  Then re-run, optionally pointing at a different server:',
    '',
    '    DATABASE_URL=postgres://user:pass@host:5432/dbname npm start',
    '',
  ].join('\n')
}
