---
title: Indexing basics
description: B-tree fundamentals, composite column order and the leftmost-prefix rule, covering and partial indexes, reading EXPLAIN ANALYZE, write cost, and finding unused and missing indexes.
status: current
updated: 2026-09-08
---

An index is a sorted, redundant copy of some of your columns that lets the database find rows without reading the whole table. Almost every "the database is slow" problem is a missing index, a badly ordered composite index, or an index that is never used but is paid for on every write.

## How a B-tree works

The default index type in PostgreSQL, MySQL InnoDB and SQLite is a B-tree: a balanced tree whose leaves hold the indexed values in sorted order, each pointing at a row.

Two properties follow from "sorted", and they explain almost everything else on this page.

**Lookup is logarithmic.** Finding a value in a table of 10 million rows takes about 3–4 page reads instead of scanning 10 million rows. Doubling the table adds one level.

**Range and order come free.** Because the leaves are in sorted order, a B-tree answers `=`, `<`, `>`, `BETWEEN`, `IN`, prefix `LIKE 'abc%'`, `ORDER BY` and `MIN`/`MAX` — all from the same structure.

What a B-tree **cannot** do:

| Query | Usable? | Why |
| --- | --- | --- |
| `WHERE email = $1` | Yes | Direct lookup |
| `WHERE created_at > $1` | Yes | Range on sorted leaves |
| `WHERE name LIKE 'ab%'` | Yes | A prefix is a range |
| `WHERE name LIKE '%ab%'` | **No** | No known starting point |
| `WHERE lower(email) = $1` | **No** | The index holds `email`, not `lower(email)` |
| `WHERE created_at::date = $1` | **No** | Same — the column is wrapped in a function |
| `WHERE tags @> $1` (JSONB, array) | No — use GIN | Containment is not ordering |

The last three are the common trap: **wrapping the indexed column in a function or a cast disables the index.** The fixes are an expression index or rewriting the predicate as a range.

```sql
-- Option A: index the expression you actually query
CREATE INDEX users_lower_email_idx ON users (lower(email));
```

```sql
-- Option B: rewrite the predicate so the bare column is compared
SELECT id FROM orders WHERE created_at >= $1 AND created_at < $2;
```

Option B is usually better — it keeps one index serving both point and range queries.

Other index types exist for what B-trees cannot do: **GIN** for JSONB containment, arrays and full-text search; **GiST** for geometry and ranges; **BRIN** for very large, naturally-ordered tables such as append-only logs. Start with B-tree and reach for the others when `EXPLAIN` says you need to.

## Composite indexes and the leftmost prefix

A composite index sorts by the first column, then by the second within equal firsts, and so on — like sorting a phone book by last name, then first name.

```sql
CREATE INDEX orders_user_created_idx ON orders (user_id, created_at DESC);
```

**The leftmost-prefix rule:** an index on `(a, b, c)` can serve queries that constrain a leading prefix of those columns — `a`; `a, b`; `a, b, c` — and nothing else.

| Query | Uses `(user_id, created_at)`? |
| --- | --- |
| `WHERE user_id = $1` | Yes |
| `WHERE user_id = $1 AND created_at > $2` | Yes, fully |
| `WHERE user_id = $1 ORDER BY created_at DESC` | Yes — and no sort step is needed |
| `WHERE created_at > $1` | **No** — `created_at` is not a leading prefix |
| `WHERE created_at > $1 AND user_id = $2` | Yes — clause order in the SQL is irrelevant |

The phone book analogy makes the failure obvious: sorted by last name then first, you can find every "Smith", and every "Smith, John". You cannot find every "John" without reading the whole book.

Note the second-to-last row. A separate index on `(created_at)` is needed for queries that filter only on time.

### Ordering the columns

Two rules, applied in order:

**1. Equality columns first, then the range or sort column.** Once the index hits a range, the columns after it are no longer usefully sorted.

```sql
-- Query: WHERE tenant_id = $1 AND status = $2 AND created_at > $3 ORDER BY created_at DESC
CREATE INDEX orders_tenant_status_created_idx ON orders (tenant_id, status, created_at DESC);
```

With `created_at` first, the database would scan every row in the time range and filter by tenant. With it last, it seeks directly to the (tenant, status) group and walks a contiguous, already-sorted range — which also eliminates the sort.

**2. Among equality columns, most selective first** — usually. This matters less than people think, because once you are matching on equality the tree descends through all of them anyway. Ordering for the *sort* is the bigger win.

Match the `DESC`/`ASC` direction to your `ORDER BY` when you mix directions. `ORDER BY a ASC, b DESC` can use an index on `(a ASC, b DESC)` without a sort step; an index on `(a, b)` (both ascending) cannot.

:::best-practice One composite index often replaces three single-column ones
`(tenant_id, status, created_at)` serves `tenant_id`, `tenant_id + status`, and all three. Three separate single-column indexes serve none of those combinations well and cost three times as much on every write.
:::

## Covering indexes and index-only scans

Normally the database uses the index to find row locations, then reads the table to fetch the other columns. If **every column the query needs is in the index**, it can skip the table entirely — an *index-only scan*.

```sql
-- Query: SELECT user_id, created_at FROM orders WHERE user_id = $1 ORDER BY created_at DESC
CREATE INDEX orders_user_created_idx ON orders (user_id, created_at DESC);
```

Both selected columns are in the index, so the table is never touched. On a wide table this is often a 5–10x improvement, because you skip a random read per row.

PostgreSQL 11+ adds `INCLUDE` for columns you want *retrievable* but not *searchable* or sorted:

```sql
CREATE INDEX orders_user_created_idx
  ON orders (user_id, created_at DESC)
  INCLUDE (total_cents, status);
```

`INCLUDE` columns are stored only in the leaf pages, so they cost less than extending the key and they do not affect the sort order.

:::warning An index-only scan in Postgres needs a recent VACUUM
PostgreSQL still has to confirm each row is visible to your transaction. It can skip that check only for pages marked all-visible in the visibility map, which `VACUUM` maintains. On a heavily updated table that has not been vacuumed recently, an "index-only scan" still reads the table — `EXPLAIN (ANALYZE, BUFFERS)` shows this as a non-zero `Heap Fetches`.
:::

Do not include half the table. Every added column makes the index bigger, so fewer entries fit per page and every read touches more pages. Cover the two or three columns a hot query needs, not everything.

## Low-cardinality columns

An index on a column with few distinct values is usually useless.

Consider `orders.status` with values `pending`, `paid`, `shipped`, `cancelled`, where 92% of rows are `shipped`. For `WHERE status = 'shipped'`, using the index means reading 92% of the index *and then* doing a random read into the table for each match. A sequential scan reading the table in physical order is faster, and the planner will correctly choose it — leaving you with an index that is never used and is maintained on every write.

The threshold is roughly **5–10% selectivity**: if the predicate matches more than that fraction of the table, a scan usually wins.

A boolean `is_deleted` column where 99% are `false` is the canonical example of a wasted index.

There are three cases where a low-cardinality column still earns its place:

**1. As a leading column of a composite index**, where it partitions the data before the selective column:

```sql
CREATE INDEX orders_status_created_idx ON orders (status, created_at DESC);
```

**2. When you query only the rare value.** `pending` might be 0.1% of rows — highly selective — even though `shipped` is not. A **partial index** targets exactly that:

```sql
CREATE INDEX orders_pending_idx ON orders (created_at) WHERE status = 'pending';
```

This index contains only pending orders. On a table of 40 million orders with 30,000 pending, it is a few hundred kilobytes instead of gigabytes, it stays in cache, and it is only updated when a row enters or leaves the `pending` state.

Partial indexes are excellent for:

```sql
-- Soft deletes: only index live rows
CREATE INDEX users_email_active_idx ON users (email) WHERE deleted_at IS NULL;

-- Uniqueness that applies conditionally
CREATE UNIQUE INDEX users_email_active_uniq ON users (lower(email)) WHERE deleted_at IS NULL;

-- A work queue
CREATE INDEX jobs_ready_idx ON jobs (run_at) WHERE status = 'pending';
```

The query's `WHERE` clause must contain the index's predicate for the planner to use it. `WHERE status = 'pending' ORDER BY created_at` uses `orders_pending_idx`; `WHERE status = $1` cannot, because the planner does not know the parameter's value at planning time.

**3. As a covering column,** where its presence enables an index-only scan.

MySQL note: InnoDB has no partial indexes and no expression indexes. Use a generated column plus a normal index on it.

## Reading EXPLAIN ANALYZE

`EXPLAIN` shows the plan. `EXPLAIN ANALYZE` **runs the query** and shows the plan with real timings and row counts. Always use `ANALYZE`, and add `BUFFERS`.

:::warning
`EXPLAIN ANALYZE` executes the statement. On an `UPDATE` or `DELETE`, wrap it in a transaction and roll back.
:::

Start with a slow query on an `orders` table of 4.2 million rows with no suitable index:

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, total_cents, created_at
  FROM orders
 WHERE user_id = 90210 AND status = 'paid'
 ORDER BY created_at DESC
 LIMIT 20;
```

```text
 Limit  (cost=189422.31..189424.64 rows=20 width=24)
        (actual time=812.447..812.455 rows=20 loops=1)
   Buffers: shared hit=1204 read=52318
   ->  Sort  (cost=189422.31..189429.02 rows=2684 width=24)
             (actual time=812.445..812.449 rows=20 loops=1)
         Sort Key: created_at DESC
         Sort Method: top-N heapsort  Memory: 27kB
         ->  Seq Scan on orders  (cost=0.00..189350.00 rows=2684 width=24)
                                 (actual time=0.089..811.203 rows=2711 loops=1)
               Filter: ((user_id = 90210) AND (status = 'paid'::text))
               Rows Removed by Filter: 4197289
 Planning Time: 0.142 ms
 Execution Time: 812.501 ms
```

Read it inside-out — the most indented node runs first:

- **`Seq Scan on orders`** — every row was read. This is the problem.
- **`Rows Removed by Filter: 4197289`** — 4.2 million rows read and thrown away to keep 2,711. The clearest possible signal of a missing index.
- **`read=52318`** — 52,318 8 KB pages read from disk, about 409 MB, per execution.
- **`Sort`** — the results had to be sorted afterwards, because nothing produced them in order.
- **`actual time=812`** vs **`cost=189350`** — cost is the planner's arbitrary unit for comparing plans; `actual time` is milliseconds. Compare cost between plans, never against a clock.
- **`rows=2684` (estimated) vs `rows=2711` (actual)** — a good estimate. A large divergence here means stale statistics; run `ANALYZE orders`.

Add the index:

```sql
CREATE INDEX CONCURRENTLY orders_user_status_created_idx
  ON orders (user_id, status, created_at DESC);
```

```text
 Limit  (cost=0.56..8.94 rows=20 width=24)
        (actual time=0.031..0.048 rows=20 loops=1)
   Buffers: shared hit=23
   ->  Index Scan using orders_user_status_created_idx on orders
         (cost=0.56..1124.18 rows=2684 width=24)
         (actual time=0.029..0.043 rows=20 loops=1)
         Index Cond: ((user_id = 90210) AND (status = 'paid'::text))
 Planning Time: 0.198 ms
 Execution Time: 0.071 ms
```

**812 ms to 0.071 ms — roughly 11,000x.** Note what changed:

- `Seq Scan` became `Index Scan`, with both predicates as `Index Cond` (matched by the index) rather than `Filter` (checked after fetching).
- **The `Sort` node is gone.** The index already stores `created_at DESC` within each `(user_id, status)` group, so the rows arrive ordered — and `LIMIT 20` stops after 20. Without the index, all 2,711 matching rows had to be sorted before the limit could apply.
- `Buffers` went from 53,522 pages to 23.

### The node types you need to recognize

| Node | Means |
| --- | --- |
| `Seq Scan` | Full table read. Fine on a small table, a red flag on a large one. |
| `Index Scan` | Index lookup, then a table fetch per row. |
| `Index Only Scan` | Answered entirely from the index. Check `Heap Fetches`. |
| `Bitmap Heap Scan` | Many index matches collected, then the table read in physical order. Normal for medium selectivity. |
| `Nested Loop` | For each outer row, probe the inner. Great when the outer side is small. |
| `Hash Join` | Build a hash of one side. Good for large, unsorted joins. |
| `Merge Join` | Both inputs sorted. Good when indexes already provide the order. |
| `Sort` with `Sort Method: external merge  Disk: …` | The sort spilled to disk. Raise `work_mem`, or index for the order. |

Three numbers to check every time: `Rows Removed by Filter` (missing index), estimated vs actual rows (stale statistics), and `loops=` on an inner node (`actual time` there is **per loop** — multiply by `loops` for the total; a high loop count is often an N+1 expressed as a join). See [N+1 queries](n-plus-one-queries.md).

MySQL's equivalent is `EXPLAIN ANALYZE` (8.0.18+) or `EXPLAIN FORMAT=JSON`; look for `type: ALL` (a full scan) and a missing `key`. SQLite has `EXPLAIN QUERY PLAN`; look for `SCAN table` versus `SEARCH table USING INDEX`.

## Indexes cost writes

An index is a second copy of the data that must be kept correct. Every `INSERT` writes to the table and to **every** index. Every `DELETE` does the same. An `UPDATE` touches every index whose columns changed.

Concretely: a table with six indexes turns one insert into seven write operations, seven sets of page updates, and seven times the write-ahead log. On a write-heavy table each additional index is a measurable throughput cost — commonly 5–15% per index for inserts.

There is a subtler PostgreSQL cost. Postgres can use a **HOT update** (heap-only tuple) that skips index maintenance entirely — but only when no indexed column changed *and* the new row version fits on the same page. Adding an index on a frequently updated column disables HOT for those updates, which increases index bloat and vacuum work well beyond the direct write cost.

The practical consequences:

- **Index for the queries you actually run**, not for every column someone might filter on.
- **A composite index often replaces several single-column ones.** Fewer indexes, better coverage.
- **Drop redundant indexes.** An index on `(user_id)` is redundant when `(user_id, created_at)` exists — the second serves everything the first does.
- **Bulk loads: drop, load, recreate.** Building an index once over sorted data is far faster than maintaining it row by row.
- **Indexes consume cache.** They compete with table data for shared buffers, so an unused index makes everything else slower by evicting useful pages.

## Finding unused and missing indexes

PostgreSQL tracks index usage. Ask it.

```sql title="unused indexes"
SELECT s.relname        AS table_name,
       s.indexrelname   AS index_name,
       s.idx_scan       AS times_used,
       pg_size_pretty(pg_relation_size(s.indexrelid)) AS size
  FROM pg_stat_user_indexes s
  JOIN pg_index i ON i.indexrelid = s.indexrelid
 WHERE s.idx_scan = 0
   AND NOT i.indisunique          -- unique indexes enforce constraints; keep them
   AND NOT i.indisprimary
 ORDER BY pg_relation_size(s.indexrelid) DESC;
```

`idx_scan = 0` means the index has never been used since statistics were last reset. Before dropping anything:

- **Check how long the counters have been accumulating.** `pg_stat_reset()` and a failover both zero them. An index unused for two hours proves nothing; unused across a full month, including month-end reporting, is evidence.
- **Check every replica.** Read replicas serve different queries and have their own counters. An index unused on the primary may be the one holding up your analytics.
- **Never drop a unique index** — it is enforcing a constraint even if no query reads it.
- **Drop with `DROP INDEX CONCURRENTLY`**, and be ready to recreate it.

```sql title="tables taking the most sequential scans"
SELECT relname,
       seq_scan,
       seq_tup_read,
       idx_scan,
       seq_tup_read / GREATEST(seq_scan, 1) AS avg_rows_per_seq_scan
  FROM pg_stat_user_tables
 WHERE seq_scan > 0
 ORDER BY seq_tup_read DESC
 LIMIT 20;
```

A large table with high `seq_scan` and low `idx_scan` is where a missing index lives. Small tables scanning frequently are fine — a sequential scan of 50 rows is faster than an index lookup.

Combine that with `pg_stat_statements` ordered by `total_exec_time` to find *which* query is doing the scanning, then `EXPLAIN ANALYZE` it.

MySQL exposes the same information through `sys.schema_unused_indexes` and `performance_schema.table_io_waits_summary_by_index_usage`.

## Index your foreign keys

**PostgreSQL does not create an index on the referencing column of a foreign key.** MySQL InnoDB does, automatically. This difference catches almost everyone.

Given:

```sql
CREATE TABLE orders (
  id      bigserial PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users (id)
);
```

Postgres indexes `orders.id` (the primary key) and `users.id`, but **not** `orders.user_id`. Three consequences:

**1. `DELETE FROM users WHERE id = $1` is slow.** Postgres must verify no order references that user, and with no index that is a sequential scan of `orders` **per deleted row**. Deleting 100 users from a 4-million-row `orders` table is 400 million rows examined.

**2. It takes a lock while doing it.** The referential integrity check locks rows in the referencing table. A slow cascade delete blocks writers on `orders` for its whole duration, which turns a routine cleanup into an incident.

**3. Every join in that direction is slow.** `WHERE user_id = $1` — the most obvious query on the table — has no index.

So: **index every foreign key column in PostgreSQL**, unless you have measured that you never delete parents and never join in that direction.

```sql
CREATE INDEX CONCURRENTLY orders_user_id_idx ON orders (user_id);
```

Usually you want a composite that also serves your ordering, and it satisfies the foreign key too, because `user_id` is its leftmost prefix:

```sql
CREATE INDEX CONCURRENTLY orders_user_created_idx ON orders (user_id, created_at DESC);
```

Find the unindexed ones:

```sql title="foreign keys with no supporting index"
SELECT c.conrelid::regclass AS table_name, c.conname AS constraint_name
  FROM pg_constraint c
 WHERE c.contype = 'f'
   AND NOT EXISTS (
         SELECT 1 FROM pg_index i
          WHERE i.indrelid = c.conrelid
            AND (i.indkey::smallint[])[0:array_length(c.conkey, 1) - 1] @> c.conkey
       );
```

## Security considerations

**A missing index is a denial-of-service vector.** An endpoint whose query scans a large table occupies a connection for the whole scan. A handful of concurrent requests exhausts the pool and takes the service down — no authentication and no exploit required, just a URL. Pair indexing with `statement_timeout`; see [Retries and timeouts](retries-and-timeouts.md).

**Unique indexes are a security control, not just a performance one.** Only a unique index atomically prevents two concurrent signups from claiming the same email. An application-level "check then insert" is a race, and duplicate accounts on the same identity break password reset, account recovery and audit trails.

```sql
CREATE UNIQUE INDEX users_email_uniq ON users (lower(email));
```

Index `lower(email)` so `Alice@example.com` cannot register alongside `alice@example.com` — a real account-takeover setup.

**Index the tenant column first in multi-tenant schemas.** `(tenant_id, …)` makes the tenant filter cheap, which means developers keep it in the query. When the filtered query is slow, someone eventually "optimizes" it by removing the filter. It also means a query that forgets the tenant is dramatically slower, which is a weak but real detection signal.

**Timing differences leak existence.** An indexed lookup that returns immediately for a missing row and slowly for an existing one is a user-enumeration oracle. This matters most on login and password-reset endpoints, where the fix is to make the response time and body identical either way — never to remove the index. See [Authentication and session security](../security/authentication-and-session-security.md).

**`EXPLAIN` output is internal information.** Plans expose table names, column names, row counts and index names. Never return them to clients, even in a debug mode gated by a query parameter.

**Do not index a secret you did not need to search.** An index on `password_hash` or `reset_token` creates a second copy of that data on disk with its own retention in backups and its own bloat. Index a hash of the token if you must look it up, and keep the index partial to unexpired rows.

**Building an index in production is an availability decision.** A plain `CREATE INDEX` blocks writes for the whole build. Use `CONCURRENTLY` — see [Migrations](migrations.md).

## Production considerations

- **Build indexes with `CREATE INDEX CONCURRENTLY`** and in their own migration. Check afterwards for invalid indexes left by a failed build.
- **Keep statistics fresh.** The planner chooses using row estimates; stale statistics produce bad plans. Autovacuum handles this, but run `ANALYZE` explicitly after a bulk load or a large backfill.
- **Raise the statistics target for skewed columns.** `ALTER TABLE orders ALTER COLUMN status SET STATISTICS 1000;` gives the planner a finer histogram where the default 100 buckets are misleading.
- **Test with production-scale data.** Every plan is right on 1,000 rows. The planner switches strategies as the table grows, so an index decision validated on a development database means nothing.
- **Measure index size.** `pg_size_pretty(pg_relation_size(...))`. Indexes routinely exceed the table itself; that is memory not spent caching data.
- **Watch for bloat.** Heavily updated indexes accumulate dead entries. `REINDEX INDEX CONCURRENTLY` rebuilds without blocking.
- **Review `pg_stat_user_indexes` quarterly** and drop what is genuinely unused — after checking every replica and the age of the counters.
- **Index foreign keys in PostgreSQL.** It is not done for you.
- **One index at a time, measured.** Adding five indexes to fix one slow query leaves four you cannot justify and cannot safely remove.
- **`EXPLAIN ANALYZE` after every index change**, and confirm the plan changed the way you expected. The planner may still prefer a scan, and then you have paid for nothing.
- **Alert on sequential scans of large tables.** A rising `seq_scan` on a growing table is a missing index that has not caused an incident yet.

## Common mistakes

- **Wrapping the indexed column in a function.** `WHERE lower(email) = $1` cannot use an index on `email`. Index the expression, or rewrite the predicate.
- **`WHERE created_at::date = $1`.** The cast disables the index; use a half-open range instead.
- **Leading wildcard `LIKE '%term%'`.** No B-tree can serve it. Use full-text search or a trigram index.
- **Wrong composite column order.** `(created_at, user_id)` when you filter by user and sort by time. The index exists and is never used.
- **Expecting `(a, b)` to serve a query on `b` alone.** The leftmost-prefix rule.
- **Indexing every column individually.** Maximum write cost, minimum coverage of real queries.
- **Redundant indexes.** `(user_id)` alongside `(user_id, created_at)` — the first is dead weight.
- **Indexing a low-cardinality column** for its common value. Use a partial index for the rare one.
- **A partial index whose predicate is not in the query.** The planner cannot use it.
- **Forgetting to index foreign keys in Postgres.** Slow cascading deletes that hold locks.
- **Dropping an "unused" index after two hours of statistics.** Or dropping a unique index that enforces a constraint.
- **`CREATE INDEX` without `CONCURRENTLY`** on a live table. Writes blocked for the whole build.
- **Reading `cost` as milliseconds.** It is an arbitrary unit for comparing plans.
- **Ignoring `loops=` in `EXPLAIN ANALYZE`.** Inner-node times are per loop.
- **Testing plans on a small database.** The planner behaves differently at scale.
- **Adding an index instead of fixing an N+1.** The query was already fast; there were 500 of them. See [N+1 queries](n-plus-one-queries.md).

## Related topics

- [N+1 queries](n-plus-one-queries.md) — the other half of most slow endpoints.
- [Migrations](migrations.md) — `CREATE INDEX CONCURRENTLY` and lock timeouts.
- [PostgreSQL with pg](postgresql-with-pg.md) — JSONB and GIN indexes, and query patterns.
- [MySQL with mysql2](mysql-with-mysql2.md) — InnoDB's automatic foreign-key indexes.
- [SQLite](sqlite.md) — `EXPLAIN QUERY PLAN` and `ANALYZE`.
- [MongoDB](mongodb.md) — `createIndex`, compound indexes and the same prefix rule.
- [Connection pooling](connection-pooling.md) — why an unindexed query exhausts the pool.
- [Retries and timeouts](retries-and-timeouts.md) — `statement_timeout` as the backstop.
- [Performance](../production/performance.md) — measuring before and after.
- [Observability](../production/observability.md) — spotting slow queries in production.
