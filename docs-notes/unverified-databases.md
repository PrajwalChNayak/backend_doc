# Unverified / omitted — `databases` section

Author: databases section pass, 2026-09-08.

Everything listed here was either **left out** of the published pages because it could not be
verified against official documentation or the registry, or **included with hedged wording**
and needs a second pass. Per CONTRIBUTING §1.4, a confidently wrong option name is worse than
an omission.

---

## 1. Example directories — resolved, but not cross-checked

`content/databases/` links to three runnable examples:

| Link | Referenced from | Present at time of writing |
| --- | --- | --- |
| `examples/db-postgres-pg/README.md` | `postgresql-with-pg.md` | yes |
| `examples/db-mysql2/README.md` | `mysql-with-mysql2.md` | yes |
| `examples/db-sqlite/README.md` | `sqlite.md` | yes |

`examples/` was empty when this pass started and was populated concurrently by another author.
All three paths now resolve. **The example source was not read**, so the prose on these three
pages has not been reconciled against what the examples actually demonstrate — the coordinator
should spot-check that the driver versions, option names and patterns agree.

---

## 2. `redis` (node-redis) 6.2.1 — option shapes not verified

The published version table pins node-redis at 6.2.1. The following API shapes are written as
they are documented for node-redis v4/v5 and were **not verified against 6.2.1 release notes**:

- **`client.set(key, value, { EX: seconds, NX: true })`** — the options-object form. There has
  been churn in this area across node-redis majors (an `expiration: { type, value }` /
  `condition` shape has been discussed upstream). If 6.x changed it, `redis.md` needs updating
  in two places (the `SET` section and the cache-aside example).
  - Mitigation already in the page: the raw command is also shown in a `text` fence
    (`SET key value EX 900 NX`), which is protocol-level and cannot go stale.
  - The `ioredis` positional form (`redis.set(key, value, 'EX', 900, 'NX')`) is stable and was
    used as the cross-check.
- **`client.scanIterator({ MATCH, COUNT })`** — uppercase option keys, async-iterator form.
- **`createClient({ socket: { reconnectStrategy } })`** — v4+ shape.
- **`client.duplicate()`** and **`client.subscribe(channel, listener)`** — v4+ shapes.
- **`client.sendCommand(argsArray)`** — used in the `rate-limit-redis` wiring snippet.

## 3. `ioredis` 6.0.0 — assumed v5-compatible

`retryStrategy`, `maxRetriesPerRequest`, `enableOfflineQueue`, `lazyConnect`, `scanStream` and
the positional `set` arguments are documented for ioredis 5.x and assumed unchanged in 6.0.0.
Not verified against a 6.0.0 changelog.

Also asserted without verification: **BullMQ 6.3.4 requires `maxRetriesPerRequest: null`** on
its Redis connection. This has been true for several BullMQ majors but was not re-checked.

---

## 4. `pg` 8.23.0 — options deliberately omitted

Included and confident: `max`, `idleTimeoutMillis`, `connectionTimeoutMillis`,
`allowExitOnIdle`, `statement_timeout`, `query_timeout`,
`idle_in_transaction_session_timeout`, `application_name`, `ssl`, `rowMode: 'array'`,
`pg.types.setTypeParser`, `pg.types.builtins`, `client.escapeIdentifier`, `client.release(err)`,
`pool.totalCount` / `idleCount` / `waitingCount`.

**Omitted because the version in which they became available could not be pinned:**

- `maxUses` (recycle a pooled connection after N checkouts)
- `maxLifetimeSeconds` (recycle after a wall-clock lifetime)
- `min` (a minimum pool size; historically documented as not honored by `pg-pool`)
- `lock_timeout` as a **client config option**. `migrations.md` uses the SQL form
  (`SET lock_timeout = '3s'`) instead, which is unambiguously correct.

If someone verifies these against the `pg` / `pg-pool` changelogs, `connection-pooling.md` and
`postgresql-with-pg.md` would both benefit from a "recycle connections" note.

---

## 5. `node:sqlite` — omitted surface

Covered: `DatabaseSync`, `db.exec`, `db.prepare`, `StatementSync.get/all/run`,
`{ changes, lastInsertRowid }`, bare and prefixed named parameters, `db.close`.

**Omitted:**

- **`StatementSync.prototype.iterate()`** — exists in recent Node, but the exact version it
  landed unflagged could not be pinned, and the page targets Node 24. `better-sqlite3`'s
  `iterate()` is documented instead, in the `better-sqlite3` section.
- `StatementSync.prototype.setAllowBareNamedParameters()` — mentioned only implicitly (the page
  says both `{ id }` and `{ ':id': … }` bind). The method name itself is not printed.
- `db.backup()` / the online backup API surface in `node:sqlite`. The page recommends the
  `sqlite3 ".backup"` CLI command instead, which is stable.
- Any `node:sqlite` support for user-defined functions, extensions or session/changesets.

CONTRIBUTING §1.1 wording was followed exactly: "22.5 (experimental), 24 (stable enough to
teach)".

---

## 6. `sqlite3` 6.0.1 — deliberately given no code example

CONTRIBUTING §6 says callback-style APIs must sit inside a `:::legacy` callout **and** flip the
page's front matter `status` to `legacy`. `sqlite.md` must stay `status: current`, so
`sqlite3` 6.0.1 is named in a `:::note` in prose only, with no callback code. If the
coordinator wants a callback example, it needs its own page or a rule clarification.

---

## 7. `mysql2` 3.24.4 — values stated from documentation, not re-measured

- `maxPreparedStatements` default **16000** (driver) and MySQL server
  `max_prepared_stmt_count` default **16382**.
- `enableKeepAlive` defaulting to `true` in mysql2 v3.
- `connectionLimit` default 10, `queueLimit` default 0, `connectTimeout` default 10000.
- `??` identifier placeholders work with `query()` but not `execute()`; array expansion for
  `IN (?)` likewise. Documented behavior, not re-tested.
- MySQL 8 `max_connections` default **151**.

**Omitted:** `typeCast`, `rowsAsArray`, `infileStreamFactory`, `stringifyObjects`,
`nestTables`, `flags`, and the connection-attribute options — all real, none needed.

---

## 8. `mongodb` 7.6.0 — defaults carried over from the v6 driver docs

Default values in the options table (`maxPoolSize: 100`, `serverSelectionTimeoutMS: 30000`,
`connectTimeoutMS: 30000`, `socketTimeoutMS: 0`, `maxIdleTimeMS: 0`, `waitQueueTimeoutMS: 0`)
are the documented Node-driver defaults and are **assumed unchanged in 7.6.0**.

Also unverified in detail:

- The claim that replica-set index builds do not block reads and writes "from version 4.2
  onward" — a server-version fact, correct to the best of my knowledge, not re-sourced.
- TTL index sweeper interval of "about once a minute" — documented as approximately 60 seconds.
- `withTransaction`'s automatic retry on transient transaction errors, and the 60-second
  default transaction lifetime.
- `explain('executionStats')` output field names (`executionStages.stage`,
  `totalDocsExamined`, `nReturned`) — stable across recent drivers.

`mongosh`'s `passwordPrompt()` helper is used in the user-creation snippet.

---

## 9. PgBouncer / RDS Proxy claims (hedged in the page)

`connection-pooling.md` states that **PgBouncer 1.21 added protocol-level prepared-statement
tracking via `max_prepared_statements`**, which fixes prepared statements under transaction-mode
pooling. The page hedges this ("verify it against your pooler's version and configuration
before assuming it") because the exact minor version was not re-sourced.

The rest of the transaction-mode breakage list (`LISTEN`/`NOTIFY`, session-level `SET`,
session-scoped advisory locks, `WITH HOLD` cursors, temp tables) is long-standing and confident.

RDS Proxy "pinning" behavior on session state is described qualitatively; no specific metric
name is printed.

---

## 10. Numbers that are illustrative, not measured

These are labeled in-page as illustrative or tied to a stated setup, but they were **not**
produced by running a benchmark for this pass:

- `n-plus-one-queries.md` — the round-trip table (0.15 ms Unix socket, 0.8 ms same-AZ,
  2.5 ms cross-AZ TLS) and the derived 8 ms / 41 ms / 128 ms totals.
- `n-plus-one-queries.md` — the `pg_stat_statements` sample output (482,913 calls etc.).
- `indexing-basics.md` — **the entire `EXPLAIN ANALYZE` walkthrough** (4.2 M rows, 812 ms →
  0.071 ms, the buffer counts and cost figures) is a realistic synthetic plan in genuine
  PostgreSQL output format, not a capture from a live database. The *shape* of the plan and
  every field name are correct; the numbers are constructed. Worth replacing with a real
  capture if a database is available.
- `indexing-basics.md` — "5–15% insert throughput cost per index" and the "5–10% selectivity"
  threshold for index versus scan are rules of thumb, not citations.
- `connection-pooling.md` — the worked sizing example (8 cores → ~18 connections → `max: 3`
  across 6 replicas) follows the stated formula; the formula itself is PostgreSQL's published
  sizing guidance.

## 11. Other cross-section assumptions

- `redis.md` uses `express-rate-limit` with `standardHeaders: 'draft-7'` and
  `store: new RedisStore({ sendCommand })`. `express-rate-limit` 8.7.0 may support a newer
  draft value; the rate-limiting page is owned by another author and should be treated as
  canonical if the two disagree.
- `migrations.md` CI snippet uses `actions/checkout@v5`, `actions/setup-node@v5` and the
  `postgres:18` Docker tag. Action major versions were not verified against the marketplace.
- `seeding.md` uses `argon2` 0.45.1 (`argon2.hash` / `argon2.verify`) per CONTRIBUTING §1.3.
- `health-checks.md` uses `monitorEventLoopDelay` from `node:perf_hooks` — stable, but the
  1000 ms p99 threshold is an arbitrary starting value, not a recommendation from Node.
- The `createLoader` implementation in `n-plus-one-queries.md` is original code written for the
  page, not the `dataloader` package's implementation. The page says so and points at the
  package for production use.

---

## Coordinator resolution — 2026-09-09

Section 2 (`redis` / node-redis 6.2.1 option shapes) is **resolved**. Verified by
unpacking `redis@6.2.1` and `@redis/client@6.2.1` from the registry and reading the
published README and type declarations:

| Claim | Status at 6.2.1 |
| --- | --- |
| `client.set(key, value, { EX: seconds, NX: true })` | **Confirmed** — README: "Modifiers to commands are specified using a JavaScript object", with `{ EX: 10, NX: true }`. |
| `client.scanIterator({ MATCH, COUNT })` | **Confirmed** — README documents `scanIterator({ TYPE, MATCH, COUNT })` and the `hScanIterator` / `sScanIterator` / `zScanIterator` variants. |
| `createClient({ socket: { reconnectStrategy } })` | **Confirmed** — `@redis/client` declares `reconnectStrategy?: false \| number \| ReconnectStrategyFunction` on the socket options. |

Sections 3–5 (ioredis 6.0.0 v5-compatibility, the omitted `pg` pool options, the
omitted `node:sqlite` surface) remain unverified as written. Nothing in the pages
asserts them, so no page needs changing — they are recorded as known gaps.
