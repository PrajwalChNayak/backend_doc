/**
 * template.mjs — the HTML shell.
 *
 * Layout: a sticky top navigation bar, a centred reading column, and a narrow
 * "On this page" rail. There is no left sidebar — section navigation lives in
 * the top bar as a set of dropdowns, one per section, so the full width of the
 * viewport is available for prose.
 *
 * Every page is fully static: navigation, breadcrumbs, TOC and pager are all
 * baked in at build time, so the site works with JavaScript disabled (the
 * dropdown panels are plain `hidden` containers that JS reveals; without JS the
 * section links in the mobile panel are still reachable and every section index
 * page lists its own contents).
 *
 * All URLs are relative to `base`, so the site can be served from any subpath
 * (a GitHub Pages project site lives at /<repo>/).
 */

import { escapeHtml, escapeAttr } from './markdown.mjs'

/** Inlined in <head> so the theme is applied before first paint. */
const NO_FLASH = `(function(){try{var t=localStorage.getItem('handbook:theme');if(t==='light'||t==='dark'){document.documentElement.setAttribute('data-theme',t);}}catch(e){}})();`

const ICONS = {
  search:
    '<svg class="search__icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.25"/><path d="m12.5 12.5 4 4" stroke-linecap="round"/></svg>',
  theme:
    '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="10" cy="10" r="3.6"/><path d="M10 2v2M10 16v2M2 10h2M16 10h2M4.3 4.3l1.4 1.4M14.3 14.3l1.4 1.4M15.7 4.3l-1.4 1.4M5.7 14.3l-1.4 1.4" stroke-linecap="round"/></svg>',
  menu:
    '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M3 6h14M3 10h14M3 14h14" stroke-linecap="round"/></svg>',
  chevron:
    '<svg class="topnav__chevron" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="m3 4.5 3 3 3-3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
}

function statusPill(status) {
  const s = String(status || 'current').toLowerCase()
  const label = s === 'legacy' ? 'Legacy' : s === 'deprecated' ? 'Deprecated' : 'Current'
  return `<span class="status-pill status-pill--${escapeAttr(s)}">${label}</span>`
}

function badgeFor(status) {
  const s = String(status || 'current').toLowerCase()
  if (s === 'legacy') return '<span class="nav-badge nav-badge--legacy">Legacy</span>'
  if (s === 'deprecated') return '<span class="nav-badge nav-badge--deprecated">Deprecated</span>'
  return ''
}

/* ------------------------------------------------------------- navigation */

function pageLinks(section, base, activePath, statusByPath, linkClass) {
  return section.pages
    .map((page) => {
      const path = `${section.id}/${page.slug}`
      const current = path === activePath
      return (
        `<li><a class="${linkClass}" href="${escapeAttr(`${base}${path}.html`)}"` +
        (current ? ' aria-current="page"' : '') +
        `>${escapeHtml(page.title)}${badgeFor(statusByPath.get(path))}</a></li>`
      )
    })
    .join('')
}

/**
 * The desktop bar: one trigger per section, each opening a dropdown listing
 * that section's pages. Sections with many pages lay their list out in two
 * columns so no panel becomes taller than the viewport.
 *
 * @returns {{ topnav: string, mobile: string }}
 */
export function renderNavigation({ sections, base, activePath, activeSectionId, statusByPath }) {
  const items = sections
    .map((section, i) => {
      const isActive = section.id === activeSectionId
      const panelId = `navpanel-${section.id}`
      const triggerId = `navtrigger-${section.id}`
      const wide = section.pages.length > 8

      return (
        `<li class="topnav__item">` +
        `<button class="topnav__trigger" type="button" id="${triggerId}" aria-expanded="false" ` +
        `aria-controls="${panelId}" aria-haspopup="true"${isActive ? ' aria-current="true"' : ''} ` +
        `data-nav-index="${i}">${escapeHtml(section.navLabel || section.title)}${ICONS.chevron}</button>` +
        `<div class="topnav__panel${wide ? ' topnav__panel--wide' : ''}" id="${panelId}" ` +
        `role="group" aria-labelledby="${triggerId}" hidden>` +
        `<a class="topnav__overview" href="${escapeAttr(`${base}${section.id}/index.html`)}">` +
        `<span class="topnav__overview-title">${escapeHtml(section.title)}</span>` +
        `<span class="topnav__overview-desc">${escapeHtml(section.summary)}</span></a>` +
        `<ul class="topnav__pages">${pageLinks(section, base, activePath, statusByPath, 'topnav__page')}</ul>` +
        `</div></li>`
      )
    })
    .join('')

  const topnav =
    '<nav class="topnav" aria-label="Documentation sections">' +
    `<ul class="topnav__list">${items}</ul>` +
    '</nav>'

  const mobileGroups = sections
    .map((section) => {
      const isActive = section.id === activeSectionId
      return (
        `<section class="mobilenav__group"${isActive ? ' data-active="true"' : ''}>` +
        `<a class="mobilenav__title" href="${escapeAttr(`${base}${section.id}/index.html`)}">${escapeHtml(section.title)}</a>` +
        `<ul class="mobilenav__pages">${pageLinks(section, base, activePath, statusByPath, 'mobilenav__page')}</ul>` +
        '</section>'
      )
    })
    .join('')

  const mobile =
    '<div class="mobilenav" id="mobile-nav" hidden>' +
    `<nav class="mobilenav__inner" aria-label="All documentation sections">${mobileGroups}</nav>` +
    '</div>'

  return { topnav, mobile }
}

/* ------------------------------------------------------------------ parts */

function renderToc(headings) {
  if (!headings || headings.length < 2) return '<div class="toc" aria-hidden="true"></div>'
  const items = headings
    .map(
      (h) =>
        `<li><a class="toc__link toc__link--h${h.level}" href="#${escapeAttr(h.id)}">${escapeHtml(h.text)}</a></li>`
    )
    .join('')
  return (
    '<nav class="toc" aria-labelledby="toc-title">' +
    '<p class="toc__title" id="toc-title">On this page</p>' +
    `<ul class="toc__list">${items}</ul>` +
    '</nav>'
  )
}

function renderBreadcrumbs(crumbs) {
  const items = crumbs
    .map((c, i) => {
      const sep = i > 0 ? '<span class="breadcrumbs__sep" aria-hidden="true">/</span>' : ''
      const inner = c.href
        ? `<a href="${escapeAttr(c.href)}">${escapeHtml(c.label)}</a>`
        : `<span aria-current="page">${escapeHtml(c.label)}</span>`
      return `<li>${sep}${inner}</li>`
    })
    .join('')
  return `<nav aria-label="Breadcrumb"><ol class="breadcrumbs">${items}</ol></nav>`
}

function renderPager(prev, next, base) {
  if (!prev && !next) return ''
  const left = prev
    ? `<a class="pager__link pager__link--prev" href="${escapeAttr(base + prev.path + '.html')}" rel="prev">` +
      '<span class="pager__dir">Previous</span>' +
      `<span class="pager__title">${escapeHtml(prev.title)}</span></a>`
    : '<span></span>'
  const right = next
    ? `<a class="pager__link pager__link--next" href="${escapeAttr(base + next.path + '.html')}" rel="next">` +
      '<span class="pager__dir">Next</span>' +
      `<span class="pager__title">${escapeHtml(next.title)}</span></a>`
    : ''
  return `<nav class="pager" aria-label="Previous and next page">${left}${right}</nav>`
}

function renderHeader(site, base, topnav) {
  return (
    '<header class="site-header">' +
    '<div class="site-header__inner">' +
    `<a class="brand" href="${escapeAttr(base + 'index.html')}">` +
    '<span class="brand__mark" aria-hidden="true">NX</span>' +
    `<span class="brand__text">${escapeHtml(site.shortTitle)}</span></a>` +
    topnav +
    '<div class="site-header__tools">' +
    '<div class="search" role="search">' +
    ICONS.search +
    '<input class="search__input" id="search-input" type="search" placeholder="Search…" ' +
    'autocomplete="off" spellcheck="false" role="combobox" aria-expanded="false" ' +
    'aria-controls="search-results" aria-autocomplete="list" aria-label="Search documentation">' +
    '<kbd class="search__kbd">/</kbd>' +
    '<div class="search__results" id="search-results" role="listbox" aria-label="Search results" hidden></div>' +
    '</div>' +
    `<button class="icon-btn" id="theme-toggle" type="button" aria-label="Toggle theme">${ICONS.theme}</button>` +
    `<button class="icon-btn nav-toggle" id="nav-toggle" type="button" aria-expanded="false" ` +
    `aria-controls="mobile-nav" aria-label="Open navigation">${ICONS.menu}</button>` +
    '</div></div></header>'
  )
}

function renderFooter(site) {
  return (
    '<footer class="site-footer">' +
    `<span>Versions verified ${escapeHtml(site.verified)} against the npm registry and official docs.</span>` +
    '<span>Built with a zero-dependency generator — <code>node scripts/build.mjs</code></span>' +
    '</footer>'
  )
}

/**
 * Full page shell.
 *
 * @param {object} o
 * @param {string} o.title        <title> and og:title
 * @param {string} o.description  meta description
 * @param {string} o.base         relative root
 * @param {object} o.navigation   { topnav, mobile } from renderNavigation()
 * @param {string} o.body         main content HTML
 * @param {Array}  o.headings     for the "On this page" rail
 * @param {object} o.site
 * @param {'article'|'index'|'home'} o.layout
 *        article — reading column plus the "on this page" rail
 *        index   — reading column, no rail (section contents pages)
 *        home    — full shell width, no rail (the documentation index)
 */
export function renderPage({ title, description, base, navigation, body, headings, site, layout = 'article' }) {
  const full = title === site.title ? title : `${title} · ${site.shortTitle}`
  return `<!doctype html>
<html lang="en" data-base="${escapeAttr(base)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(full)}</title>
<meta name="description" content="${escapeAttr(description || site.description)}">
<meta name="color-scheme" content="light dark">
<meta property="og:title" content="${escapeAttr(title)}">
<meta property="og:description" content="${escapeAttr(description || site.description)}">
<meta property="og:type" content="article">
<link rel="stylesheet" href="${escapeAttr(base)}assets/site.css">
<link rel="icon" href="${escapeAttr(base)}assets/favicon.svg" type="image/svg+xml">
<script>${NO_FLASH}</script>
</head>
<body>
<a class="skip-link" href="#main">Skip to content</a>
${renderHeader(site, base, navigation.topnav)}
${navigation.mobile}
<div class="layout${layout === 'home' ? ' layout--wide' : layout === 'index' ? ' layout--index' : ''}">
<main class="main" id="main" tabindex="-1">
${body}
${renderFooter(site)}
</main>
${layout === 'article' ? renderToc(headings) : ''}
</div>
<script src="${escapeAttr(base)}assets/site.js" defer></script>
</body>
</html>
`
}

export { renderBreadcrumbs, renderPager, statusPill, renderToc }
