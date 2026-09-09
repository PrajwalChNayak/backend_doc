# Unverified / omitted claims — security pages (author A)

Author A owns: sql-injection, nosql-injection, cors-misconfiguration,
file-upload-security, xss, csrf.

Items intentionally left out because they could not be verified against official
docs or the npm registry during authoring (2026-09-08):

- **pg identifier quoting via a format string (`%I`).** `pg` itself has no built-in
  identifier-quoting helper. The `pg-format` package provides `format('%I', name)`,
  but its exact current version was not verified, so the SQL-injection page mentions
  only that such a package exists and instead demonstrates allow-list validation plus
  the driver-level helpers that ARE verifiable (`knex.raw`'s `??`, mysql2 `escapeId`).
- **`Access-Control-Allow-Private-Network` / Local Network Access exact browser gate.**
  Chrome's Private Network Access / Local Network Access behavior is mid-rollout and the
  precise enforcement version differs across Chrome/Edge builds. The CORS page describes
  the concept only in general terms and does not assert a specific version or a specific
  response-header requirement as settled fact.
