#!/usr/bin/env node
/**
 * check.mjs — structural validator for content/.
 *
 *   node scripts/check.mjs
 *
 * Exits non-zero on any error. Warnings are reported but do not fail.
 *
 * Checks
 *   1.  front matter present and complete (title/description/status/updated)
 *   2.  front-matter title matches scripts/nav.mjs
 *   3.  no `# H1` in the body (the generator renders the title)
 *   4.  an overview paragraph before the first heading
 *   5.  required sections per CONTRIBUTING.md §4
 *   6.  `## Related topics` is the last heading on the page
 *   7.  every internal .md link resolves to a real page
 *   8.  every #anchor resolves to a real generated heading id
 *   9.  every ../../examples/... link resolves to a real file on disk
 *   10. orphan content files and missing nav files
 *   11. every code fence declares a language
 *   12. no Express 4 API outside a :::legacy / :::deprecated callout or the
 *       migration page
 */

import { readFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { sections, flatten, legacyExemptPages } from './nav.mjs'
import { parseFrontMatter, renderMarkdown } from './lib/markdown.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const CONTENT = path.join(ROOT, 'content')

const errors = []
const warnings = []
const err = (file, msg) => errors.push({ file, msg })
const warn = (file, msg) => warnings.push({ file, msg })

const REQUIRED_FRONT_MATTER = ['title', 'description', 'status', 'updated']
const VALID_STATUS = new Set(['current', 'legacy', 'deprecated'])

/** Sections whose pages must carry these headings. */
const SECTION_REQUIREMENTS = {
  security: ['## Common mistakes', '## Related topics'],
  'express-libraries': ['## Security considerations', '## Production considerations', '## Common mistakes', '## Related topics'],
  databases: ['## Security considerations', '## Production considerations', '## Common mistakes', '## Related topics'],
  orms: ['## Security considerations', '## Production considerations', '## Common mistakes', '## Related topics'],
}
const UNIVERSAL_REQUIREMENTS = ['## Common mistakes', '## Related topics']

/**
 * Express 4 APIs and dead packages. Each is a plain substring; matches inside a
 * :::legacy / :::deprecated callout, inside an inline-code span on a line that
 * also mentions Express 4, or on the migration page are allowed.
 */
const EXPRESS4_PATTERNS = [
  { needle: 'app.del(', label: 'app.del() was removed in Express 5 — use app.delete()' },
  { needle: 'req.param(', label: 'req.param() was removed in Express 5' },
  { needle: 'res.sendfile(', label: 'res.sendfile() was removed — use res.sendFile()' },
  { needle: 'express.static.mime', label: 'express.static.mime was removed — use the mime-types package' },
  { needle: "res.redirect('back')", label: "res.redirect('back') was removed" },
  { needle: 'res.redirect("back")', label: 'res.redirect("back") was removed' },
  { needle: "res.location('back')", label: "res.location('back') was removed" },
  { needle: 'express-async-handler', label: 'express-async-handler is unnecessary in Express 5' },
  { needle: "require('body-parser')", label: 'body-parser is bundled — use express.json()/express.urlencoded()' },
  { needle: "from 'body-parser'", label: 'body-parser is bundled — use express.json()/express.urlencoded()' },
  { needle: '.acceptsCharset(', label: 'req.acceptsCharset() was removed — use acceptsCharsets()' },
  { needle: '.acceptsEncoding(', label: 'req.acceptsEncoding() was removed — use acceptsEncodings()' },
  { needle: '.acceptsLanguage(', label: 'req.acceptsLanguage() was removed — use acceptsLanguages()' },
]

/**
 * Words that turn a mention into a warning rather than an endorsement.
 *
 * The rule this check enforces is "no Express 4 API is ever presented as
 * working code". Naming a dead package in prose in order to tell the reader to
 * stop using it is the opposite of that, and the library index, the deprecation
 * tables and the migration guide all need to do it. So a match in PROSE is
 * allowed when the same line also carries deprecation language; a match inside
 * a CODE FENCE is never allowed outside a :::legacy / :::deprecated callout.
 */
const DEPRECATION_LANGUAGE =
  /\b(deprecat\w*|removed|remove it|unnecessary|no longer|archived|unmaintained|obsolete|dead|delete it|drop it|dropped|do not use|don't use|never use|instead of|replaced?|superseded|stop using|end of life|EOL|was removed|bundled with)\b/i

/** Invalid Express 5 route patterns written as a real call. */
const BAD_ROUTE_PATTERNS = [
  { re: /\b(?:app|router)\.(?:get|post|put|patch|delete|all|use)\(\s*(['"`])\/\*\1/, label: "'/*' is invalid in Express 5 — use '/*splat' or '/{*splat}'" },
  { re: /\b(?:app|router)\.(?:get|post|put|patch|delete|all|use)\(\s*(['"`])[^'"`]*:\w+\?/, label: "optional ':param?' is invalid in Express 5 — use '{:param}' braces" },
  { re: /\b(?:app|router)\.(?:get|post|put|patch|delete|all|use)\(\s*(['"`])[^'"`]*\[[^\]]*\|/, label: 'regex-in-string paths are invalid in Express 5 — pass an array of paths' },
]

/* ---------------------------------------------------------------- scanning */

/**
 * Marks, for each line of a file, whether it sits inside a ::: callout of a
 * kind that legitimises legacy APIs, or inside a fenced block within one.
 */
function computeExemptLines(body) {
  const lines = body.split('\n')
  const exempt = new Array(lines.length).fill(false)
  const stack = []
  let fence = null

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const f = /^\s*(`{3,}|~{3,})/.exec(line)
    if (f) {
      if (fence && new RegExp(`^\\s*${fence[0]}{${fence.length},}\\s*$`).test(line)) fence = null
      else if (!fence) fence = f[1]
    }

    if (!fence) {
      const open = /^:::\s*([a-z-]+)/.exec(line.trim())
      const close = /^:::\s*$/.test(line.trim())
      if (open) {
        stack.push(open[1])
        exempt[i] = stack.some((k) => k === 'legacy' || k === 'deprecated')
        continue
      }
      if (close) {
        exempt[i] = stack.some((k) => k === 'legacy' || k === 'deprecated')
        stack.pop()
        continue
      }
    }
    exempt[i] = stack.some((k) => k === 'legacy' || k === 'deprecated')
  }
  return exempt
}

/** Per-line flag: true when the line sits inside a fenced code block. */
function fenceMask(body) {
  const lines = body.split('\n')
  const mask = new Array(lines.length).fill(false)
  let fence = null
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)(`{3,}|~{3,})(.*)$/.exec(lines[i])
    if (fence) {
      mask[i] = true // the closing fence line counts as code, not prose
      if (m && new RegExp(`^\\s*${fence[0]}{${fence.length},}\\s*$`).test(lines[i])) fence = null
      continue
    }
    if (m) {
      fence = m[2]
      mask[i] = true
    }
  }
  return mask
}

/**
 * Headings outside code fences. A `# comment` inside a bash fence is not a
 * heading, and treating it as one produced a whole class of false positives.
 */
function headingsOf(body) {
  const lines = body.split('\n')
  const mask = fenceMask(body)
  const out = []
  for (let i = 0; i < lines.length; i++) {
    if (mask[i]) continue
    if (/^#{1,6}\s/.test(lines[i])) out.push(lines[i].trim())
  }
  return out
}

function fenceLanguages(body) {
  const out = []
  const lines = body.split('\n')
  let open = null
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)(`{3,}|~{3,})(.*)$/.exec(lines[i])
    if (!m) continue
    if (open) {
      if (new RegExp(`^\\s*${open.marker[0]}{${open.marker.length},}\\s*$`).test(lines[i])) open = null
      continue
    }
    open = { marker: m[2] }
    out.push({ line: i + 1, info: m[3].trim() })
  }
  return out
}

function extractLinks(body) {
  const links = []
  const lines = body.split('\n')
  let fence = null
  for (let i = 0; i < lines.length; i++) {
    const f = /^\s*(`{3,}|~{3,})/.exec(lines[i])
    if (f) {
      if (fence && new RegExp(`^\\s*${fence[0]}{${fence.length},}\\s*$`).test(lines[i])) fence = null
      else if (!fence) fence = f[1]
      continue
    }
    if (fence) continue
    const stripped = lines[i].replace(/`[^`]*`/g, '')
    const re = /\[([^\]]+)\]\(([^)\s]+)/g
    let m
    while ((m = re.exec(stripped))) links.push({ line: i + 1, target: m[2] })
  }
  return links
}

/* -------------------------------------------------------------------- main */

async function main() {
  const order = flatten()
  const navByPath = new Map(order.map((p) => [p.path, p]))

  /**
   * Pages scanned for content rules. Orphans are appended below so that a file
   * missing from nav.mjs still has its code checked — otherwise the easiest way
   * to smuggle an Express 4 example into the repository would be to forget to
   * register the page.
   */
  const toScan = [...order]

  // --- orphan / missing --------------------------------------------------
  for (const section of sections) {
    const dir = path.join(CONTENT, section.id)
    if (!existsSync(dir)) {
      err(`content/${section.id}/`, 'section directory does not exist')
      continue
    }
    const files = (await readdir(dir, { withFileTypes: true }))
      .filter((e) => e.isFile() && e.name.endsWith('.md'))
      .map((e) => e.name.replace(/\.md$/, ''))
    const known = new Set(section.pages.map((p) => p.slug))
    for (const f of files) {
      if (!known.has(f)) {
        err(`content/${section.id}/${f}.md`, 'orphan page — not listed in scripts/nav.mjs')
        toScan.push({
          slug: f,
          title: null, // no nav title to compare against
          sectionId: section.id,
          sectionTitle: section.title,
          path: `${section.id}/${f}`,
          orphan: true,
        })
      }
      if (f !== f.toLowerCase() || /[^a-z0-9-]/.test(f)) err(`content/${section.id}/${f}.md`, 'filename must be kebab-case')
    }
    for (const p of section.pages) {
      if (!files.includes(p.slug)) err(`content/${section.id}/${p.slug}.md`, 'listed in nav.mjs but the file does not exist')
    }
  }

  // --- per page ----------------------------------------------------------
  /** path -> Set of heading ids, for anchor resolution */
  const anchorsByPath = new Map()
  const parsed = []

  for (const page of toScan) {
    const rel = `content/${page.sectionId}/${page.slug}.md`
    const abs = path.join(ROOT, rel)
    if (!existsSync(abs)) continue

    const raw = await readFile(abs, 'utf8')
    const { data, body, hadFrontMatter } = parseFrontMatter(raw)
    // Report line numbers relative to the file, not to the post-front-matter body.
    const lineOffset = raw.split('\n').length - body.split('\n').length

    if (!hadFrontMatter) err(rel, 'missing front matter block')
    for (const key of REQUIRED_FRONT_MATTER) {
      if (!data[key]) err(rel, `front matter is missing "${key}"`)
    }
    if (data.status && !VALID_STATUS.has(data.status.toLowerCase())) {
      err(rel, `front matter status "${data.status}" must be current | legacy | deprecated`)
    }
    if (data.updated && !/^\d{4}-\d{2}-\d{2}$/.test(data.updated)) {
      err(rel, `front matter updated "${data.updated}" must be YYYY-MM-DD`)
    }
    if (data.title && page.title && data.title !== page.title) {
      err(rel, `front matter title "${data.title}" does not match nav.mjs title "${page.title}"`)
    }
    if (data.description && !/[.!?]$/.test(data.description.trim())) {
      warn(rel, 'description should end with a period')
    }

    const headings = headingsOf(body)
    if (headings.some((h) => /^#\s/.test(h))) {
      err(rel, 'body contains an `# H1` — the generator renders the front-matter title as the H1')
    }

    // overview paragraph before the first heading
    const bodyLines = body.split('\n')
    const mask = fenceMask(body)
    let firstHeadingLine = bodyLines.length
    for (let i = 0; i < bodyLines.length; i++) {
      if (!mask[i] && /^#{1,6}\s/.test(bodyLines[i])) {
        firstHeadingLine = i
        break
      }
    }
    const beforeFirstHeading = bodyLines.slice(0, firstHeadingLine).join('\n').trim()
    const overview = beforeFirstHeading.replace(/^:::[\s\S]*?^:::\s*$/gm, '').trim()
    if (!overview) err(rel, 'no overview paragraph before the first heading')

    // required sections
    const required = new Set([...UNIVERSAL_REQUIREMENTS, ...(SECTION_REQUIREMENTS[page.sectionId] || [])])
    const h2s = headings.filter((h) => /^##\s/.test(h)).map((h) => h.replace(/\s+#+$/, '').trim())
    for (const want of required) {
      if (!h2s.some((h) => h.toLowerCase() === want.toLowerCase())) {
        err(rel, `missing required section "${want}"`)
      }
    }
    if (headings.length && !/^##\s+Related topics$/i.test(headings[headings.length - 1].replace(/\s+#+$/, ''))) {
      err(rel, '"## Related topics" must be the last heading on the page')
    }

    // code fences must declare a language
    for (const fence of fenceLanguages(body)) {
      if (!fence.info) err(`${rel}:${fence.line + lineOffset}`, 'code fence has no language')
    }

    // Express 4 APIs
    const exempt = computeExemptLines(body)
    const inFence = fenceMask(body)
    const isMigrationPage = legacyExemptPages.includes(page.path)
    if (!isMigrationPage) {
      const lines = body.split('\n')
      for (let i = 0; i < lines.length; i++) {
        if (exempt[i]) continue
        // Prose that names a dead API in order to warn about it is fine; code
        // that uses one is not.
        const isProseWarning = !inFence[i] && DEPRECATION_LANGUAGE.test(lines[i])
        for (const { needle, label } of EXPRESS4_PATTERNS) {
          if (lines[i].includes(needle) && !isProseWarning) {
            err(`${rel}:${i + 1 + lineOffset}`, `Express 4 / dead API outside a legacy block: ${label}`)
          }
        }
        for (const { re, label } of BAD_ROUTE_PATTERNS) {
          if (re.test(lines[i])) err(`${rel}:${i + 1 + lineOffset}`, `invalid Express 5 route pattern: ${label}`)
        }
      }
    }

    const result = renderMarkdown(body, { resolveLink: (t) => t })
    anchorsByPath.set(page.path, new Set(result.headings.map((h) => h.id)))
    parsed.push({ page, rel, body, lineOffset })
  }

  // --- links -------------------------------------------------------------
  let linkCount = 0
  for (const { page, rel, body, lineOffset } of parsed) {
    for (const { line: bodyLine, target } of extractLinks(body)) {
      const line = bodyLine + lineOffset
      if (/^(https?:|mailto:|tel:)/i.test(target)) continue
      linkCount++

      const [file, hash] = target.split('#')

      // pure anchor on the same page
      if (!file) {
        if (hash && !anchorsByPath.get(page.path)?.has(hash)) {
          err(`${rel}:${line}`, `dangling anchor "#${hash}" — no heading with that id on this page`)
        }
        continue
      }

      const resolved = path.posix.normalize(path.posix.join(page.sectionId, file))

      if (resolved.startsWith('examples/') || resolved.startsWith('../')) {
        const onDisk = path.join(ROOT, resolved)
        if (!existsSync(onDisk)) err(`${rel}:${line}`, `link target does not exist on disk: ${resolved}`)
        continue
      }

      if (!file.endsWith('.md')) {
        const onDisk = path.join(ROOT, resolved)
        if (!existsSync(onDisk)) err(`${rel}:${line}`, `link target does not exist: ${resolved}`)
        continue
      }

      const targetPath = resolved.replace(/\.md$/, '')
      if (!navByPath.has(targetPath)) {
        // section index pages are generated, allow <section>/index
        if (/\/index$/.test(targetPath)) continue
        err(`${rel}:${line}`, `dangling link — no page "${targetPath}" in nav.mjs (target: ${target})`)
        continue
      }
      if (hash && !anchorsByPath.get(targetPath)?.has(hash)) {
        err(`${rel}:${line}`, `dangling anchor "#${hash}" on page ${targetPath}`)
      }
    }
  }

  /* ------------------------------------------------------------- report */

  console.log('')
  console.log('  scripts/check.mjs')
  console.log('  ─────────────────────────────────────────────')
  console.log(`  pages checked    ${parsed.length} / ${order.length}${toScan.length > order.length ? ` (+${toScan.length - order.length} orphan)` : ''}`)
  console.log(`  links resolved   ${linkCount}`)
  console.log(`  errors           ${errors.length}`)
  console.log(`  warnings         ${warnings.length}`)

  if (warnings.length) {
    console.log('')
    console.log('  Warnings')
    for (const w of warnings) console.log(`    ~ ${w.file}: ${w.msg}`)
  }
  if (errors.length) {
    console.log('')
    console.log('  Errors')
    for (const e of errors) console.log(`    ✖ ${e.file}: ${e.msg}`)
    console.log('')
    process.exit(1)
  }
  console.log('')
  console.log('  All structural checks passed.')
  console.log('')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
