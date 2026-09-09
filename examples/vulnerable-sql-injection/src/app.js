// !!! DELIBERATELY VULNERABLE — DO NOT COPY !!!
// This file is teaching material for the SQL-injection page. Every query below
// is built by string interpolation and is trivially injectable. That is the
// entire point. Never deploy it. The fix is in examples/fixed-sql-injection.

import express from 'express'
import { createDb } from './db.js'

export function createApp(db = createDb()) {
  const app = express()
  app.use(express.json())

  // Not vulnerable — the validator uses it to know the app is up.
  app.get('/health', (req, res) => {
    res.json({ status: 'ok' })
  })

  /**
   * VULNERABILITY 1 — authentication bypass.
   *
   * The username and password are pasted straight into the WHERE clause. A
   * payload that closes the quote and appends `OR '1'='1` makes the condition
   * always true, so the first user (id 1) is returned and "logged in" with no
   * valid credentials at all.
   *
   *   curl -s -X POST localhost:3004/login -H 'content-type: application/json' \
   *     -d '{"username":"x'"'"' OR '"'"'1'"'"'='"'"'1","password":"x'"'"' OR '"'"'1'"'"'='"'"'1"}'
   */
  app.post('/login', (req, res) => {
    const { username = '', password = '' } = req.body ?? {}

    const sql = `SELECT id, username, email, role FROM users WHERE username = '${username}' AND password = '${password}'`
    console.log('[login] running:', sql)

    try {
      const user = db.prepare(sql).get()
      if (!user) {
        res.status(401).json({ ok: false, error: 'invalid credentials' })
        return
      }
      res.json({ ok: true, user, note: 'If you did not supply real credentials, you just bypassed auth.' })
    } catch (err) {
      // Leaking the DB error message is its own vulnerability — it hands the
      // attacker the column names and SQL dialect for free.
      res.status(500).json({ ok: false, error: String(err.message), sql })
    }
  })

  /**
   * VULNERABILITY 2 — data exfiltration through search.
   *
   * A search box that only ever intended to match usernames. Because `q` is
   * interpolated, an attacker can:
   *   - break out of the LIKE with a UNION and read ANY column of ANY table
   *     (including secret_token, and the sqlite_master schema);
   *   - ask true/false questions (boolean-blind) to extract data one character
   *     at a time even when nothing is echoed back.
   *
   *   curl -s 'localhost:3004/users/search?q=zzz%27%20UNION%20SELECT%20username,secret_token%20FROM%20users--'
   */
  app.get('/users/search', (req, res) => {
    const q = String(req.query.q ?? '')

    const sql = `SELECT username, email FROM users WHERE username LIKE '%${q}%'`
    console.log('[search] running:', sql)

    try {
      const rows = db.prepare(sql).all()
      res.json({ ok: true, count: rows.length, rows })
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err.message), sql })
    }
  })

  app.use('/{*splat}', (req, res) => {
    res.status(404).json({ ok: false, error: `Cannot ${req.method} ${req.originalUrl}` })
  })

  return app
}

export default createApp
