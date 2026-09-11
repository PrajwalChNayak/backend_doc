# nest-esm — a NestJS 12 app as a pure ES module

The same shape as `nest-minimal-api`, but built and run as a **pure ES module**
rather than CommonJS. Read the two `package.json` and `tsconfig.json` files side
by side — the code is nearly identical, and the four differences are the whole
point of this example.

## What differs from the CommonJS examples

| | CommonJS (`nest-minimal-api`) | ESM (this example) |
| --- | --- | --- |
| `package.json` `"type"` | absent (defaults to `commonjs`) | **`"module"`** |
| Relative imports | `'./app.service.js'` (works either way) | `'./app.service.js'` — **required**, not optional |
| Dir of the current file | `__dirname` | **`import.meta.dirname`** |
| tsconfig `module` / `moduleResolution` | `nodenext` | `nodenext` (same) |
| tsconfig `resolvePackageJsonExports` | inherited | **`true`**, set explicitly |
| Emitted `dist/main.js` | `require(...)` | `import ...` |

That last row is the test: build both, and `head dist/main.js` shows `require`
for the CommonJS one and `import` for this one.

## Why this works at all

Nest 12's own packages are **already ESM** — `@nestjs/core` and
`@nestjs/common` both declare `"type": "module"` and use `.js` specifiers in
their internal imports. The CommonJS examples consume them through Node's
`require(esm)` support (which is why their floor is Node 20.19). An ESM app skips
that interop entirely and imports them the native way. Both are fully supported;
`nest upgrade` preserves whichever format a project already uses.

## Prerequisites

Node **20.19+ / 22.12+ / 24 LTS**. Nothing else.

## Install, build, run

```bash
cd examples/nest-esm
npm install
npm run setup     # = npm run build
npm start
```

```
nest-esm listening on http://localhost:3040
```

Port **3040** (`PORT`).

## Routes

### `GET /health`

```bash
curl -s http://localhost:3040/health
```

```json
{"status":"ok"}
```

### `GET /`

```bash
curl -s http://localhost:3040/
```

```json
{"name":"nest-esm","moduleSystem":"ESM (\"type\": \"module\")","framework":"NestJS 12 on Express 5","node":"v24.20.0","entryDir":"C:\\project\\backend_doc\\examples\\nest-esm\\dist","uptimeSeconds":1}
```

`entryDir` is produced by `import.meta.dirname`. In a CommonJS module that
expression is a syntax-level error; `__dirname` is the equivalent there and does
not exist here. That single swap is the most common thing that breaks when a
project moves to ESM.

## The `.js` extension that confuses everyone

`src/app.controller.ts` imports from `'./app.service.js'` — with `.js`, even
though the file on disk is `app.service.ts`:

```ts
import { AppService } from './app.service.js'
```

Under `moduleResolution: "nodenext"`, a relative import must name the **emitted**
file, and the emitted file is `app.service.js`. TypeScript resolves `.js` back to
the `.ts` source at compile time; Node loads the real `.js` at runtime. Writing
`'./app.service'` (no extension) type-checks in some configs but fails at runtime
with `ERR_MODULE_NOT_FOUND`, because Node's ESM loader does not guess
extensions. This applies to the CommonJS examples too — they use `.js` specifiers
already — but ESM is where omitting it actually fails, so it is worth stating
here.

## When to choose ESM for a Nest service

- **New service, no legacy CommonJS dependencies you cannot import** → ESM is the
  forward-looking choice and matches Nest's own packages. The Nest CLI now
  scaffolds new projects as ESM.
- **Existing CommonJS app** → leave it. `require(esm)` means it already consumes
  Nest 12's ESM packages without a rewrite, and a format migration buys nothing
  on its own.
- **You depend on a package that is CommonJS-only** → still fine from ESM (you
  can `import` CommonJS), but a package that does dynamic `require()` of *your*
  files will not find them. Rare, but it is the one thing to check first.

## Related examples

- `nest-minimal-api` — this same app as CommonJS, for a direct diff.
- `nest-prisma` — where the ESM-vs-CommonJS distinction shows up in a code
  generator's output settings.
