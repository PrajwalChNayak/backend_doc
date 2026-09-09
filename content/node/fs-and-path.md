---
title: Files and paths
description: Using node:fs/promises safely — path containment against traversal attacks, cross-platform path rules, fs.watch caveats, and atomic writes.
status: current
updated: 2026-09-08
---

File access is where a backend most often meets untrusted input, so this page treats `node:fs` and `node:path` together: the API you should use, and the containment rules that stop a filename parameter from reading `/etc/passwd`. Everything here assumes the promise API — `node:fs/promises` — with the callback API reserved for the few places that still need it.

## The API you should use

```js title="src/store.js"
import { readFile, writeFile, mkdir, rm, rename, stat, readdir } from 'node:fs/promises'

await mkdir('data/cache', { recursive: true })
const raw = await readFile('data/cache/index.json', 'utf8')
```

| Need | Call |
| --- | --- |
| Read a small file | `readFile(path, 'utf8')` — pass the encoding or you get a `Buffer` |
| Read a large file | `createReadStream(path)` from `node:fs` |
| Create a directory tree | `mkdir(path, { recursive: true })` — no error if it exists |
| Delete a tree | `rm(path, { recursive: true, force: true })` |
| List a directory | `readdir(path, { withFileTypes: true })` — `Dirent` objects, no extra `stat` calls |
| Copy a tree | `cp(src, dest, { recursive: true })` |
| Metadata | `stat(path)` — follows symlinks; `lstat` does not |

`createReadStream` and `createWriteStream` are the exceptions: they live on `node:fs`, not `node:fs/promises`, because they return streams rather than promises.

:::warning
Synchronous calls (`readFileSync`, `writeFileSync`) block the event loop and stall every other request in the process. They are fine **once, at startup** — reading a config file before `listen()`. They are never fine inside a request handler. See [Runtime and the event loop](./runtime-and-event-loop.md).
:::

### Do not check, then act

```js title="src/bad.js"
import { access, readFile } from 'node:fs/promises'

try { await access(path) } catch { return null }
return readFile(path, 'utf8')          // the file can vanish in between
```

Between the `access` and the `readFile` the file can be deleted, replaced, or swapped for a symlink — a time-of-check/time-of-use race that is exploitable when an attacker controls anything in that directory. Attempt the operation and handle the error:

```js title="src/good.js"
import { readFile } from 'node:fs/promises'

try {
  return await readFile(path, 'utf8')
} catch (err) {
  if (err.code === 'ENOENT') return null
  throw err
}
```

Useful codes: `ENOENT` (missing), `EACCES` / `EPERM` (permissions), `EISDIR`, `ENOTDIR`, `EEXIST`, `EMFILE` (too many open descriptors), `ENOSPC` (disk full).

## Path containment — the security part

Any time a request supplies part of a filesystem path, you must prove the result stays inside a directory you chose.

```js vulnerable title="DO NOT COPY"
import path from 'node:path'
import { readFile } from 'node:fs/promises'

app.get('/files/:name', async (req, res) => {
  const file = path.join('/srv/uploads', req.params.name)
  res.send(await readFile(file, 'utf8'))
})
```

`path.join` normalizes `..` segments happily, so this is a directory-traversal hole:

```bash
curl --path-as-is 'http://localhost:3000/files/..%2f..%2fetc%2fpasswd'
```

The fix is `path.resolve` to get an absolute path, then an explicit containment check:

```js good title="src/files.js"
import path from 'node:path'
import { readFile } from 'node:fs/promises'

const ROOT = path.resolve('/srv/uploads')

export function resolveInside(root, userPath) {
  const target = path.resolve(root, userPath)
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error('path escapes root')
  }
  return target
}

app.get('/files/:name', async (req, res, next) => {
  try {
    const file = resolveInside(ROOT, req.params.name)
    res.type('text/plain').send(await readFile(file, 'utf8'))
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'not_found' })
    next(err)
  }
})
```

Three details make the check correct:

- `path.resolve` is applied to the **joined** result, so `..` is collapsed before you compare.
- The `root + path.sep` suffix prevents `/srv/uploads-secret` from passing a naive `startsWith(root)`.
- The `target !== root` branch allows the root itself, which a plain prefix test would reject.

:::danger
Containment on the *resolved string* does not defeat **symlinks**. If an attacker can create files in the root — an uploads directory is exactly that — they can drop a symlink pointing at `/etc/shadow`, and the resolved path still looks contained. When the directory is writable by untrusted users, resolve the real path too and re-check:

```js
import { realpath } from 'node:fs/promises'

const real = await realpath(target)   // throws ENOENT if it does not exist
if (real !== ROOT && !real.startsWith(ROOT + path.sep)) throw new Error('path escapes root')
```
:::

The stronger option is to not use user input in the path at all: store uploads under a generated id (`crypto.randomUUID()`) and keep the original filename in the database. Then traversal is structurally impossible. See [File upload security](../security/file-upload-security.md).

:::note
`path.basename(userInput)` strips directories and is a reasonable extra guard for a single filename, but it is not sufficient on its own — it happily returns `.env` or a name with a leading dot. Combine it with an allow-list of extensions and the containment check above.
:::

## Cross-platform paths

`node:path` adapts to the host: `path.sep` is `/` on POSIX and `\` on Windows, and `path.delimiter` is `:` or `;`. Two named variants let you force the behavior:

| Module | Use for |
| --- | --- |
| `path` | real filesystem paths on the current host |
| `path.posix` | anything that is always `/`-separated — URL paths, S3 keys, tar entries, Docker paths |
| `path.win32` | manipulating Windows paths from a POSIX host |

```js title="src/keys.js"
import path from 'node:path'

const objectKey = path.posix.join('tenants', tenantId, 'exports', name)  // stays '/' on Windows
const onDisk = path.join(baseDir, 'exports', name)                       // native separators
```

Using plain `path.join` for a URL or an object-storage key produces `tenants\a\exports\b` when your developers run Windows and your CI runs Linux — a bug that only appears on one machine.

### `join` vs `resolve`

`path.join` concatenates and normalizes. `path.resolve` walks its arguments right-to-left and stops at the first absolute one, returning an absolute path:

```js
path.join('/srv', '/etc/passwd')      // '/srv/etc/passwd'
path.resolve('/srv', '/etc/passwd')   // '/etc/passwd'  — the absolute argument wins
```

That difference matters for user input: `resolve` lets an absolute path override your root, which is exactly why the containment check comes *after* the resolve, not instead of it.

### File URLs

ESM gives you locations as `file://` URLs. Convert before touching `fs` or `path`:

```js title="src/fixtures.js"
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const fixtures = path.join(import.meta.dirname, 'fixtures')
const asUrl = pathToFileURL(fixtures)
```

On Windows, `import.meta.url` looks like `file:///C:/app/src/x.js` — passing that string to `path.join` produces nonsense. `import.meta.dirname` and `fileURLToPath` are the correct conversions. Most `fs` functions also accept a `URL` object directly.

## Watching files

`fs.watch` is thin wrapping over the platform's notification API, and the differences leak:

- Events are **not** guaranteed to be one-per-change. Editors that save atomically (write temp + rename) produce a `rename` event, not `change`, and often several events.
- `filename` may be `null` on some platforms and events.
- `{ recursive: true }` is supported on Windows and macOS, and on Linux from Node 20 — but a deep tree on Linux consumes one inotify watch per directory and hits `ENOSPC` when the system limit is reached.
- Watching a file that is replaced by rename stops delivering events, because the watch follows the inode, not the name. Watch the **directory** instead.

```js title="src/reload.js"
import { watch } from 'node:fs/promises'

const controller = new AbortController()
try {
  for await (const event of watch('config', { signal: controller.signal })) {
    if (event.filename?.endsWith('.json')) await reload()
  }
} catch (err) {
  if (err.name !== 'AbortError') throw err
}
```

Debounce the handler — a single save commonly fires two or three events, and reloading three times is at best wasteful.

:::tip
For restarting a development server, do not build this yourself: `node --watch src/server.js` is built in and handles the debouncing and the restart. See [Debugging](./debugging.md).
:::

`fs.watchFile` uses `stat` polling instead. It is slower and burns CPU, but it works on network filesystems where inotify does not.

## Atomic writes

`writeFile` truncates the target and then writes. A crash — or a reader arriving mid-write — sees a truncated or half-written file. On a POSIX filesystem, `rename` within the same filesystem is atomic, so write to a temporary file next to the target and rename over it:

```js title="src/atomic.js"
import { open, rename, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

export async function writeAtomic(target, contents) {
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`)
  const handle = await open(tmp, 'wx')          // 'wx' fails if it somehow exists
  try {
    await handle.writeFile(contents)
    await handle.sync()                          // flush to disk before the rename
  } finally {
    await handle.close()
  }
  try {
    await rename(tmp, target)
  } catch (err) {
    await unlink(tmp).catch(() => {})
    throw err
  }
}
```

The temporary file must be in the **same directory** as the target. `/tmp` is frequently a different filesystem, and `rename` across filesystems fails with `EXDEV`. `handle.sync()` is what makes the content durable before the name flips; without it, a power loss can leave the new name pointing at empty content.

## Common patterns

### Temporary directories

```js title="src/scratch.js"
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const dir = await mkdtemp(path.join(tmpdir(), 'report-'))
try {
  // ... work in `dir`
} finally {
  await rm(dir, { recursive: true, force: true })
}
```

`mkdtemp` appends random characters and creates the directory in one step, so there is no window in which another process can predict and pre-create the name.

### Walking a tree

```js title="src/walk.js"
import { readdir } from 'node:fs/promises'
import path from 'node:path'

export async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(full)
    else if (entry.isFile()) yield full
  }
}
```

`withFileTypes` avoids a `stat` syscall per entry, which is the difference between fast and unusable on a large tree. `readdir` also accepts `{ recursive: true }` if you do not need the generator's laziness.

### Close what you open

Every `open()` returns a `FileHandle` that holds a file descriptor until you `close()` it. Leaked descriptors accumulate until the process hits `EMFILE: too many open files` — usually hours into production, never in a test. Use `try/finally`, or prefer `readFile`/`writeFile`/`pipeline`, which close for you.

## Common mistakes

- **Joining user input into a path without a containment check.** Directory traversal, straight to `/etc/passwd`.
- **Believing `path.join` sanitizes.** It normalizes `..`, it does not reject it. `path.resolve` plus an explicit prefix test is the check.
- **`startsWith(root)` without `path.sep`.** `/srv/uploads-evil` passes.
- **Ignoring symlinks in a user-writable directory.** Resolve with `realpath` and re-check.
- **`access()` before `readFile()`.** A TOCTOU race, and an extra syscall. Just read and handle `ENOENT`.
- **`readFile` without an encoding when you wanted a string.** You get a `Buffer` and `+` concatenation quietly produces `[object Object]`-flavored surprises.
- **Sync `fs` calls in a request handler.** Blocks every other request.
- **Writing config or state with a plain `writeFile`.** A crash leaves a truncated file. Write temp + `sync` + `rename`.
- **Putting the temp file in `/tmp` and renaming.** `EXDEV` across filesystems.
- **Trusting `fs.watch` to fire exactly once.** Debounce, and watch the directory rather than a file that gets replaced.
- **Using `path.join` to build URL paths or S3 keys.** Use `path.posix`.

## Related topics

- [Streams and buffers](./streams-and-buffers.md) — `createReadStream`, and streaming a file to a response.
- [ESM vs CommonJS](./esm-vs-commonjs.md) — `import.meta.dirname` and `fileURLToPath`.
- [Runtime and the event loop](./runtime-and-event-loop.md) — why `fs` uses the libuv threadpool and sync calls hurt.
- [File upload security](../security/file-upload-security.md) — filenames, content types, and storage layout for untrusted files.
- [Secrets management](../security/secrets-management.md) — keeping key material out of readable files.
- [Static files](../express/static-files.md) — serving a directory safely with `express.static`.
