import mysql from 'mysql2/promise'

export const MYSQL_URL = process.env.MYSQL_URL ?? 'mysql://root:mysql@localhost:3306/appdb'

/**
 * One pool for the process. `createPool` is lazy: it does not open a socket here,
 * so nothing throws until the first query. That is why the server probes
 * explicitly at boot instead of relying on construction to fail.
 */
export const pool = mysql.createPool({
  uri: MYSQL_URL,

  // Hard cap on concurrent connections from this process. MySQL's own
  // max_connections defaults to 151 for the whole server.
  connectionLimit: Number(process.env.MYSQL_POOL_MAX ?? 10),

  // Queue callers when every connection is busy rather than erroring instantly…
  waitForConnections: true,
  // …but bound the queue. 0 means unlimited, which turns a slow database into
  // unbounded memory growth.
  queueLimit: 50,

  // Fail an acquire instead of hanging forever.
  connectTimeout: 5_000,

  // EXPLICITLY off. With multipleStatements: true a single injected `;` turns any
  // query into two, which is the difference between a leaked row and a dropped
  // table. It is off by default in mysql2 — say so out loud so nobody "fixes" it.
  multipleStatements: false,

  // Return DECIMAL/BIGINT as strings rather than lossy Numbers where needed.
  decimalNumbers: false,
  // Keep DATETIME as a JS Date in the app's timezone handling of choice.
  timezone: 'Z',

  enableKeepAlive: true,
  keepAliveInitialDelay: 10_000,
})

/**
 * Run `fn` inside one transaction on one connection.
 *
 * `pool.execute()` inside the callback would grab a *different* connection and
 * run outside the transaction — always use the `conn` you are handed.
 * `conn.release()` lives in `finally` so no error path leaks a connection.
 */
export async function withTransaction(fn) {
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const result = await fn(conn)
    await conn.commit()
    return result
  } catch (err) {
    try {
      await conn.rollback()
    } catch (rollbackErr) {
      console.error('[mysql] rollback failed:', rollbackErr.message)
    }
    throw err
  } finally {
    conn.release()
  }
}

export async function ping() {
  const [rows] = await pool.execute('SELECT 1 AS ok')
  return rows[0].ok === 1
}

export function connectionHelp(err) {
  const detail =
    err.message ||
    (Array.isArray(err.errors) ? err.errors.map((e) => e.message).join('; ') : '') ||
    String(err)

  return [
    '',
    '  Cannot reach MySQL.',
    '',
    `    MYSQL_URL : ${MYSQL_URL}`,
    `    error     : ${err.code ? `${err.code} — ` : ''}${detail}`,
    '',
    '  Start one with Docker:',
    '',
    '    docker run --rm -e MYSQL_ROOT_PASSWORD=mysql -e MYSQL_DATABASE=appdb \\',
    '      -p 3306:3306 mysql:9',
    '',
    '  MySQL takes ~20s to initialise on first boot. Then:',
    '',
    '    MYSQL_URL=mysql://root:mysql@localhost:3306/appdb npm start',
    '',
  ].join('\n')
}
