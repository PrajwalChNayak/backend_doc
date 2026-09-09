---
title: ESM vs CommonJS
description: Why ESM is the default for new Node 24 services, and how to survive the CommonJS code you still have to interoperate with.
status: current
updated: 2026-09-08
---

Node has two module systems. ECMAScript modules (`import` / `export`) are the standard and what you should write for new code; CommonJS (`require` / `module.exports`) is the older format that most of npm was published in and that you will keep meeting for years. This page covers how Node decides which one a file is, what genuinely differs, and how to cross the boundary without the usual pain.

## How Node decides

Node picks a module format per file, using two signals:

| Signal | Result |
| --- | --- |
| `.mjs` extension | ESM |
| `.cjs` extension | CommonJS |
| `.js` with nearest `package.json` containing `"type": "module"` | ESM |
| `.js` with `"type": "commonjs"` or no `type` field | CommonJS |

"Nearest `package.json`" means Node walks up from the file until it finds one. That is why a `"type"` field in your root `package.json` silently changes the meaning of every `.js` file in the project.

```json title="package.json"
{
  "name": "my-api",
  "type": "module",
  "engines": { "node": ">=24" }
}
```

:::best-practice
Set `"type": "module"` in every new project. Write `.js` files with `import`/`export`, and drop to `.cjs` only for the rare file that must be CommonJS.
:::

## What actually differs

| | ESM | CommonJS |
| --- | --- | --- |
| Loading | asynchronous, statically analysed | synchronous, resolved at call time |
| `import`/`require` placement | `import` is hoisted, top level only (or `import()`) | `require()` anywhere, conditionally |
| Top-level `await` | supported | not supported |
| `__dirname`, `__filename` | not defined | defined |
| `require`, `module`, `exports` | not defined | defined |
| `this` at module scope | `undefined` | `module.exports` |
| Relative import extensions | **required** (`./util.js`) | optional (`./util`) |
| Directory imports (`./lib`) | not supported | resolves `index.js` |
| JSON import | needs an import attribute | plain `require('./x.json')` |
| Live bindings | yes — exports update | no — a snapshot of the value |

The extension rule is the one that catches everyone. In ESM, `import { x } from './util'` throws `ERR_MODULE_NOT_FOUND`; you must write `'./util.js'`.

### Replacing `__dirname`

Node 24 gives you `import.meta.dirname` and `import.meta.filename` directly:

```js title="src/paths.js"
import { join } from 'node:path'

const templates = join(import.meta.dirname, 'templates')
```

For a URL — which is what you want when passing a module location to `new Worker()` or `import()` — use `import.meta.url`, and convert with `fileURLToPath` when an API needs a plain path:

```js title="src/paths.js"
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const worker = new URL('./worker.js', import.meta.url) // pass the URL directly
```

:::warning
Never hand a raw `import.meta.url` string to `fs` or `path`. It is a `file://` URL, and on Windows it looks like `file:///C:/app/src/x.js` — `path.join` will mangle it. Convert with `fileURLToPath` first, or use `import.meta.dirname`.
:::

### Importing JSON

```js title="src/version.js"
import pkg from '../package.json' with { type: 'json' }

export const version = pkg.version
```

The `with { type: 'json' }` import attribute is mandatory — without it Node refuses to load the file. If you would rather avoid the attribute, read it at runtime instead:

```js title="src/version.js"
import { readFile } from 'node:fs/promises'

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
export const version = pkg.version
```

The second form also avoids shipping `package.json` contents into a bundle you did not intend.

## Interop: the rules that matter

### ESM importing CommonJS

This has always worked. Node gives you the CommonJS `module.exports` object as the **default export**:

```js title="src/db.js"
import pg from 'pg'            // CommonJS package

const { Pool } = pg            // named destructure from the default
export const pool = new Pool()
```

Node also detects many named exports statically, so `import { Pool } from 'pg'` often works too — but detection is best-effort. If a named import throws `SyntaxError: The requested module does not provide an export named …`, fall back to importing the default and destructuring, as above.

### CommonJS importing ESM

Historically impossible without `await import()`. **From Node 22.12 (and 23.0) `require()` of an ES module works** for modules that do not use top-level `await`:

```js title="legacy/boot.cjs"
const { createApp } = require('../src/app.js') // an ESM file — supported on Node 22.12+
```

If the ESM graph contains top-level `await`, `require()` throws `ERR_REQUIRE_ASYNC_MODULE` and you must use dynamic `import()`, which returns a promise:

```js title="legacy/boot.cjs"
async function main() {
  const { createApp } = await import('../src/app.js')
  createApp().listen(3000)
}
main()
```

:::note
`require()` of ESM returns the module namespace object. A module's `export default` is on the `.default` property, so `require('./esm.js').default` — not the bare return value. Node also sets `module.exports` to the namespace, so named exports come out at the top level.
:::

### `createRequire` — using CommonJS-only APIs from ESM

Some things only exist in CommonJS resolution, notably `require.resolve()`:

```js title="src/resolve.js"
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const configPath = require.resolve('some-package/config.json')
```

Use it for resolution and for the occasional package that cannot be imported. Do not use it as a general escape hatch — you lose the static analysis that makes ESM tooling work.

## Publishing: `exports` and the dual-package hazard

The `"exports"` field defines your package's public surface. Anything not listed is unreachable from outside, which is the point: it stops consumers from importing your internals and then breaking when you move a file.

```json title="package.json"
{
  "name": "@acme/toolkit",
  "type": "module",
  "exports": {
    ".": "./dist/index.js",
    "./errors": "./dist/errors.js",
    "./package.json": "./package.json"
  }
}
```

A dual package ships both formats through conditions:

```json title="package.json"
{
  "exports": {
    ".": {
      "import": "./dist/index.mjs",
      "require": "./dist/index.cjs"
    }
  }
}
```

:::danger
**The dual-package hazard.** If one part of an application `import`s your package and another `require`s it, Node loads both copies. You now have two module instances: two connection pools, two caches, and `instanceof` checks against your error classes fail across the boundary because the classes are different objects.
:::

The fix is to not ship dual. Publish ESM only, and let Node 22.12+ consumers `require()` it. If you must ship both, keep all state in a single CommonJS core and make the ESM entry a thin re-export wrapper, so only one copy holds state.

### Subpath imports for internal aliases

`"imports"` gives you internal aliases that work in plain Node, with no bundler or `tsconfig` path mapping:

```json title="package.json"
{
  "imports": {
    "#config": "./src/config.js",
    "#db/*": "./src/db/*.js"
  }
}
```

```js title="src/routes/users.js"
import { pool } from '#db/pool'
import { config } from '#config'
```

Keys must start with `#`. This is the portable replacement for the `../../../` chains that make refactoring painful.

## Common mistakes

- **Omitting the file extension in an ESM relative import.** `./util` is not resolved; write `./util.js`.
- **Using `__dirname` in ESM.** It is not defined. Use `import.meta.dirname`, or `fileURLToPath(import.meta.url)` when you need the file path.
- **Passing `import.meta.url` where a path is expected.** It is a URL string; `fs` and `path` will not do what you want on Windows.
- **Adding `"type": "module"` to a project full of `require()` calls.** Every `.js` file changes meaning at once. Rename the stragglers to `.cjs`, or migrate deliberately.
- **Assuming named imports from a CommonJS package always work.** Export detection is heuristic. Import the default and destructure when it fails.
- **Shipping a dual package with state in both entries.** Two copies of your module means two pools and broken `instanceof`. Prefer ESM-only.
- **Forgetting `"./package.json": "./package.json"` in `exports`.** Tools that read your `package.json` at runtime break without it.
- **Reaching for a bundler or `tsx` just to get `require` to work.** On Node 24 `require(esm)` already works for modules without top-level `await`.

## Related topics

- [package.json and npm scripts](./package-json-and-npm-scripts.md) — where `type`, `exports` and `imports` live.
- [Native TypeScript support](./native-typescript-support.md) — how type stripping interacts with the extension rules.
- [Files and paths](./fs-and-path.md) — `fileURLToPath` and safe path handling in depth.
- [Async/await and promises](./async-await-and-promises.md) — top-level `await` and dynamic `import()`.
- [Setup and project structure](../express/setup-and-project-structure.md) — the layout these module rules assume.
