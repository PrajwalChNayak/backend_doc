#!/usr/bin/env node
/**
 * build.mjs — generates docs/ from content/.
 *
 *   node scripts/build.mjs
 *
 * Zero npm dependencies on purpose: this must work on a fresh clone with no
 * install step. Output goes to docs/ so GitHub Pages can serve it with no
 * configuration beyond Settings → Pages → main → /docs.
 *
 * Everything about the information architecture comes from scripts/nav.mjs.
 */

import { readFile, writeFile, mkdir, rm, readdir, cp, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { site, sections, flatten } from './nav.mjs'
import { parseFrontMatter, renderMarkdown, escapeHtml, escapeAttr, inlineToText } from './lib/markdown.mjs'
import { renderPage, renderNavigation, renderBreadcrumbs, renderPager, statusPill } from './lib/template.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const CONTENT = path.join(ROOT, 'content')
const OUT = path.join(ROOT, 'docs')
const ASSETS = path.join(HERE, 'assets')

const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
<rect width="32" height="32" rx="7" fill="#2f4bd8"/>
<path d="M9 21.5V10.5h2.6l5 7.2v-7.2H19v11h-2.5l-5.1-7.3v7.3z" fill="#fff"/>
<circle cx="23.5" cy="20.5" r="2" fill="#7ee0b8"/>
</svg>`

const stats = { pages: 0, sectionIndexes: 0, words: 0, codeBlocks: 0, warnings: [] }

/* ------------------------------------------------------------------ helpers */

const baseFor = (depth) => (depth === 0 ? './' : '../'.repeat(depth))

/**
 * Rewrites an in-content link target for the generated site.
 * `../express/routing.md` -> `../express/routing.html`
 * `../../examples/x/README.md` -> the GitHub blob URL (examples are not built)
 */
function makeLinkResolver(pageDir) {
  return (target) => {
    if (/^(https?:|mailto:|tel:|#)/i.test(target)) return target

    const [file, hash] = target.split('#')
    if (!file) return target

    // Links into examples/ point at the repository, since examples are code
    // rather than generated pages.
    const normalized = path.posix.normalize(path.posix.join(pageDir, file))
    if (normalized.startsWith('examples/')) {
      return `${site.repo}/blob/main/${normalized}${hash ? '#' + hash : ''}`
    }
    if (normalized.startsWith('CONTRIBUTING') || normalized.startsWith('README')) {
      return `${site.repo}/blob/main/${normalized}`
    }

    if (file.endsWith('.md')) {
      const html = file.replace(/\.md$/, '.html')
      return hash ? `${html}#${hash}` : html
    }
    return target
  }
}

async function listMarkdown(dir) {
  if (!existsSync(dir)) return []
  const entries = await readdir(dir, { withFileTypes: true })
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.md'))
    .map((e) => e.name.replace(/\.md$/, ''))
    .sort()
}

function countWords(text) {
  return text ? text.split(/\s+/).filter(Boolean).length : 0
}

/* -------------------------------------------------------------------- build */

async function build() {
  const started = Date.now()

  if (!existsSync(CONTENT)) {
    console.error(`✖ content/ not found at ${CONTENT}`)
    process.exit(1)
  }

  await rm(OUT, { recursive: true, force: true })
  await mkdir(OUT, { recursive: true })

  const order = flatten()
  const statusByPath = new Map()
  const rendered = []

  // ---- pass 1: read + render markdown ------------------------------------
  for (let i = 0; i < order.length; i++) {
    const page = order[i]
    const source = path.join(CONTENT, page.sectionId, `${page.slug}.md`)
    if (!existsSync(source)) {
      stats.warnings.push(`missing content file for nav entry: ${page.path} (expected ${path.relative(ROOT, source)})`)
      continue
    }

    const raw = await readFile(source, 'utf8')
    const { data, body } = parseFrontMatter(raw)
    const resolveLink = makeLinkResolver(page.sectionId)
    const result = renderMarkdown(body, { resolveLink })

    const status = (data.status || 'current').toLowerCase()
    statusByPath.set(page.path, status)

    rendered.push({ page, data, status, result, index: i })
    stats.words += countWords(result.text)
    stats.codeBlocks += result.codeBlocks.length
  }

  // The navigation markup depends only on (base, active page), so it is cached
  // rather than rebuilt for each of the ~100 pages.
  const navCache = new Map()
  const navFor = (base, activePath, activeSectionId) => {
    const key = `${base}::${activePath}`
    if (!navCache.has(key)) {
      navCache.set(key, renderNavigation({ sections, base, activePath, activeSectionId, statusByPath }))
    }
    return navCache.get(key)
  }

  // ---- pass 2: emit article pages ----------------------------------------
  const searchEntries = []

  for (const { page, data, status, result, index } of rendered) {
    const base = baseFor(1)
    const prev = index > 0 ? order[index - 1] : null
    const next = index < order.length - 1 ? order[index + 1] : null

    const crumbs = [
      { label: 'Home', href: `${base}index.html` },
      { label: page.sectionTitle, href: `${base}${page.sectionId}/index.html` },
      { label: page.title, href: '' },
    ]

    const header =
      '<header class="page-header">' +
      `<h1 class="page-title">${escapeHtml(data.title || page.title)}</h1>` +
      (data.description ? `<p class="page-desc">${escapeHtml(data.description)}</p>` : '') +
      '<p class="page-meta">' +
      statusPill(status) +
      (data.updated ? `<span>Updated ${escapeHtml(data.updated)}</span>` : '') +
      `<span>·</span><span>${escapeHtml(page.sectionTitle)}</span>` +
      '</p></header>'

    const body =
      '<div class="content">' +
      renderBreadcrumbs(crumbs) +
      header +
      `<article class="prose">${result.html}</article>` +
      renderPager(prev, next, base) +
      '</div>'

    const html = renderPage({
      title: data.title || page.title,
      description: data.description,
      base,
      navigation: navFor(base, page.path, page.sectionId),
      body,
      headings: result.headings,
      site,
    })

    const outFile = path.join(OUT, page.sectionId, `${page.slug}.html`)
    await mkdir(path.dirname(outFile), { recursive: true })
    await writeFile(outFile, html, 'utf8')
    stats.pages++

    searchEntries.push({
      url: `${page.sectionId}/${page.slug}.html`,
      title: data.title || page.title,
      section: page.sectionTitle,
      description: data.description || '',
      headings: result.headings.map((h) => h.text),
      // Cap the indexed body so the JSON stays small enough to fetch eagerly.
      text: result.text.slice(0, 2400),
    })
  }

  // ---- pass 3: section index pages ---------------------------------------
  for (const section of sections) {
    const base = baseFor(1)
    const items = section.pages
      .filter((p) => statusByPath.has(`${section.id}/${p.slug}`))
      .map((p) => {
        const entry = rendered.find((r) => r.page.path === `${section.id}/${p.slug}`)
        const desc = entry?.data?.description || ''
        return (
          '<li>' +
          `<a href="${escapeAttr(p.slug + '.html')}">` +
          `<span class="section-index__title">${escapeHtml(p.title)}</span>` +
          (desc ? `<span class="section-index__desc">${escapeHtml(desc)}</span>` : '') +
          '</a></li>'
        )
      })
      .join('')

    const body =
      '<div class="content">' +
      renderBreadcrumbs([
        { label: 'Home', href: `${base}index.html` },
        { label: section.title, href: '' },
      ]) +
      '<header class="page-header">' +
      `<h1 class="page-title">${escapeHtml(section.title)}</h1>` +
      `<p class="page-desc">${escapeHtml(section.summary)}</p>` +
      `<p class="page-meta"><span>${section.pages.length} pages</span></p>` +
      '</header>' +
      `<ul class="section-index">${items}</ul>` +
      '</div>'

    const html = renderPage({
      title: section.title,
      description: section.summary,
      base,
      navigation: navFor(base, `${section.id}/index`, section.id),
      body,
      headings: [],
      site,
      layout: 'index',
    })

    await mkdir(path.join(OUT, section.id), { recursive: true })
    await writeFile(path.join(OUT, section.id, 'index.html'), html, 'utf8')
    stats.sectionIndexes++
  }

  // ---- pass 4: home ------------------------------------------------------
  const base = baseFor(0)
  const first = order[0]

  // A documentation index, not a landing page: every section with every page
  // listed, so the home page is the fastest route to any topic.
  const index = sections
    .map((s) => {
      const links = s.pages
        .filter((p) => statusByPath.has(`${s.id}/${p.slug}`))
        .map(
          (p) =>
            `<li><a href="${escapeAttr(`${s.id}/${p.slug}.html`)}">${escapeHtml(p.title)}</a></li>`
        )
        .join('')
      return (
        '<section class="home-section">' +
        `<a class="home-section__title" href="${escapeAttr(s.id + '/index.html')}">${escapeHtml(s.title)}` +
        `<span class="home-section__count">${s.pages.length}</span></a>` +
        `<p class="home-section__desc">${escapeHtml(s.summary)}</p>` +
        `<ul class="home-section__pages">${links}</ul>` +
        '</section>'
      )
    })
    .join('')

  const homeBody =
    '<div class="content content--wide">' +
    '<header class="home-header">' +
    `<h1 class="home-title">${escapeHtml(site.title)}</h1>` +
    `<p class="home-lede">${escapeHtml(site.description)}</p>` +
    '<p class="home-meta">' +
    `<span class="home-chip">Node 24 LTS</span><span class="home-chip">Express 5.2.1</span>` +
    `<span>Verified ${escapeHtml(site.verified)}</span>` +
    (first ? `<a class="home-start" href="${escapeAttr(first.path + '.html')}">Start reading →</a>` : '') +
    '</p></header>' +
    `<div class="home-index">${index}</div>` +
    '</div>'

  await writeFile(
    path.join(OUT, 'index.html'),
    renderPage({
      title: site.title,
      description: site.description,
      base,
      navigation: navFor(base, '', ''),
      body: homeBody,
      headings: [],
      site,
      layout: 'home',
    }),
    'utf8'
  )

  // ---- pass 5: assets, search index, Pages plumbing ----------------------
  await mkdir(path.join(OUT, 'assets'), { recursive: true })
  await cp(ASSETS, path.join(OUT, 'assets'), { recursive: true })
  await writeFile(path.join(OUT, 'assets', 'favicon.svg'), FAVICON, 'utf8')

  await writeFile(
    path.join(OUT, 'search-index.json'),
    JSON.stringify({ generated: new Date().toISOString().slice(0, 10), pages: searchEntries }),
    'utf8'
  )

  // Stops GitHub Pages from running the output through Jekyll, which would
  // drop any file or directory beginning with an underscore.
  await writeFile(path.join(OUT, '.nojekyll'), '', 'utf8')

  // ---- orphan detection (informational; check.mjs enforces) --------------
  for (const section of sections) {
    const files = await listMarkdown(path.join(CONTENT, section.id))
    const known = new Set(section.pages.map((p) => p.slug))
    for (const f of files) {
      if (!known.has(f)) stats.warnings.push(`orphan content file not in nav.mjs: content/${section.id}/${f}.md`)
    }
  }

  const indexSize = (await stat(path.join(OUT, 'search-index.json'))).size

  const ms = Date.now() - started
  console.log('')
  console.log('  Build complete')
  console.log('  ─────────────────────────────────────────────')
  console.log(`  pages            ${stats.pages}`)
  console.log(`  section indexes  ${stats.sectionIndexes}`)
  console.log(`  home             1`)
  console.log(`  code blocks      ${stats.codeBlocks}`)
  console.log(`  indexed words    ${stats.words.toLocaleString('en-US')}`)
  console.log(`  search index     ${(indexSize / 1024).toFixed(1)} KB`)
  console.log(`  output           ${path.relative(ROOT, OUT)}/`)
  console.log(`  time             ${ms} ms`)

  if (stats.warnings.length) {
    console.log('')
    console.log(`  ${stats.warnings.length} warning(s):`)
    for (const w of stats.warnings) console.log(`    ! ${w}`)
  }
  console.log('')

  return stats
}

build().catch((err) => {
  console.error('✖ build failed')
  console.error(err)
  process.exit(1)
})
