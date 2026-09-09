---
title: Choosing a database
description: An honest decision framework for picking Postgres, MySQL, SQLite, MongoDB or Redis for a Node.js backend, and what each one actually costs you.
status: current
updated: 2026-09-08
---

Most backends do not need an exotic database. They need one relational database that is well indexed, correctly pooled, and backed up. This page gives you a default, the conditions under which the default is wrong, and the honest trade-offs of each alternative.

## Why it exists

Database choice is one of the few decisions that is expensive to reverse. Your schema, your query patterns, your transaction boundaries, your migration tooling and your operational runbooks all bind to it. Changing web frameworks is a weekend; changing databases is a quarter.

The second reason is that the popular answer is often the wrong one. "It scales" is not a requirement, and "we might need flexible schemas" is usually a way of saying you have not designed the schema yet.

## The default: PostgreSQL

Unless something on this page tells you otherwise, use PostgreSQL.

It gives you strict typing, real constraints, real transactions with MVCC, `JSONB` for the genuinely unstructured 5% of your data, arrays, full-text search, partial and expression indexes, `ON CONFLICT` upserts, `RETURNING`, window functions, and a query planner you can interrogate with `EXPLAIN ANALYZE`. Every managed provider offers it. Every ORM supports it first.

The important property is not any single feature — it is that Postgres will *refuse* to store data that violates your rules. A `NOT NULL` column and a foreign key are cheap, permanent guarantees. Application-level validation is a guarantee only until the next code path forgets it.

The cost: connection handling is genuinely awkward, because each connection is an operating-system process. That is why [Connection pooling](connection-pooling.md) is its own page and why serverless deployments need PgBouncer or RDS Proxy.

## Comparison

| | PostgreSQL | MySQL 8 (InnoDB) | SQLite | MongoDB | Redis |
| --- | --- | --- | --- | --- | --- |
| Data model | Relational + JSONB | Relational | Relational | Documents | Key/value + data structures |
| Schema enforced by | The database | The database | The database (loosely typed by default) | **Your application code** | Nothing |
| Node driver | `pg` 8.23.0 | `mysql2` 3.24.4 | `node:sqlite` / `better-sqlite3` 13.0.3 | `mongodb` 7.6.0 | `redis` 6.2.1 / `ioredis` 6.0.0 |
| Transactions | Yes, MVCC | Yes, MVCC | Yes, one writer at a time | Yes, but only on a replica set | Single-command atomicity, `MULTI`, Lua |
| Default isolation | Read committed | Repeatable read | Serializable in effect | Snapshot within a transaction | n/a |
| Joins | Yes | Yes | Yes | `$lookup`, limited and slow | No |
| Concurrent writers | Many | Many | **One** | Many | Single-threaded command loop |
| Durable by default | Yes | Yes | Yes (WAL + `synchronous=NORMAL` is safe against process crash) | Yes (`w: majority` recommended) | **No** |
| Horizontal write scaling | Extensions / manual sharding | Manual sharding | No | Built-in sharding | Cluster |
| Operational cost | Medium | Medium | ~Zero | High (replica sets, balancer) | Low |
| Good as a system of record | Yes | Yes | Yes, single node | Yes, with discipline | **No** |

## Start here

Work down this list and stop at the first match.

1. **Is the data mostly ephemeral — cache entries, rate-limit counters, session state, a job queue?**
   - Yes → **Redis**, alongside a real database. Never as the only database.
2. **Does exactly one process write to it, and can it live on one machine's disk?**
   - Yes, and you want zero operational surface → **SQLite** with WAL mode. This is a legitimate production answer, not a toy.
3. **Is the primary access pattern "fetch one large, self-contained document by id" with genuinely variable shape per document, and do you have people who will maintain the schema in application code forever?**
   - Yes → **MongoDB**. Be honest that you are trading enforcement for flexibility.
4. **Are you inheriting an existing MySQL estate, an operations team that knows MySQL, or a hosting platform where MySQL is the cheap option?**
   - Yes → **MySQL 8** with InnoDB and `utf8mb4`. It is a good database; it is just not better than Postgres for a green field.
5. **Otherwise → PostgreSQL.**

Then, separately: add Redis when you have measured a cache hit rate worth having, not before.

## MySQL

MySQL 8 with InnoDB is a solid relational database with excellent replication and a very large operational knowledge base. Pick it deliberately, for one of the reasons in step 4 above.

Differences that actually affect your code:

- Default isolation is **repeatable read**, not read committed. Long-running transactions see a snapshot from their first read, which surprises people coming from Postgres. See [Transactions](transactions.md).
- `INSERT … ON DUPLICATE KEY UPDATE` instead of `ON CONFLICT`. There is no `RETURNING` — you read `insertId` from the driver result.
- JSON support is real but weaker than `JSONB`; you cannot index a JSON path without a generated column.
- Character sets are a trap: `utf8` is a three-byte alias and cannot store emoji. You want `utf8mb4`. See [MySQL with mysql2](mysql-with-mysql2.md).
- InnoDB automatically creates an index on a foreign key column. Postgres does not. See [Indexing basics](indexing-basics.md).

## SQLite

SQLite is the right production answer more often than people admit. It is an embedded library, not a server, so there is no connection pool, no network round trip, and no separate process to operate. A `SELECT` by primary key is a function call.

It is a good production choice when:

- **One node writes.** A single Node process, or several processes on one machine reading and writing one file.
- **Reads dominate.** With WAL mode, readers do not block the writer and the writer does not block readers.
- **The data set fits on local disk**, and you can afford the restore time from a backup or a replication tool.
- **It is embedded** — a CLI, a desktop app, a per-tenant file, an on-device cache, or a build-time artifact.
- **It is a test fixture.** Every example in this handbook defaults to SQLite so the test suite runs with no external services.

It is the wrong choice when you need more than one machine writing, when you need per-connection concurrency across a fleet, or when your host gives you an ephemeral filesystem.

Two settings decide whether SQLite behaves in production: `PRAGMA journal_mode = WAL` and `PRAGMA busy_timeout`. Without WAL, a single writer blocks every reader. Details in [SQLite](sqlite.md).

## MongoDB

MongoDB stores BSON documents and scales writes horizontally through built-in sharding. Its genuine strengths are a flexible document shape, a good aggregation pipeline, and operational tooling for very large collections.

The honest framing of "schemaless": **the schema does not disappear, it moves into your application code.** Every read path now has to cope with every historical shape of the document, forever, because there is no `ALTER TABLE` that fixes the old rows. Two years in, a codebase with no schema enforcement usually has defensive `?? ''` and `Array.isArray(x) ? x : []` scattered through the read paths, and no single place that says what a user record is.

You can get most of that back with JSON Schema validators on collections and a validation library at the edge, but that is a discipline you have to fund. If you would have chosen Postgres and a `JSONB` column, choose Postgres and a `JSONB` column.

Also note that transactions require a replica set — a standalone `mongod` cannot start one. See [MongoDB](mongodb.md).

## Redis

Redis is an in-memory data-structure server. Use it as a cache, a rate-limit counter store, a lock, a pub/sub bus, or the backing store for a job queue such as BullMQ.

Do not use it as your system of record. Out of the box Redis persists with periodic RDB snapshots; the append-only log is off by default and, when enabled with the default `appendfsync everysec`, still allows roughly one second of acknowledged writes to be lost on a hard failure. A cache is allowed to lose data. An orders table is not.

The other reason is memory: your data set has to fit in RAM plus whatever eviction policy you set. `maxmemory-policy allkeys-lru` silently deletes data, which is correct for a cache and catastrophic for a source of truth.

See [Redis](redis.md).

## What about "we might need to scale"

Ordinary hardware running Postgres handles far more than most teams estimate. A single well-indexed instance serving a few thousand queries per second is unremarkable. Before you choose a database for a scale you do not have:

- Fix the [N+1 queries](n-plus-one-queries.md). This is usually worth 10x.
- Add the missing indexes. See [Indexing basics](indexing-basics.md).
- Size the pool correctly — see [Connection pooling](connection-pooling.md). More connections is usually *slower*.
- Add a read replica, or a cache with a real TTL.

Sharding is the last step, not the first.

## Security considerations

Your database choice changes the shape of the injection risk, not whether one exists.

- **SQL databases** are vulnerable to string-built queries. Every query in this handbook is parameterised. See [SQL injection](../security/sql-injection.md).
- **MongoDB** is vulnerable to *operator* injection: a JSON body of `{"password": {"$ne": null}}` reaching a query object is an authentication bypass, and no amount of escaping helps because nothing is being escaped. See [NoSQL injection](../security/nosql-injection.md).
- **Redis** has no query language to inject into, but it has no authorization model worth the name either. Anything that can connect can read every key. Bind it to a private network, set `requirepass`, and rename or disable administrative commands.

Every one of these databases ships with credentials in a connection string. Treat the connection string as a secret: it is a username, a password, a host and a database name in one value. See [Secrets management](../security/secrets-management.md).

Grant the application role the narrowest privileges that work. The application should not own DDL — that belongs to the migration role. See [Migrations](migrations.md).

## Production considerations

- **Backups you have restored.** An untested backup is not a backup. Schedule a restore drill and time it; the restore time is your real recovery objective.
- **Managed beats self-hosted** for almost every team. The value is not the server — it is the point-in-time recovery, the failover, and the person who is paged instead of you.
- **Pick the version before you pick the provider.** Managed platforms lag upstream by months, and major-version upgrades on a live database are a project.
- **Connection limits are a real capacity constraint.** A Postgres instance with `max_connections = 100` and eight application replicas each holding a pool of 20 is already oversubscribed.
- **Plan for two databases eventually.** Almost every mature backend ends up with a relational system of record plus Redis. Design so that Redis is optional — the app should degrade to slower, not broken, when the cache is down.

## Common mistakes

- **Choosing MongoDB to avoid writing a schema.** You are not avoiding the schema, you are moving it into every read path in the codebase and removing the database's ability to reject bad data.
- **Choosing Redis as a primary store** because it is fast, then discovering that "persistence" defaults to a snapshot every few minutes.
- **Adding a cache before adding an index.** The cache hides the slow query rather than fixing it, and now you have two sources of truth.
- **Assuming SQLite is a toy.** For a single-node, read-heavy service it is often the fastest and cheapest correct answer.
- **Assuming SQLite will do.** It has exactly one writer. Two application servers on two machines writing to a shared network filesystem is a corruption bug, not a scaling strategy.
- **Picking a database because the ORM you like supports it best.** The ORM is replaceable. The data is not. See [When to use an ORM](../orms/when-to-use-an-orm.md).
- **Running with `utf8` instead of `utf8mb4` on MySQL**, then discovering it at the moment a user posts an emoji.

## Related topics

- [PostgreSQL with pg](postgresql-with-pg.md) — the default, driven directly.
- [MySQL with mysql2](mysql-with-mysql2.md) — the relational alternative and its sharp edges.
- [SQLite](sqlite.md) — when one file on one disk is the correct architecture.
- [MongoDB](mongodb.md) — the document driver, and the operator-injection hole.
- [Redis](redis.md) — cache, counters and queues, not a system of record.
- [Connection pooling](connection-pooling.md) — the constraint that decides how many app instances you can run.
- [When to use an ORM](../orms/when-to-use-an-orm.md) — the layer above whatever you pick here.
- [NoSQL injection](../security/nosql-injection.md) — why a JSON body can become a query operator.
