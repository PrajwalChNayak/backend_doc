#!/usr/bin/env node
/**
 * test-site-js.mjs — headless tests for the client runtime in
 * scripts/assets/site.js.
 *
 *   node --test scripts/test-site-js.mjs
 *   node scripts/test-site-js.mjs          (same thing; node:test auto-runs)
 *
 * The generated site has no build step and no test framework, but the client
 * runtime still has real logic in it — theme cycling, tab selection and
 * synchronisation, and TOC scroll-spy. This file executes the ACTUAL shipped
 * file inside a `vm` context against a minimal DOM stub and drives those
 * behaviours, so a regression in site.js fails a check rather than being
 * noticed by a reader.
 *
 * The stub implements only what site.js touches. It is deliberately not a DOM
 * implementation: if site.js starts using something new, the stub throws and
 * this test tells you, which is the point.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SITE_JS = path.join(HERE, 'assets', 'site.js')

/* ------------------------------------------------------------------- stub */

class ClassList {
  constructor() {
    this.set = new Set()
  }
  add(c) {
    this.set.add(c)
  }
  remove(c) {
    this.set.delete(c)
  }
  contains(c) {
    return this.set.has(c)
  }
  toString() {
    return [...this.set].join(' ')
  }
}

class El {
  constructor(tag, props = {}) {
    this.tagName = tag.toUpperCase()
    this.classList = new ClassList()
    this.attributes = new Map()
    this.children = []
    this.parent = null
    this.listeners = new Map()
    this.textContent = props.textContent ?? ''
    this.hidden = false
    this.offsetTop = props.offsetTop ?? 0
    this.dataset = props.dataset ?? {}
    this._top = props.top ?? 0
    for (const [k, v] of Object.entries(props.attrs ?? {})) this.attributes.set(k, String(v))
    if (props.className) for (const c of props.className.split(/\s+/)) this.classList.add(c)
    this.id = props.id ?? ''
  }
  getAttribute(n) {
    return this.attributes.has(n) ? this.attributes.get(n) : null
  }
  setAttribute(n, v) {
    this.attributes.set(n, String(v))
  }
  removeAttribute(n) {
    this.attributes.delete(n)
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, [])
    this.listeners.get(type).push(fn)
  }
  dispatch(type, event = {}) {
    for (const fn of this.listeners.get(type) ?? []) fn({ type, target: this, preventDefault() {}, ...event })
  }
  append(child) {
    child.parent = this
    this.children.push(child)
    return child
  }
  appendChild(child) {
    return this.append(child)
  }
  removeChild(child) {
    const i = this.children.indexOf(child)
    if (i !== -1) this.children.splice(i, 1)
    child.parent = null
    return child
  }
  get style() {
    this._style ??= {}
    return this._style
  }
  descendants() {
    return this.children.flatMap((c) => [c, ...c.descendants()])
  }
  contains(el) {
    return el === this || this.descendants().includes(el)
  }
  closest(sel) {
    let node = this
    while (node) {
      if (matches(node, sel)) return node
      node = node.parent
    }
    return null
  }
  querySelectorAll(sel) {
    // Supports comma groups and descendant combinators ("pre code"), which is
    // as much CSS as site.js uses.
    const out = new Set()
    for (const group of sel.split(',').map((s) => s.trim()).filter(Boolean)) {
      const parts = group.split(/\s+/)
      let scope = [this]
      for (const part of parts) {
        const next = []
        for (const node of scope) {
          for (const d of node.descendants()) if (matches(d, part)) next.push(d)
        }
        scope = [...new Set(next)]
      }
      for (const el of scope) out.add(el)
    }
    return [...out]
  }
  querySelector(sel) {
    return this.querySelectorAll(sel)[0] ?? null
  }
  getBoundingClientRect() {
    return { top: this._top, left: 0, right: 0, bottom: this._top + 20, width: 100, height: 20 }
  }
  scrollTo() {}
  scrollIntoView() {}
  focus() {
    doc.activeElement = this
  }
  select() {}
  get scrollHeight() {
    return 10000
  }
  get clientHeight() {
    return 800
  }
}

/** Supports the selector shapes site.js actually uses. */
function matches(el, sel) {
  return sel
    .split(',')
    .map((s) => s.trim())
    .some((s) => {
      const m = /^([a-z]*)((?:[.#\[][^.#\[]+)*)$/i.exec(s)
      if (!m) return false
      if (m[1] && el.tagName !== m[1].toUpperCase()) return false
      for (const part of m[2].match(/[.#\[][^.#\[]+/g) ?? []) {
        if (part.startsWith('.')) {
          if (!el.classList.contains(part.slice(1))) return false
        } else if (part.startsWith('#')) {
          if (el.id !== part.slice(1)) return false
        } else {
          const a = /^\[([\w-]+)(?:=["']?([^\]"']*)["']?)?\]$/.exec(part)
          if (!a) return false
          const val = el.getAttribute(a[1])
          if (val === null) return false
          if (a[2] !== undefined && val !== a[2]) return false
        }
      }
      return true
    })
}

let doc
let win

/**
 * Builds a page with a header (theme toggle), a tab group and a TOC whose
 * headings sit at the given viewport offsets.
 */
function buildPage({ headingTops = [-500, -100, 400, 1200] } = {}) {
  const root = new El('html')
  const body = new El('body')
  root.append(body)

  const themeBtn = new El('button', { id: 'theme-toggle' })
  body.append(themeBtn)

  // tabs
  const tabs = new El('div', { className: 'tabs', attrs: { 'data-tabs': '', 'data-tab-group': 'npm|pnpm' } })
  tabs.dataset = { tabs: '', tabGroup: 'npm|pnpm' }
  const list = new El('div', { className: 'tabs__list' })
  const panels = new El('div', { className: 'tabs__panels' })
  const tabEls = []
  const panelEls = []
  ;['npm', 'pnpm'].forEach((label, i) => {
    const b = new El('button', {
      attrs: { role: 'tab', 'data-tab-key': label, 'aria-selected': i === 0 ? 'true' : 'false' },
    })
    b.dataset = { tabKey: label }
    const p = new El('div', { attrs: { role: 'tabpanel' } })
    p.hidden = i !== 0
    tabEls.push(list.append(b))
    panelEls.push(panels.append(p))
  })
  tabs.append(list)
  tabs.append(panels)
  body.append(tabs)

  // code block + copy button
  const codeBlock = new El('figure', { className: 'code-block' })
  const shell = new El('div', { className: 'code-shell' })
  const copyBtn = new El('button', { className: 'copy-btn', attrs: { 'data-copy': '' }, textContent: 'Copy' })
  const pre = new El('pre')
  const code = new El('code', { className: 'language-js', textContent: 'const a = 1\nconsole.log(a)' })
  pre.append(code)
  shell.append(copyBtn)
  shell.append(pre)
  codeBlock.append(shell)
  body.append(codeBlock)

  // top navigation: three sections, each with a dropdown panel
  const topnav = new El('nav', { className: 'topnav' })
  const topList = new El('ul', { className: 'topnav__list' })
  const triggers = []
  const navPanels = []
  ;['Node.js', 'Express', 'Security'].forEach((label, i) => {
    const item = new El('li', { className: 'topnav__item' })
    const panelId = 'navpanel-' + i
    const trigger = new El('button', {
      className: 'topnav__trigger',
      id: 'navtrigger-' + i,
      textContent: label,
      attrs: { 'aria-expanded': 'false', 'aria-controls': panelId },
    })
    const panel = new El('div', { className: 'topnav__panel', id: panelId })
    panel.hidden = true
    panel.append(new El('a', { className: 'topnav__page', attrs: { href: '#' + i }, textContent: label + ' page' }))
    triggers.push(item.append(trigger))
    navPanels.push(item.append(panel))
    topList.append(item)
  })
  topnav.append(topList)
  body.append(topnav)

  // mobile navigation
  const navToggle = new El('button', { id: 'nav-toggle', attrs: { 'aria-expanded': 'false' } })
  body.append(navToggle)
  const mobileNav = new El('div', { id: 'mobile-nav' })
  mobileNav.hidden = true
  const mobileLink = new El('a', { className: 'mobilenav__page', attrs: { href: 'x.html' } })
  mobileNav.append(mobileLink)
  body.append(mobileNav)

  // toc + headings
  const toc = new El('nav', { className: 'toc' })
  const tocList = new El('ul', { className: 'toc__list' })
  const links = []
  const headings = []
  headingTops.forEach((top, i) => {
    const id = `section-${i}`
    const h = new El('h2', { id, top })
    body.append(h)
    headings.push(h)
    const a = new El('a', { className: 'toc__link', attrs: { href: `#${id}` }, textContent: `Section ${i}` })
    links.push(tocList.append(a))
  })
  toc.append(tocList)
  body.append(toc)

  const byId = new Map(headings.map((h) => [h.id, h]))

  doc = {
    documentElement: root,
    body,
    head: new El('head'),
    readyState: 'complete',
    activeElement: null,
    listeners: new Map(),
    getElementById: (id) => (id === 'theme-toggle' ? themeBtn : byId.get(id) ?? root.querySelector(`#${id}`)),
    querySelector: (s) => root.querySelector(s),
    querySelectorAll: (s) => root.querySelectorAll(s),
    createElement: (t) => new El(t),
    _execCommandResult: true,
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, [])
      this.listeners.get(type).push(fn)
    },
    dispatch(type, event = {}) {
      for (const fn of this.listeners.get(type) ?? []) fn({ type, preventDefault() {}, ...event })
    },
    execCommand() {
      this._execCommandCalled = true
      return this._execCommandResult
    },
  }

  const store = new Map()
  win = {
    listeners: new Map(),
    innerHeight: 800,
    innerWidth: 1400,
    scrollY: 0,
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
    },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    requestAnimationFrame: (fn) => fn(),
    setTimeout: (fn) => fn,
    clearTimeout: () => {},
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, [])
      this.listeners.get(type).push(fn)
    },
    dispatch(type) {
      for (const fn of this.listeners.get(type) ?? []) fn({ type })
    },
    location: { href: '' },
    // Overwritten per test to simulate a granted clipboard, a rejected one,
    // or a browser that exposes no Clipboard API at all.
    navigator: {},
    fetch: () => Promise.reject(new Error('search index not used in this test')),
  }

  return { root, body, themeBtn, tabEls, panelEls, links, headings, store, copyBtn, code, triggers, navPanels, navToggle, mobileNav, mobileLink }
}

function runSiteJs() {
  const source = readFileSync(SITE_JS, 'utf8')
  const sandbox = {
    window: win,
    document: doc,
    navigator: win.navigator,
    localStorage: win.localStorage,
    setTimeout: (fn) => fn,
    clearTimeout: () => {},
    console,
    Set,
    Map,
  }
  sandbox.window.document = doc
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: 'site.js' })
}

/* ------------------------------------------------------------------ tests */

test('theme toggle cycles system -> light -> dark -> system and persists', () => {
  const page = buildPage()
  runSiteJs()

  assert.equal(page.root.getAttribute('data-theme'), null, 'starts on system')

  page.themeBtn.dispatch('click')
  assert.equal(page.root.getAttribute('data-theme'), 'light')
  assert.equal(page.store.get('handbook:theme'), 'light')

  page.themeBtn.dispatch('click')
  assert.equal(page.root.getAttribute('data-theme'), 'dark')
  assert.equal(page.store.get('handbook:theme'), 'dark')

  page.themeBtn.dispatch('click')
  assert.equal(page.root.getAttribute('data-theme'), null, 'back to system')
  assert.equal(page.store.get('handbook:theme'), 'system')
})

test('a stored theme is applied on load', () => {
  const page = buildPage()
  page.store.set('handbook:theme', 'dark')
  runSiteJs()
  assert.equal(page.root.getAttribute('data-theme'), 'dark')
})

test('clicking a tab selects it, hides the other panel, and remembers the choice', () => {
  const page = buildPage()
  runSiteJs()

  assert.equal(page.tabEls[0].getAttribute('aria-selected'), 'true')
  assert.equal(page.panelEls[1].hidden, true)

  page.tabEls[1].parent.parent.dispatch('click', { target: page.tabEls[1] })

  assert.equal(page.tabEls[0].getAttribute('aria-selected'), 'false')
  assert.equal(page.tabEls[1].getAttribute('aria-selected'), 'true')
  assert.equal(page.panelEls[0].hidden, true)
  assert.equal(page.panelEls[1].hidden, false)
  assert.equal(page.store.get('handbook:tab:npm|pnpm'), 'pnpm')
})

test('a remembered tab choice is restored on the next page', () => {
  const page = buildPage()
  page.store.set('handbook:tab:npm|pnpm', 'pnpm')
  runSiteJs()
  assert.equal(page.tabEls[1].getAttribute('aria-selected'), 'true')
  assert.equal(page.panelEls[0].hidden, true)
})

test('scroll-spy marks the last heading scrolled past, and only one at a time', () => {
  // Two headings above the fold (negative tops), two below.
  const page = buildPage({ headingTops: [-500, -100, 400, 1200] })
  runSiteJs()

  const activeLinks = () => page.links.filter((l) => l.classList.contains('is-active'))

  assert.equal(activeLinks().length, 1, 'exactly one active entry')
  assert.equal(activeLinks()[0].getAttribute('href'), '#section-1', 'the last heading above the offset')

  // Scroll further: heading 2 passes under the sticky header.
  page.headings.forEach((h, i) => (h._top = [-1400, -1000, -50, 700][i]))
  win.dispatch('scroll')

  assert.equal(activeLinks().length, 1)
  assert.equal(activeLinks()[0].getAttribute('href'), '#section-2')

  // Back to the very top: the first heading is active.
  page.headings.forEach((h, i) => (h._top = [200, 700, 1400, 2200][i]))
  win.dispatch('scroll')
  assert.equal(activeLinks()[0].getAttribute('href'), '#section-0')
})

test('scroll-spy activates the final heading at the bottom of the page', () => {
  const page = buildPage({ headingTops: [-9000, -8000, -7000, -200] })
  runSiteJs()
  // documentElement.scrollHeight is 10000 in the stub; put the viewport at the end.
  win.scrollY = 10000 - win.innerHeight
  win.dispatch('scroll')

  const active = page.links.filter((l) => l.classList.contains('is-active'))
  assert.equal(active.length, 1)
  assert.equal(active[0].getAttribute('href'), '#section-3', 'last heading wins at the bottom')
})

/* ------------------------------------------------------------ copy button */

/** Waits for the promise chain inside the copy handler to settle. */
const flush = () => new Promise((r) => setImmediate(r))

test('copy button writes the block’s exact source to the clipboard', async () => {
  const page = buildPage()
  let written = null
  win.navigator = { clipboard: { writeText: (t) => ((written = t), Promise.resolve()) } }
  runSiteJs()

  doc.dispatch('click', { target: page.copyBtn })
  await flush()

  assert.equal(written, 'const a = 1\nconsole.log(a)', 'copies the code, not the highlighted markup')
  assert.equal(page.copyBtn.textContent, 'Copied')
  assert.equal(page.copyBtn.getAttribute('data-copied'), 'true')
})

test('copy button falls back to execCommand when the Clipboard API rejects', async () => {
  const page = buildPage()
  win.navigator = { clipboard: { writeText: () => Promise.reject(new Error('denied')) } }
  doc._execCommandResult = true
  runSiteJs()

  doc.dispatch('click', { target: page.copyBtn })
  await flush()

  assert.equal(doc._execCommandCalled, true, 'fell back rather than giving up')
  assert.equal(page.copyBtn.textContent, 'Copied')
})

test('copy button falls back when there is no Clipboard API at all', async () => {
  const page = buildPage()
  win.navigator = {} // older browser / insecure context
  doc._execCommandResult = true
  runSiteJs()

  doc.dispatch('click', { target: page.copyBtn })
  await flush()

  assert.equal(doc._execCommandCalled, true)
  assert.equal(page.copyBtn.textContent, 'Copied')
})

test('copy button reports failure honestly when both paths fail', async () => {
  const page = buildPage()
  win.navigator = { clipboard: { writeText: () => Promise.reject(new Error('denied')) } }
  doc._execCommandResult = false // e.g. a synthetic click with no user activation
  runSiteJs()

  doc.dispatch('click', { target: page.copyBtn })
  await flush()

  assert.equal(page.copyBtn.textContent, 'Failed')
  assert.equal(page.copyBtn.getAttribute('data-copied'), 'false')
})

test('a click outside a copy button does nothing', async () => {
  const page = buildPage()
  let written = null
  win.navigator = { clipboard: { writeText: (t) => ((written = t), Promise.resolve()) } }
  runSiteJs()

  doc.dispatch('click', { target: page.themeBtn })
  await flush()

  assert.equal(written, null)
  assert.equal(page.copyBtn.textContent, 'Copy')
})

/* --------------------------------------------------------- top navigation */

test('a section dropdown opens on click and reports it to assistive tech', () => {
  const page = buildPage()
  runSiteJs()

  assert.equal(page.navPanels[0].hidden, true, 'panels start closed')

  page.triggers[0].dispatch('click')

  assert.equal(page.navPanels[0].hidden, false)
  assert.equal(page.triggers[0].getAttribute('aria-expanded'), 'true')
})

test('clicking the open trigger again closes it', () => {
  const page = buildPage()
  runSiteJs()

  page.triggers[1].dispatch('click')
  page.triggers[1].dispatch('click')

  assert.equal(page.navPanels[1].hidden, true)
  assert.equal(page.triggers[1].getAttribute('aria-expanded'), 'false')
})

test('only one dropdown is open at a time', () => {
  const page = buildPage()
  runSiteJs()

  page.triggers[0].dispatch('click')
  page.triggers[2].dispatch('click')

  assert.equal(page.navPanels[0].hidden, true, 'the first one closed')
  assert.equal(page.navPanels[2].hidden, false)
  assert.equal(
    page.triggers.filter((t) => t.getAttribute('aria-expanded') === 'true').length,
    1
  )
})

test('Escape closes the open dropdown and returns focus to its trigger', () => {
  const page = buildPage()
  runSiteJs()

  page.triggers[1].dispatch('click')
  doc.dispatch('keydown', { key: 'Escape' })

  assert.equal(page.navPanels[1].hidden, true)
  assert.equal(doc.activeElement, page.triggers[1], 'focus went back to the trigger')
})

test('clicking outside the navigation closes any open dropdown', () => {
  const page = buildPage()
  runSiteJs()

  page.triggers[0].dispatch('click')
  doc.dispatch('click', { target: page.body })

  assert.equal(page.navPanels[0].hidden, true)
})

test('arrow keys move along the section bar', () => {
  const page = buildPage()
  runSiteJs()

  page.triggers[0].dispatch('keydown', { key: 'ArrowRight' })
  assert.equal(doc.activeElement, page.triggers[1])

  page.triggers[1].dispatch('keydown', { key: 'ArrowLeft' })
  assert.equal(doc.activeElement, page.triggers[0])

  // wraps around at the ends
  page.triggers[0].dispatch('keydown', { key: 'ArrowLeft' })
  assert.equal(doc.activeElement, page.triggers[2])
})

test('ArrowDown opens a dropdown and moves into it', () => {
  const page = buildPage()
  runSiteJs()

  page.triggers[0].dispatch('keydown', { key: 'ArrowDown' })

  assert.equal(page.navPanels[0].hidden, false)
  assert.equal(doc.activeElement, page.navPanels[0].querySelector('a'), 'focus entered the panel')
})

test('the mobile panel toggles, marks state, and closes when a link is used', () => {
  const page = buildPage()
  runSiteJs()

  assert.equal(page.mobileNav.hidden, true, 'starts closed')
  assert.equal(page.navToggle.getAttribute('aria-expanded'), 'false')

  page.navToggle.dispatch('click')
  assert.equal(page.mobileNav.hidden, false)
  assert.equal(page.navToggle.getAttribute('aria-expanded'), 'true')
  assert.equal(doc.body.getAttribute('data-nav'), 'open')
  assert.match(page.navToggle.getAttribute('aria-label'), /close/i)

  // Following a link must not leave the panel covering the destination.
  page.mobileNav.dispatch('click', { target: page.mobileLink })
  assert.equal(page.mobileNav.hidden, true)
  assert.equal(doc.body.getAttribute('data-nav'), 'closed')
})

test('resizing back to desktop closes a stranded mobile panel', () => {
  const page = buildPage()
  runSiteJs()

  page.navToggle.dispatch('click')
  assert.equal(page.mobileNav.hidden, false)

  win.innerWidth = 1400
  win.dispatch('resize')

  assert.equal(page.mobileNav.hidden, true)
})
