#!/usr/bin/env node
/**
 * lint-sql.mjs — the highest-value check in the repository.
 *
 *   node scripts/lint-sql.mjs
 *
 * Scans every fenced code block in content/ and every JS/TS source file in
 * examples/ for SQL assembled by string concatenation or template
 * interpolation, and fails unless the code is explicitly marked as a
 * deliberate vulnerable demonstration.
 *
 * The point is that these docs can never ship an injectable example by
 * accident: a snippet is either parameterised, or it is loudly labelled.
 *
 * Exemptions (CONTRIBUTING.md §7)
 *   1. the fence info string contains `vulnerable`
 *   2. the example file lives under a `vulnerable-` prefixed example directory
 *   3. the offending line, or the line above it, carries `// lint-sql:allow`
 *      followed by a justification (used for allow-listed identifiers)
 */

import { readFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const CONTENT = path.join(ROOT, 'content')
const EXAMPLES = path.join(ROOT, 'examples')

/* ------------------------------------------------------------- detection */

/** Words that make a string look like SQL rather than prose. */
const SQL_START =
  /\b(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM|CREATE\s+(TABLE|INDEX|VIEW|DATABASE|SCHEMA)|DROP\s+(TABLE|INDEX|VIEW|DATABASE|SCHEMA)|ALTER\s+TABLE|TRUNCATE|GRANT|REVOKE|WITH\s+\w+\s+AS)\b/i
/** Clause keywords that confirm a fragment is SQL. */
const SQL_CLAUSE = /\b(FROM|WHERE|VALUES|SET|JOIN|ORDER\s+BY|GROUP\s+BY|LIMIT|OFFSET|RETURNING|HAVING|INTO|ON\s+CONFLICT)\b/i

const ALLOW_MARKER = 'lint-sql:allow'

/**
 * Tagged templates whose tag parameterises every `${}` it receives, so
 * interpolation inside them is not injection. These are the documented safe
 * escape hatches:
 *
 *   sql`…`                 Drizzle, Kysely, postgres.js
 *   Prisma.sql`…`          Prisma fragment builder
 *   prisma.$queryRaw`…`    Prisma tagged raw query
 *   tx.$executeRaw`…`      Prisma tagged raw command
 *
 * Deliberately NOT here: `sql.raw()`, `Prisma.raw()`, `$queryRawUnsafe()` and
 * `$executeRawUnsafe()`. Those are ordinary calls, so their template argument
 * has no tag and stays flagged — which is exactly right.
 */
const SAFE_TAG_SUFFIXES = ['sql', '$queryraw', '$executeraw']

/** Reads the tag of a template literal that starts at `backtickIndex`, if any. */
function tagBefore(source, backtickIndex) {
  let k = backtickIndex - 1
  while (k >= 0 && /\s/.test(source[k])) k--
  if (k < 0) return null

  // A TypeScript type argument list can sit between the tag and the template:
  //   prisma.$queryRaw<Array<{ id: number }>>`SELECT …`
  // Walk back over the balanced <…> so the tag itself is still found.
  if (source[k] === '>') {
    let depth = 0
    while (k >= 0) {
      if (source[k] === '>') depth++
      else if (source[k] === '<') {
        depth--
        if (depth === 0) {
          k--
          break
        }
      }
      k--
    }
    while (k >= 0 && /\s/.test(source[k])) k--
    if (k < 0) return null
  }

  if (!/[\w$]/.test(source[k])) return null
  let end = k + 1
  while (k >= 0 && /[\w$.]/.test(source[k])) k--
  const tag = source.slice(k + 1, end)
  return tag || null
}

function isSafeTag(tag) {
  if (!tag) return false
  const lower = tag.toLowerCase()
  return SAFE_TAG_SUFFIXES.some((suffix) => lower === suffix || lower.endsWith('.' + suffix))
}

/**
 * Returns the findings inside a chunk of JS/TS source.
 *
 * Two shapes are flagged:
 *   A) a template literal that contains `${` and looks like SQL
 *   B) a quoted string that looks like SQL adjacent to a `+` concatenation
 */
function findInjectableSql(source, { originLabel }) {
  const findings = []
  const lines = source.split('\n')

  const allowedAt = (lineIndex) => {
    const here = lines[lineIndex] ?? ''
    const above = lines[lineIndex - 1] ?? ''
    const above2 = lines[lineIndex - 2] ?? ''
    return here.includes(ALLOW_MARKER) || above.includes(ALLOW_MARKER) || above2.includes(ALLOW_MARKER)
  }

  // --- A) interpolated template literals ---------------------------------
  // Scan manually so nested `${...}` and escapes are handled properly.
  for (let i = 0; i < source.length; i++) {
    if (source[i] !== '`') continue
    let j = i + 1
    let depth = 0
    let hasInterpolation = false
    while (j < source.length) {
      const c = source[j]
      if (c === '\\') {
        j += 2
        continue
      }
      if (depth === 0 && c === '`') break
      if (c === '$' && source[j + 1] === '{') {
        hasInterpolation = true
        depth++
        j += 2
        continue
      }
      if (depth > 0 && c === '}') depth--
      j++
    }
    const literal = source.slice(i + 1, j)
    if (hasInterpolation && SQL_START.test(literal) && SQL_CLAUSE.test(literal)) {
      const lineIndex = source.slice(0, i).split('\n').length - 1
      if (!isSafeTag(tagBefore(source, i)) && !allowedAt(lineIndex)) {
        findings.push({
          line: lineIndex + 1,
          kind: 'template-literal',
          snippet: literal.replace(/\s+/g, ' ').trim().slice(0, 110),
          origin: originLabel,
        })
      }
    }
    i = j
  }

  // --- B) quoted-string concatenation -------------------------------------
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!/\+/.test(line)) continue
    // A quoted string with SQL in it, joined to something with `+`.
    const re = /(['"])((?:\\.|(?!\1)[^\\])*)\1\s*\+|\+\s*(['"])((?:\\.|(?!\3)[^\\])*)\3/g
    let m
    let flagged = false
    while ((m = re.exec(line))) {
      const text = m[2] ?? m[4] ?? ''
      if (SQL_START.test(text) || (SQL_CLAUSE.test(text) && /['"]\s*\+|\+\s*['"]/.test(line))) {
        // Only flag when the surrounding statement really looks like SQL.
        const context = [lines[i - 1] ?? '', line, lines[i + 1] ?? ''].join(' ')
        if (SQL_START.test(context) && SQL_CLAUSE.test(context)) {
          flagged = true
          break
        }
      }
    }
    if (flagged && !allowedAt(i)) {
      findings.push({
        line: i + 1,
        kind: 'string-concatenation',
        snippet: line.trim().slice(0, 110),
        origin: originLabel,
      })
    }
  }

  return findings
}

/* ---------------------------------------------------------------- sources */

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
        out.push({ info: open.info, lang: open.lang, code: buffer.join('\n'), startLine })
        open = null
        buffer = []
        continue
      }
      buffer.push(lines[i])
      continue
    }
    if (m) {
      const info = m[3].trim()
      open = { marker: m[2], info, lang: (info.split(/\s+/)[0] || '').toLowerCase() }
      startLine = i + 1
    }
  }
  return out
}

async function walk(dir, filter, acc = []) {
  if (!existsSync(dir)) return acc
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) await walk(full, filter, acc)
    else if (filter(entry.name)) acc.push(full)
  }
  return acc
}

/* -------------------------------------------------------------------- main */

const CODE_LANGS = new Set(['js', 'javascript', 'ts', 'typescript', 'mjs', 'cjs', 'jsx', 'tsx', 'node'])

async function main() {
  const violations = []
  const exempted = []
  let fencesScanned = 0
  let filesScanned = 0

  // --- content/ fences ----------------------------------------------------
  const mdFiles = await walk(CONTENT, (n) => n.endsWith('.md'))
  for (const file of mdFiles) {
    const rel = path.relative(ROOT, file).replace(/\\/g, '/')
    const source = await readFile(file, 'utf8')
    for (const fence of extractFences(source)) {
      if (!CODE_LANGS.has(fence.lang) && fence.lang !== 'sql') continue
      fencesScanned++

      const isVulnerableDemo = /(^|\s)vulnerable(\s|$)/.test(fence.info)
      const findings =
        fence.lang === 'sql'
          ? [] // a bare SQL fence has no host language doing the interpolation
          : findInjectableSql(fence.code, { originLabel: `${rel}:${fence.startLine}` })

      if (!findings.length) continue
      if (isVulnerableDemo) {
        exempted.push({ file: rel, line: fence.startLine, reason: 'fence marked `vulnerable`', count: findings.length })
        continue
      }
      for (const f of findings) {
        violations.push({
          file: rel,
          line: fence.startLine + f.line,
          kind: f.kind,
          snippet: f.snippet,
          context: 'fenced code block',
        })
      }
    }
  }

  // --- examples/ source files ---------------------------------------------
  const srcFiles = await walk(EXAMPLES, (n) => /\.(mjs|cjs|js|ts|mts|cts)$/.test(n))
  for (const file of srcFiles) {
    const rel = path.relative(ROOT, file).replace(/\\/g, '/')
    filesScanned++
    const source = await readFile(file, 'utf8')
    const findings = findInjectableSql(source, { originLabel: rel })
    if (!findings.length) continue

    const inVulnerableDir = rel.split('/').some((seg) => seg.startsWith('vulnerable-'))
    if (inVulnerableDir) {
      exempted.push({ file: rel, line: 0, reason: 'directory is a `vulnerable-*` teaching example', count: findings.length })
      continue
    }
    for (const f of findings) {
      violations.push({ file: rel, line: f.line, kind: f.kind, snippet: f.snippet, context: 'example source' })
    }
  }

  /* ------------------------------------------------------------- report */

  console.log('')
  console.log('  scripts/lint-sql.mjs — SQL injection lint')
  console.log('  ─────────────────────────────────────────────')
  console.log(`  markdown files   ${mdFiles.length}`)
  console.log(`  code fences      ${fencesScanned}`)
  console.log(`  example sources  ${filesScanned}`)
  console.log(`  exempt blocks    ${exempted.length}`)
  console.log(`  violations       ${violations.length}`)

  if (exempted.length) {
    console.log('')
    console.log('  Exempt (deliberate demonstrations)')
    for (const e of exempted) {
      console.log(`    · ${e.file}${e.line ? ':' + e.line : ''} — ${e.reason} (${e.count} finding${e.count === 1 ? '' : 's'})`)
    }
  }

  if (violations.length) {
    console.log('')
    console.log('  VIOLATIONS — SQL built by interpolation/concatenation without a marker')
    for (const v of violations) {
      console.log(`    ✖ ${v.file}:${v.line} [${v.kind}] in ${v.context}`)
      console.log(`        ${v.snippet}`)
    }
    console.log('')
    console.log('  Fix by parameterising the query, or — if this is deliberate teaching')
    console.log('  material — mark the fence `vulnerable`, or add `// lint-sql:allow <why>`')
    console.log('  for an identifier you have already validated against an allow-list.')
    console.log('')
    process.exit(1)
  }

  console.log('')
  console.log('  No unmarked SQL string-building found.')
  console.log('')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
