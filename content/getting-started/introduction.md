---
title: Introduction
description: What this handbook is, who it is for, the opinions it takes, and how to read it.
status: current
updated: 2026-09-08
---

This is a production-oriented handbook for building HTTP backends with Node.js 24 LTS and Express 5. It is not a tutorial that stops at "hello world" — every page is written for code that will be exposed to the internet, run under a process supervisor, and be woken up at 3am by someone who did not write it.

## What this handbook is

A single, internally consistent reference covering the runtime, the framework, the libraries you will actually install, the database layer, the security work, and the operational work — written against one set of verified versions rather than a decade of accumulated blog posts.

Three properties matter more than breadth:

- **It is current.** Every version number, API and flag in the site was checked against the npm registry and the Node.js release schedule on **2026-09-08**. The pinned list lives in [Library index](../reference/library-index.md); prose quotes the same numbers.
- **It is security-first.** Security is not an appendix. Pages that touch user input state the threat, show a working exploit, show the fix in code, and show how to verify the fix.
- **It is honest about cost.** Where a technique has a real downside — clustering, ORMs, MongoDB, Alpine base images — the downside is written down next to the technique, not omitted to keep the page tidy.

## Who it is for

You should already be comfortable writing JavaScript: closures, `async`/`await`, promises, destructuring, and modules. You do not need prior Express experience, and you do not need to know Node's internals — [Node.js Fundamentals](../node/runtime-and-event-loop.md) covers what you need.

It suits three readers in particular:

- Someone who knows Express 4 and needs to know exactly what Express 5 changed. Start at [Express 4 → 5 migration](../reference/express-4-to-5-migration.md).
- Someone building their first service that other people will depend on.
- Someone who has a service in production and wants a checklist of what they have not done yet. Start at [Deployment checklist](../production/deployment-checklist.md).

## The opinions it takes

A handbook with no opinions is a list of options, which is not useful when you are trying to ship. These are the defaults, stated up front so you can disagree with them deliberately.

| Opinion | Why |
| --- | --- |
| **ESM only** (`"type": "module"`) | It is the standard module system, Node 24 supports it fully, and half the ecosystem — `file-type`, `nanoid`, and others — is ESM-only already. |
| **Layered architecture** — route → controller → service → repository | Business logic that lives inside a route handler cannot be tested without an HTTP server and cannot be reused by a job or a CLI. |
| **Parameterised queries, always** | String-built SQL is the single most common way a Node backend gets breached. The site's own linter fails the build on it. |
| **Validate at the edge** | Parse untrusted input into a typed value at the boundary with Zod 4, and let everything behind the boundary assume the value is valid. |
| **Node built-ins over packages** | `node --env-file`, `node:test`, `node:sqlite`, `fetch`, `node --watch` replace four dependencies you used to install. Fewer dependencies is less audit surface. |
| **Node 24 LTS as the target** | Node 20 reached end of life on 2026-04-30. Node 26 is still Current and does not enter LTS until 2026-10-28. |
| **Express 5 only** | Express 4 material appears in exactly one page, clearly marked. |

:::deprecated Async wrappers are obsolete
Express 5's biggest practical change: an `async` handler that rejects is forwarded to your error middleware automatically. `express-async-handler` and hand-rolled `asyncHandler()` wrappers exist only to work around an Express 4 limitation, and every example here is written without them.
:::

## How it is structured

Nine sections, ordered so that reading straight through works, but each page stands alone.

1. **Getting Started** — this section: scope, prerequisites, and how to run the examples.
2. **Node.js Fundamentals** — the runtime under the framework.
3. **Express Fundamentals** — routing, middleware, errors, and application layout.
4. **Express Libraries** — the packages a real API needs, each with a working configuration.
5. **Databases** — drivers, pools, transactions, migrations, and operational detail.
6. **ORMs and Query Builders** — what each is good at, and how to keep raw-query escape hatches safe.
7. **Security** — threat, exploit, fix, verification.
8. **Production** — configuration, shutdown, probes, observability, Docker, CI, performance.
9. **Reference** — migration guide, cheat sheet, library index, troubleshooting.

[What this covers](what-this-covers.md) expands each of those into a one-line reason to read it, and lists what is deliberately out of scope.

### It is built to grow

A later pass adds a Next.js section covering the front end and the boundary between it and these APIs. Nothing in the current structure has to change for that: the sidebar, breadcrumbs, previous/next links, search index and orphan checks are all derived from a single `sections` array in `scripts/nav.mjs`. Adding a section is appending one object to that array and creating the matching content directory.

That is worth knowing as a reader too — the navigation you see is generated, so a section that appears later will be threaded into the same ordering rather than bolted on beside it.

## How to read it

- **New to Express?** Read Getting Started, then Node.js Fundamentals, then Express Fundamentals in order. Stop after each page and run the linked example.
- **Migrating from Express 4?** [Express 4 → 5 migration](../reference/express-4-to-5-migration.md) first, then the pages it links.
- **Shipping something next week?** [Deployment checklist](../production/deployment-checklist.md), then follow every unchecked item to the page that explains it.
- **Fixing a specific problem?** Use search, or [Troubleshooting](../reference/troubleshooting.md).

Every code block is complete enough to paste and run, including the imports. Where a snippet is a fragment of something larger, a link at the end of the section points at the full runnable version under `examples/` — see [Running the examples](running-the-examples.md).

:::warning
Code fences marked with a red **"Vulnerable — do not copy"** banner are deliberate demonstrations of an exploitable bug. They exist so the exploit is concrete. The corrected version always follows immediately, under a green banner.
:::

## Version facts and their expiry date

The fact-verification pass for this site is dated **2026-09-08**. Everything version-specific — Node release states, npm `latest` tags, deprecations — was true on that date and is recorded in [Library index](../reference/library-index.md).

Versions move. When you read a version in prose, treat it as "this is what was current when the page was written and what the examples were tested against", not as "pin exactly this". The examples pin caret ranges; the prose quotes the bare version.

Two facts in particular are dated and will change:

- Node 26 becomes Active LTS on **2026-10-28**. After that date, "Node 24 is the only Active LTS line" stops being true, though Node 24 remains supported until **2028-04-30**.
- `prisma` publishes a release candidate on its npm `latest` tag. The documented stable release is 7.10.0.

## Common mistakes

- **Reading only the code blocks.** The prose carries the *why*. A snippet copied without the paragraph above it is how a correct-looking configuration ends up wrong for your deployment.
- **Assuming Express 4 habits still work.** `res.redirect(url, status)` flipped its arguments, `req.body` is `undefined` rather than `{}` when no parser ran, and `'/*'` is no longer a valid path. These fail quietly or at runtime, not at install time.
- **Treating a version number here as a pin.** Check [Library index](../reference/library-index.md) and the registry before you pin. A version that was current in September 2026 is not automatically current for you.
- **Skipping to the Production section.** Most production incidents trace back to a fundamentals decision — an unvalidated body, a leaked connection, a missing index — not to a missing Dockerfile flag.
- **Copying a `vulnerable`-marked block.** They are labelled for a reason and are exempt from the site's SQL-injection linter precisely because they are meant to fail it.

## Related topics

- [What this covers](what-this-covers.md) — the section-by-section map, and what is out of scope.
- [Prerequisites](prerequisites.md) — the runtime, tooling and knowledge you need before page one.
- [Running the examples](running-the-examples.md) — how the `examples/` directory works.
- [Library index](../reference/library-index.md) — every pinned version on one page.
- [Express 4 → 5 migration](../reference/express-4-to-5-migration.md) — the only page where Express 4 APIs appear.
- [Deployment checklist](../production/deployment-checklist.md) — the fastest way to find your gaps.
