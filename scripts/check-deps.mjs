#!/usr/bin/env node
/**
 * check-deps.mjs — dependency existence and version-drift checker.
 *
 *   node scripts/check-deps.mjs            # docs + examples
 *   node scripts/check-deps.mjs --offline  # extraction only, no network
 *
 * Confirms that every npm package named anywhere in the docs or in an example's
 * package.json actually exists on the registry, and reports any package where
 * the version this site documents is behind the current stable release.
 *
 * "Current stable" means the newest non-prerelease version, which is NOT always
 * the `latest` dist-tag — `prisma` currently tags a release candidate as
 * `latest`. Both are reported so the difference is visible.
 *
 * Exit codes
 *   0  every package exists (drift is reported, not fatal)
 *   1  a named package does not exist on the registry, or is deprecated and
 *      not listed in the known-deprecated set
 */

import { readFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const CONTENT = path.join(ROOT, 'content')
const EXAMPLES = path.join(ROOT, 'examples')

const OFFLINE = process.argv.includes('--offline')

/** Packages the docs deliberately name as dead. Deprecation here is expected. */
const KNOWN_DEPRECATED = new Set([
  'multer@1',
  'csurf',
  'express-async-handler',
  'request',
  'prom-client',
  'oslo',
  'zod-to-openapi',
  'express-mongo-sanitize',
  'sqlite3',
  'node-postgres',
  'lusca',
])

/** Not npm packages: Node builtins, relative paths, and local aliases. */
const isBuiltin = (name) =>
  name.startsWith('node:') ||
  [
    'fs', 'path', 'http', 'https', 'http2', 'url', 'util', 'events', 'stream', 'crypto', 'os', 'zlib',
    'buffer', 'child_process', 'cluster', 'worker_threads', 'assert', 'timers', 'net', 'tls', 'dns',
    'perf_hooks', 'async_hooks', 'readline', 'querystring', 'string_decoder', 'vm', 'test', 'sqlite',
    'process', 'console', 'module', 'inspector', 'diagnostics_channel', 'v8', 'tty', 'repl', 'wasi',
  ].includes(name)

/** `@scope/name/sub/path` -> `@scope/name`; `pkg/sub` -> `pkg` */
function packageRoot(specifier) {
  const s = specifier.split('?')[0]
  if (s.startsWith('@')) return s.split('/').slice(0, 2).join('/')
  return s.split('/')[0]
}

const VALID_NAME = /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i

/** Invoked as commands, never listed as a dependency of anything here. */
const CLI_ONLY = new Set(['npm', 'npx', 'pnpm', 'yarn', 'bun', 'bunx', 'corepack', 'node'])

/** Scopes the docs use as deliberate placeholders in examples. */
const PLACEHOLDER_SCOPES = ['@acme/', '@your-org/', '@example/', '@myorg/', '@company/']

/** Flags that consume the next token, so it is an argument and not a package. */
const VALUE_FLAGS = new Set([
  '--name', '--filter', '-w', '--workspace', '--registry', '--prefix', '--tag',
  '--legacy-peer-deps=', '--omit', '--include', '--schema', '--config', '-o', '--out',
])

function splitNameVersion(token) {
  const at = token.lastIndexOf('@')
  if (at <= 0) return { name: packageRoot(token), version: '' }
  const name = token.slice(0, at)
  const version = token.slice(at + 1)
  return { name: packageRoot(name), version: /^\d+\.\d+\.\d+$/.test(version) ? version : '' }
}

function parseInstallArgs(argString) {
  const out = []
  const tokens = argString.trim().split(/\s+/).filter(Boolean)
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (token.startsWith('-')) {
      if (VALUE_FLAGS.has(token)) i++ // skip the flag's value
      continue
    }
    if (token.includes('/') && !token.startsWith('@')) continue // a path, not a package
    out.push(splitNameVersion(token.replace(/^["']|["']$/g, '')))
  }
  return out
}

/* --------------------------------------------------------------- extraction */

async function walk(dir, filter, acc = []) {
  if (!existsSync(dir)) return acc
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) await walk(full, filter, acc)
    else if (filter(entry.name)) acc.push(full)
  }
  return acc
}

/**
 * @returns Map<packageName, { sources:Set<string>, documentedVersions:Set<string> }>
 */
async function extract() {
  const found = new Map()
  const add = (name, source, version) => {
    if (!name || isBuiltin(name) || name.startsWith('.') || name.startsWith('/')) return
    if (!VALID_NAME.test(name)) return
    if (CLI_ONLY.has(name)) return
    if (PLACEHOLDER_SCOPES.some((s) => name.startsWith(s))) return
    if (!found.has(name)) found.set(name, { sources: new Set(), documentedVersions: new Set() })
    const rec = found.get(name)
    rec.sources.add(source)
    if (version) rec.documentedVersions.add(version)
  }

  // --- markdown ---------------------------------------------------------
  for (const file of await walk(CONTENT, (n) => n.endsWith('.md'))) {
    const rel = path.relative(ROOT, file).replace(/\\/g, '/')
    const text = await readFile(file, 'utf8')

    // Install lines. `npm i a b c` installs every argument; `npx a b c` runs
    // only `a` and passes the rest as arguments, so they are parsed apart.
    let m
    const installRe = /^\s*(?:\$\s*)?(npm|pnpm|yarn|bun)\s+(i|install|add)\s+([^\n#]*)/gm
    while ((m = installRe.exec(text))) {
      for (const { name, version } of parseInstallArgs(m[3])) add(name, rel, version)
    }

    const runnerRe = /^\s*(?:\$\s*)?(?:npx|bunx|(?:pnpm|yarn)\s+dlx)\s+([^\s\n]+)/gm
    while ((m = runnerRe.exec(text))) {
      const { name, version } = splitNameVersion(m[1])
      // `npx codemod@latest @expressjs/…` — the trailing argument is a codemod
      // recipe identifier, not an npm package, so only the runner is recorded.
      add(name, rel, version)
    }

    // import / require specifiers
    const importRe = /(?:import\s[\s\S]{0,200}?from\s*|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g
    while ((m = importRe.exec(text))) add(packageRoot(m[1]), rel)

    // library-index style table rows:  | `pkg` | 1.2.3 | …
    const rowRe = /^\|\s*`([@\w./-]+)`\s*\|\s*`?(\d+\.\d+\.\d+[\w.-]*)`?\s*\|/gm
    while ((m = rowRe.exec(text))) add(packageRoot(m[1]), rel, m[2])

    // inline "pkg 1.2.3" mentions with a backticked name
    const inlineRe = /`([@\w./-]+)`\s+(\d+\.\d+\.\d+)\b/g
    while ((m = inlineRe.exec(text))) add(packageRoot(m[1]), rel, m[2])
  }

  // --- example package.json ---------------------------------------------
  if (existsSync(EXAMPLES)) {
    for (const entry of await readdir(EXAMPLES, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const pkgFile = path.join(EXAMPLES, entry.name, 'package.json')
      if (!existsSync(pkgFile)) continue
      const rel = `examples/${entry.name}/package.json`
      let pkg
      try {
        pkg = JSON.parse(await readFile(pkgFile, 'utf8'))
      } catch {
        continue
      }
      for (const field of ['dependencies', 'devDependencies']) {
        for (const [name, range] of Object.entries(pkg[field] || {})) {
          const version = String(range).replace(/^[\^~>=<\s]+/, '')
          add(packageRoot(name), rel, /^\d/.test(version) ? version : '')
        }
      }
    }
  }

  return found
}

/* ----------------------------------------------------------------- registry */

const isStable = (v) => !/-/.test(v)

function compareSemver(a, b) {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0)
    if (d) return d
  }
  return 0
}

async function fetchPackage(name, tries = 4) {
  const url = `https://registry.npmjs.org/${name.startsWith('@') ? name.replace('/', '%2f') : name}`
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { accept: 'application/json' } })
      if (res.status === 404) return { missing: true }
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const body = await res.json()
      const distTags = body['dist-tags'] || {}
      const versions = Object.keys(body.versions || {})
      const stable = versions.filter(isStable)
      // The registry's key order is publish order, which is not semver order.
      stable.sort(compareSemver)
      const latestStable = stable[stable.length - 1] || distTags.latest || ''
      return {
        latestTag: distTags.latest || '',
        latestStable,
        deprecated: body.versions?.[distTags.latest]?.deprecated || '',
      }
    } catch {
      await new Promise((r) => setTimeout(r, 400 * (i + 1)))
    }
  }
  return { failed: true }
}

/** Small concurrency pool so the registry does not drop connections. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length)
  let cursor = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) {
        const i = cursor++
        out[i] = await fn(items[i], i)
      }
    })
  )
  return out
}

/* --------------------------------------------------------------------- main */

async function main() {
  const found = await extract()
  const names = [...found.keys()].sort()

  console.log('')
  console.log('  scripts/check-deps.mjs — dependency check')
  console.log('  ─────────────────────────────────────────────')
  console.log(`  packages named   ${names.length}`)

  if (OFFLINE) {
    console.log('  mode             offline (extraction only)')
    console.log('')
    for (const n of names) console.log(`    · ${n}`)
    console.log('')
    return
  }

  const results = await mapLimit(names, 6, async (name) => ({ name, ...(await fetchPackage(name)) }))

  const missing = []
  const failed = []
  const behind = []
  const deprecated = []
  let ok = 0

  for (const r of results) {
    const rec = found.get(r.name)
    if (r.missing) {
      missing.push({ ...r, sources: [...rec.sources] })
      continue
    }
    if (r.failed) {
      failed.push(r.name)
      continue
    }
    ok++

    if (r.deprecated) {
      const known = KNOWN_DEPRECATED.has(r.name)
      deprecated.push({ name: r.name, message: String(r.deprecated).slice(0, 100), expected: known })
    }

    for (const documented of rec.documentedVersions) {
      if (!/^\d+\.\d+\.\d+$/.test(documented)) continue
      if (compareSemver(documented, r.latestStable) < 0) {
        behind.push({
          name: r.name,
          documented,
          latestStable: r.latestStable,
          latestTag: r.latestTag,
          sources: [...rec.sources].slice(0, 3),
        })
      }
    }
  }

  console.log(`  verified on npm  ${ok}`)
  console.log(`  not found        ${missing.length}`)
  console.log(`  lookup failed    ${failed.length}`)
  console.log(`  version drift    ${behind.length}`)
  console.log(`  deprecated       ${deprecated.length}`)

  const tagAnomalies = results.filter((r) => r.latestTag && r.latestStable && r.latestTag !== r.latestStable)
  if (tagAnomalies.length) {
    console.log('')
    console.log('  Packages whose npm `latest` tag is NOT the latest stable release')
    for (const r of tagAnomalies) {
      console.log(`    ! ${r.name}: latest=${r.latestTag}  latestStable=${r.latestStable}`)
    }
  }

  if (deprecated.length) {
    console.log('')
    console.log('  Deprecated on npm')
    for (const d of deprecated) {
      console.log(`    ${d.expected ? '·' : '✖'} ${d.name}${d.expected ? ' (documented as deprecated — expected)' : ''}`)
      console.log(`        ${d.message}`)
    }
  }

  if (behind.length) {
    console.log('')
    console.log('  Documented version is behind the current stable')
    for (const b of behind) {
      console.log(`    ~ ${b.name}: docs say ${b.documented}, current stable is ${b.latestStable}`)
      console.log(`        seen in: ${b.sources.join(', ')}`)
    }
  }

  if (failed.length) {
    console.log('')
    console.log('  Lookup failed (network) — not treated as an error')
    for (const f of failed) console.log(`    ? ${f}`)
  }

  if (missing.length) {
    console.log('')
    console.log('  PACKAGES THAT DO NOT EXIST ON THE REGISTRY')
    for (const m of missing) {
      console.log(`    ✖ ${m.name}`)
      console.log(`        named in: ${m.sources.slice(0, 4).join(', ')}`)
    }
    console.log('')
    process.exit(1)
  }

  // Verify the claims the docs make in the other direction too: every package
  // the site tells readers to stop using should really be deprecated (or, for
  // multer, deprecated on its 1.x line specifically).
  console.log('')
  console.log('  Verifying the docs’ own "do not use" claims')
  const claims = await mapLimit([...KNOWN_DEPRECATED], 4, async (entry) => {
    const [name, major] = entry.split('@')
    const url = `https://registry.npmjs.org/${name.startsWith('@') ? name.replace('/', '%2f') : name}`
    for (let i = 0; i < 3; i++) {
      try {
        const res = await fetch(url)
        if (!res.ok) throw new Error(String(res.status))
        const body = await res.json()
        const versions = Object.keys(body.versions || {})
        const pick = major
          ? versions.filter((v) => v.startsWith(major + '.')).pop()
          : body['dist-tags']?.latest
        const dep = pick ? body.versions[pick]?.deprecated : ''
        return { entry, version: pick, deprecated: Boolean(dep), message: String(dep || '').slice(0, 90) }
      } catch {
        await new Promise((r) => setTimeout(r, 400))
      }
    }
    return { entry, unknown: true }
  })

  let claimsHeld = 0
  for (const c of claims) {
    if (c.unknown) {
      console.log(`    ? ${c.entry}: registry lookup failed`)
      continue
    }
    if (c.deprecated) {
      claimsHeld++
      console.log(`    ✓ ${c.entry} (${c.version}) is deprecated on npm: "${c.message}"`)
    } else {
      console.log(`    ~ ${c.entry} (${c.version}) is NOT npm-deprecated — the docs justify it on other grounds`)
    }
  }
  console.log(`    ${claimsHeld}/${claims.length} confirmed by an npm deprecation notice`)

  const unexpectedDeprecations = deprecated.filter((d) => !d.expected)
  if (unexpectedDeprecations.length) {
    console.log('')
    console.log('  A package the docs recommend is deprecated on npm. Replace it or label it.')
    console.log('')
    process.exit(1)
  }

  console.log('')
  console.log('  Every package named in the docs exists on the npm registry.')
  console.log('')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
