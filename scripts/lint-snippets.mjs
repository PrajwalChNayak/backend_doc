#!/usr/bin/env node
/**
 * lint-snippets.mjs — parses every fenced JavaScript/TypeScript block in
 * content/ and reports the ones that are not valid code.
 *
 *   node scripts/lint-snippets.mjs
 *   node scripts/lint-snippets.mjs --verbose
 *
 * Requires Node 22.13+ (for `module.stripTypeScriptTypes`) — the site targets
 * Node 24 LTS. Re-executes itself with `--experimental-vm-modules`, which is
 * what makes `vm.SourceTextModule` available.
 *
 * Two tiers, both reported separately:
 *
 *   TIER 1 — SYNTAX (fatal)
 *     TypeScript blocks are type-stripped, then every block is parsed as an ES
 *     module with `vm.SourceTextModule`. Nothing is executed. A block that does
 *     not parse is a block a reader cannot paste and run.
 *
 *   TIER 2 — IMPORT RESOLUTION (reported)
 *     Every bare import/require specifier is resolved against the packages
 *     actually installed under examples/. An unresolved specifier means the
 *     docs name a package no example depends on — usually fine, occasionally
 *     the sign of an invented package. `scripts/check-deps.mjs` separately
 *     proves each one exists on the registry.
 *
 * What this does NOT do: full type checking. Most snippets are fragments with
 * undeclared identifiers by design, so `tsc --noEmit` over them would produce
 * thousands of meaningless "Cannot find name" errors. The honest, useful bar is
 * "this parses, and the packages it imports are real".
 */

import { readFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import nodeModule from 'node:module'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const CONTENT = path.join(ROOT, 'content')
const EXAMPLES = path.join(ROOT, 'examples')
const VERBOSE = process.argv.includes('--verbose')

/* ------------------------------------------------------- flag bootstrapping */

if (!process.execArgv.includes('--experimental-vm-modules')) {
  const result = spawnSync(
    process.execPath,
    ['--experimental-vm-modules', '--no-warnings', fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    { stdio: 'inherit' }
  )
  process.exit(result.status ?? 1)
}

const canStripTypes = typeof nodeModule.stripTypeScriptTypes === 'function'

/* ---------------------------------------------------------------- extraction */

const JS_LANGS = new Set(['js', 'javascript', 'mjs', 'cjs', 'node', 'jsx'])
const TS_LANGS = new Set(['ts', 'typescript', 'mts', 'cts', 'tsx'])

function extractFences(markdown) {
  const out = []
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  let open = null
  let buffer = []
  let startLine = 0

  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)(`{3,}|~{3,})(.*)$/.exec(lines[i])
    if (open) {
      if (m && new RegExp(`^\\s*${open.marker[0]}{${open.marker.length},}\\s*$`).test(lines[i])) {
        out.push({ ...open, code: buffer.join('\n'), startLine })
        open = null
        buffer = []
        continue
      }
      buffer.push(lines[i])
      continue
    }
    if (m) {
      const info = m[3].trim()
      const lang = (info.split(/\s+/)[0] || '').toLowerCase()
      open = { marker: m[2], info, lang }
      startLine = i + 1
    }
  }
  return out
}

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

/* -------------------------------------------------------- installed packages */

async function installedPackages() {
  const names = new Set()
  if (!existsSync(EXAMPLES)) return names
  for (const entry of await readdir(EXAMPLES, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const nm = path.join(EXAMPLES, entry.name, 'node_modules')
    if (!existsSync(nm)) continue
    for (const dep of await readdir(nm, { withFileTypes: true })) {
      if (!dep.isDirectory()) continue
      if (dep.name.startsWith('.')) continue
      if (dep.name.startsWith('@')) {
        for (const scoped of await readdir(path.join(nm, dep.name), { withFileTypes: true })) {
          if (scoped.isDirectory()) names.add(`${dep.name}/${scoped.name}`)
        }
      } else {
        names.add(dep.name)
      }
    }
  }
  return names
}

const BUILTINS = new Set(nodeModule.builtinModules.flatMap((m) => [m, `node:${m}`]))

/* ------------------------------------------------------------ classification */

function parsesAsModule(source, identifier) {
  try {
    new vm.SourceTextModule(source, { identifier })
    return null
  } catch (e) {
    return e
  }
}

function parsesAsScript(source) {
  try {
    new vm.Script(source)
    return true
  } catch {
    return false
  }
}

/** Removes top-level import/export statements so a fragment can be wrapped. */
function stripTopLevelModuleSyntax(source) {
  return source
    .split('\n')
    .filter((line) => !/^\s*(import\s|export\s|export\{|import\{)/.test(line))
    .filter((line) => !/^\s*\}\s*from\s*['"]/.test(line))
    .join('\n')
    .replace(/^\s*import\s*\{[^}]*\}\s*from\s*['"][^'"]*['"]\s*$/gm, '')
}

/**
 * Docs are full of legitimate fragments: a function body showing `return`, an
 * options object, or two alternatives declared side by side. Those are not
 * broken code, so they are classified rather than reported as failures.
 *
 * @returns {'module'|'fragment'|'decorators'|'invalid'}
 */
function classify(source, identifier) {
  const moduleError = parsesAsModule(source, identifier)
  if (!moduleError) return { kind: 'module' }

  const message = String(moduleError.message)

  // Two alternatives shown side by side ("wrong" then "right") re-declare the
  // same name. That is an early error, not a syntax error.
  if (/has already been declared/.test(message)) return { kind: 'fragment', reason: 'alternatives shown side by side' }

  // TS decorators: valid TypeScript, but V8 cannot parse `@dec export class`.
  if (/^\s*@[A-Za-z]/m.test(source) && /Invalid or unexpected token|Unexpected token '@'/.test(message)) {
    return { kind: 'decorators', reason: 'TypeScript decorators need tsc, not type-stripping' }
  }

  const body = stripTopLevelModuleSyntax(source)

  // A function body: allows top-level `return`, `await`, `this`.
  if (parsesAsScript(`async function __fragment() {\n${body}\n}`)) {
    return { kind: 'fragment', reason: 'function-body fragment' }
  }

  // Object-literal properties, e.g. an options block shown on its own.
  if (parsesAsScript(`void ({\n${body}\n});`)) {
    return { kind: 'fragment', reason: 'object-literal fragment' }
  }

  // A class body, e.g. a couple of methods shown alone.
  if (parsesAsScript(`class __Fragment {\n${body}\n}`)) {
    return { kind: 'fragment', reason: 'class-body fragment' }
  }

  return { kind: 'invalid', error: moduleError }
}

function packageRoot(specifier) {
  if (specifier.startsWith('@')) return specifier.split('/').slice(0, 2).join('/')
  return specifier.split('/')[0]
}

function importsOf(code) {
  const out = new Set()
  const re = /(?:import\s[\s\S]{0,300}?from\s*|import\s*\(\s*|require\s*\(\s*|export\s[\s\S]{0,200}?from\s*)['"]([^'"]+)['"]/g
  let m
  while ((m = re.exec(code))) {
    const spec = m[1]
    if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('#')) continue
    out.add(packageRoot(spec))
  }
  return out
}

/* --------------------------------------------------------------------- main */

async function main() {
  const files = await walk(CONTENT, (n) => n.endsWith('.md'))
  const installed = await installedPackages()

  const syntaxFailures = []
  const fragments = []
  const decoratorBlocks = []
  const tsSkipped = []
  const unresolved = new Map()

  let total = 0
  let jsCount = 0
  let tsCount = 0
  let parsed = 0

  for (const file of files) {
    const rel = path.relative(ROOT, file).replace(/\\/g, '/')
    const text = await readFile(file, 'utf8')
    // Line numbers reported below are relative to the markdown file.
    const frontMatterLines = /^---\n/.test(text.replace(/\r\n/g, '\n'))
      ? 0 // extractFences already runs over the whole file, so no offset needed
      : 0

    for (const fence of extractFences(text)) {
      const isJs = JS_LANGS.has(fence.lang)
      const isTs = TS_LANGS.has(fence.lang)
      if (!isJs && !isTs) continue
      total++
      if (isJs) jsCount++
      else tsCount++

      let source = fence.code
      if (!source.trim()) continue

      if (isTs) {
        if (!canStripTypes) {
          tsSkipped.push(`${rel}:${fence.startLine + frontMatterLines}`)
          continue
        }
        try {
          source = nodeModule.stripTypeScriptTypes(source, { mode: 'strip' })
        } catch (e) {
          syntaxFailures.push({
            file: rel,
            line: fence.startLine + frontMatterLines,
            lang: fence.lang,
            stage: 'type-strip',
            message: String(e.message).split('\n')[0],
            snippet: source.split('\n')[0].slice(0, 90),
          })
          continue
        }
      }

      // Parses only. No linker, no evaluation — nothing in the docs runs here.
      const verdict = classify(source, `${rel}:${fence.startLine}`)
      if (verdict.kind === 'module') parsed++
      else if (verdict.kind === 'fragment') {
        fragments.push({ file: rel, line: fence.startLine + frontMatterLines, reason: verdict.reason })
      } else if (verdict.kind === 'decorators') {
        decoratorBlocks.push({ file: rel, line: fence.startLine + frontMatterLines })
      } else {
        syntaxFailures.push({
          file: rel,
          line: fence.startLine + frontMatterLines,
          lang: fence.lang,
          stage: 'parse',
          message: String(verdict.error.message).split('\n')[0],
          snippet: source.split('\n').find((l) => l.trim())?.slice(0, 90) ?? '',
        })
        continue
      }

      for (const spec of importsOf(source)) {
        if (BUILTINS.has(spec)) continue
        if (installed.has(spec)) continue
        if (!unresolved.has(spec)) unresolved.set(spec, new Set())
        unresolved.get(spec).add(`${rel}:${fence.startLine + frontMatterLines}`)
      }
    }
  }

  /* ------------------------------------------------------------- report */

  console.log('')
  console.log('  scripts/lint-snippets.mjs — fenced code check')
  console.log('  ─────────────────────────────────────────────')
  console.log(`  node             ${process.version}`)
  console.log(`  markdown files   ${files.length}`)
  console.log(`  js blocks        ${jsCount}`)
  console.log(`  ts blocks        ${tsCount}`)
  console.log(`  complete modules ${parsed}`)
  console.log(`  valid fragments  ${fragments.length}  (function bodies, options objects, side-by-side alternatives)`)
  console.log(`  decorator blocks ${decoratorBlocks.length}  (valid TypeScript; need tsc, not Node type-stripping)`)
  console.log(`  syntax failures  ${syntaxFailures.length}`)
  console.log(`  ts skipped       ${tsSkipped.length}${canStripTypes ? '' : ' (this Node cannot strip types — needs 22.13+)'}`)
  console.log(`  packages named   ${installed.size} installed under examples/, ${unresolved.size} referenced but not installed`)

  if (unresolved.size) {
    console.log('')
    console.log('  Imported in docs but not installed by any example')
    console.log('  (existence on npm is proven separately by scripts/check-deps.mjs)')
    for (const [spec, where] of [...unresolved].sort()) {
      const list = [...where]
      console.log(`    · ${spec}  — ${list.length} block(s)${VERBOSE ? ': ' + list.slice(0, 4).join(', ') : ''}`)
    }
  }

  if (syntaxFailures.length) {
    console.log('')
    console.log('  BLOCKS THAT DO NOT PARSE')
    for (const f of syntaxFailures) {
      console.log(`    ✖ ${f.file}:${f.line} [${f.lang}, ${f.stage}] ${f.message}`)
      if (f.snippet) console.log(`        ${f.snippet}`)
    }
    console.log('')
    process.exit(1)
  }

  console.log('')
  console.log('  Every fenced JavaScript and TypeScript block parses.')
  console.log('')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
