---
title: Native TypeScript support
description: Running .ts files directly on Node 24 with type stripping — what is erased, what needs a flag, and how to configure tsconfig so it keeps working.
status: current
updated: 2026-09-08
---

Node 24 runs TypeScript files directly. It does not compile them and it does not type-check them — it **erases** the type annotations and hands the resulting JavaScript to V8. That removes `ts-node`, `tsx` and a `dist/` directory from most backend projects, at the cost of understanding exactly which TypeScript syntax survives erasure.

## Just run it

```ts title="src/server.ts"
import http from 'node:http'

interface Health {
  status: 'ok'
  uptime: number
}

function health(): Health {
  return { status: 'ok', uptime: process.uptime() }
}

http
  .createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(health()))
  })
  .listen(3000)
```

```bash
node src/server.ts
```

No flag, no build step, no `tsconfig.json` required to *run*. Type stripping was introduced behind `--experimental-strip-types` in Node 22.6 and is **enabled by default from Node 23.6 and in Node 24**. `--no-experimental-strip-types` turns it back off.

## How type stripping works

Node replaces every type annotation with **whitespace of the same length**. `function health(): Health {` becomes `function health()         {`.

That detail has a real consequence: line and column numbers are identical between your `.ts` file and the JavaScript V8 executes, so stack traces point at the right place with **no source maps involved**. You are not debugging generated code, because nothing was generated.

It also explains the limitation. Anything that would require *emitting* code cannot be erased.

## What needs `--experimental-transform-types`

| Syntax | Erasable? | Why |
| --- | --- | --- |
| `interface`, `type`, annotations, generics | yes | pure types |
| `import type` / `export type` | yes | pure types |
| `satisfies`, `as`, non-null `!` | yes | pure types |
| `abstract`, `implements`, `declare` | yes | pure types |
| `enum`, `const enum` | **no** | emits a runtime object |
| `namespace` with runtime members | **no** | emits a runtime object |
| Parameter properties — `constructor(private id: string)` | **no** | emits assignments |
| Legacy `experimentalDecorators` decorators | **no** | emits runtime calls |

For those, run with:

```bash
node --experimental-transform-types src/server.ts
```

This does a real transform rather than an erase, so line numbers can shift and source maps come into play.

:::best-practice
Do not use `--experimental-transform-types`. Avoid the non-erasable syntax instead — a union of string literals replaces `enum`, an explicit field assignment replaces a parameter property, and a module replaces a `namespace`. You keep the simpler runtime, the exact stack traces, and portability to any other tool that erases types.
:::

```ts title="src/status.ts"
// instead of: enum Status { Active = 'active', Banned = 'banned' }
export const Status = { Active: 'active', Banned: 'banned' } as const
export type Status = (typeof Status)[keyof typeof Status]
```

## Node does not type-check

This is the most important sentence on the page. `node src/server.ts` runs a file with type errors happily — the types were thrown away without being read.

Type checking is a separate step you run in your editor and in CI:

```json title="package.json"
{
  "scripts": {
    "start": "node src/server.ts",
    "dev": "node --watch --env-file-if-exists=.env src/server.ts",
    "test": "node --test",
    "typecheck": "tsc --noEmit"
  }
}
```

CI must run `npm run typecheck`. Without it you have TypeScript syntax and JavaScript guarantees.

## tsconfig for a no-build project

```json title="tsconfig.json"
{
  "compilerOptions": {
    "target": "esnext",
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "lib": ["esnext"],
    "strict": true,
    "noEmit": true,
    "erasableSyntaxOnly": true,
    "verbatimModuleSyntax": true,
    "allowImportingTsExtensions": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src/**/*.ts"]
}
```

The four options that specifically make this work with Node's stripper:

- **`erasableSyntaxOnly`** (TypeScript 5.8+) makes `tsc` report an error on `enum`, `namespace`, parameter properties and legacy decorators. It is how you find out at type-check time, rather than when Node refuses to run the file.
- **`verbatimModuleSyntax`** forces you to write `import type` for type-only imports. Node erases `import type` but keeps a plain `import`, so without this option an import that only carried types remains at runtime and tries to load a module that may not exist.
- **`allowImportingTsExtensions`** lets you write the extension Node actually needs (see below). It requires `noEmit`.
- **`noEmit`** — `tsc` checks; it does not produce output. Nothing writes to `dist/`.

`@types/node` is still a dependency: it is what gives `node:fs`, `process` and the rest their types.

:::tabs
@tab npm
```bash
npm install -D typescript@^7.0.2 @types/node
```
@tab pnpm
```bash
pnpm add -D typescript@^7.0.2 @types/node
```
@tab yarn
```bash
yarn add -D typescript@^7.0.2 @types/node
```
:::

## Import extensions

Node resolves what you literally wrote. There is no `.js` → `.ts` remapping:

```ts title="src/app.ts"
import { createUser } from './users/create.ts'   // correct
import { createUser } from './users/create.js'   // ERR_MODULE_NOT_FOUND — no such file
import { createUser } from './users/create'      // ERR_MODULE_NOT_FOUND — ESM needs an extension
```

This is the opposite of the long-standing TypeScript convention of importing `./create.js` from `create.ts`, which exists because `tsc` used to rewrite the extension during emit. When Node runs the file directly there is no emit, so you write `.ts` and set `allowImportingTsExtensions`.

If you also need to publish compiled JavaScript, TypeScript's `rewriteRelativeImportExtensions` option converts `.ts` specifiers to `.js` on emit, so one source tree can serve both. For an application that is never published, you do not need it.

:::warning
Type stripping is **not applied inside `node_modules`**. A dependency must ship JavaScript; a package that publishes only `.ts` files will not load. This also means the feature costs nothing at install time — Node is never asked to strip a third-party tree.
:::

`.mts` and `.cts` work like `.mjs` and `.cjs`: they force ESM and CommonJS respectively, regardless of the nearest `package.json` `"type"`.

## Common patterns

### Typing your config object

The Zod schema from [Environment variables and config](./environment-variables-and-config.md) already produces a typed object — no interface to maintain by hand:

```ts title="src/config.ts"
import { z } from 'zod'

const EnvSchema = z.object({
  PORT: z.coerce.number().int().default(3000),
  DATABASE_URL: z.url(),
})

export type Config = z.infer<typeof EnvSchema>
export const config: Config = Object.freeze(EnvSchema.parse(process.env))
```

`z.infer` derives the type from the validator, so the runtime check and the compile-time type can never drift apart.

### Tests in TypeScript

```bash
node --test
```

The runner picks up `*.test.ts` alongside `*.test.js` on Node 24, and strips types the same way. No transform configuration, no `ts-jest`.

### Express types

The same handler, written both ways. Nothing about the runtime behaviour differs —
Node erases the annotations and executes the left-hand version:

:::tabs
@tab JavaScript
```js title="src/routes/users.js"
export async function getUser(req, res, next) {
  const user = await findUser(req.params.id)
  if (!user) return res.status(404).json({ error: 'not_found' })
  res.json(user)
}
```
@tab TypeScript
```ts title="src/routes/users.ts"
import type { Request, Response, NextFunction } from 'express'

export async function getUser(req: Request, res: Response, next: NextFunction) {
  const user = await findUser(req.params.id)
  if (!user) return res.status(404).json({ error: 'not_found' })
  res.json(user)
}
```
:::

Install `@types/express` **5.0.6** — the 4.x type packages describe an API that Express 5 no longer has, and they will type-check code that fails at runtime.

Note `import type` on that line: the imports are purely types, so the `type` keyword is what lets Node erase the whole statement.

### When a build step is still right

| Situation | Why |
| --- | --- |
| Publishing a library to npm | consumers need `.js` plus `.d.ts` declaration files |
| You need decorators or `enum` | non-erasable; a compiler emits them properly |
| Bundling for size or cold-start | esbuild/rollup do work Node does not |
| Targeting a runtime without stripping | anything older than Node 22.6, or a non-Node runtime |

`tsx` 4.23.13 remains a reasonable choice when you want type-stripping behavior on an older runtime or need its resolution conveniences. On Node 24, for a service you deploy as source, you do not need it.

## Common mistakes

- **Assuming `node file.ts` type-checks.** It does not. Run `tsc --noEmit` in CI or you have no type safety at all.
- **Writing `enum` and wondering why Node throws.** Not erasable. Use a `const` object with `as const`, or enable `erasableSyntaxOnly` so `tsc` tells you first.
- **Parameter properties in constructors.** `constructor(private db: Db)` emits an assignment. Declare the field and assign it.
- **Importing `./x.js` from a `.ts` file you run directly.** Node looks for a file that does not exist. Import `./x.ts`.
- **Leaving `verbatimModuleSyntax` off.** A type-only import survives erasure and fails at runtime.
- **Reaching for `--experimental-transform-types` as the default.** It gives up exact line numbers to support syntax you can avoid.
- **Expecting a `.ts`-only dependency to work.** Type stripping skips `node_modules`.
- **Installing `@types/express@4` with Express 5.** The types describe removed APIs.
- **Keeping `ts-node`, `nodemon` and a `dist/` build for a service you deploy as source.** `node --watch src/server.ts` covers it.

## Related topics

- [ESM vs CommonJS](./esm-vs-commonjs.md) — the extension and `"type"` rules that type stripping inherits.
- [package.json and npm scripts](./package-json-and-npm-scripts.md) — a script set with `typecheck` and no build step.
- [The built-in test runner](./built-in-test-runner.md) — running `.ts` tests with `node --test`.
- [Environment variables and config](./environment-variables-and-config.md) — deriving config types from a Zod schema.
- [Debugging](./debugging.md) — why stripped types need no source maps, and when you still do.
- [Continuous integration](../production/ci.md) — where `tsc --noEmit` belongs in the pipeline.
