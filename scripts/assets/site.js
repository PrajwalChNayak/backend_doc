/* =============================================================================
   Node.js & Express Backend Handbook — client runtime.
   No dependencies, no build step. Progressive: every feature degrades to plain
   HTML if JS is unavailable or storage is blocked.
   ========================================================================== */

(function () {
  'use strict'

  var root = document.documentElement
  var BASE = root.getAttribute('data-base') || './'

  /* --------------------------------------------------------------- storage */
  // Storage can throw outright (private mode, blocked site data), not just
  // return null — every access is guarded.

  function readStore(key) {
    try {
      return window.localStorage.getItem(key)
    } catch (e) {
      return null
    }
  }

  function writeStore(key, value) {
    try {
      window.localStorage.setItem(key, value)
    } catch (e) {
      /* non-fatal: the preference simply will not persist */
    }
  }

  /* ----------------------------------------------------------------- theme */
  // The no-flash part runs inline in <head>; this only wires the toggle.

  var THEME_KEY = 'handbook:theme'
  var THEME_ORDER = ['system', 'light', 'dark']

  function currentTheme() {
    var stored = readStore(THEME_KEY)
    return THEME_ORDER.indexOf(stored) === -1 ? 'system' : stored
  }

  function applyTheme(theme) {
    if (theme === 'system') root.removeAttribute('data-theme')
    else root.setAttribute('data-theme', theme)

    var btn = document.getElementById('theme-toggle')
    if (!btn) return
    var label = theme === 'system' ? 'system' : theme
    btn.setAttribute('aria-label', 'Theme: ' + label + '. Click to change.')
    btn.setAttribute('title', 'Theme: ' + label)
    btn.setAttribute('data-theme-state', theme)
  }

  function initTheme() {
    applyTheme(currentTheme())
    var btn = document.getElementById('theme-toggle')
    if (!btn) return
    btn.addEventListener('click', function () {
      var next = THEME_ORDER[(THEME_ORDER.indexOf(currentTheme()) + 1) % THEME_ORDER.length]
      writeStore(THEME_KEY, next)
      applyTheme(next)
    })
  }

  /* ------------------------------------------------------------ copy button */

  function initCopyButtons() {
    document.addEventListener('click', function (event) {
      var btn = event.target.closest('[data-copy]')
      if (!btn) return
      var block = btn.closest('.code-block')
      var code = block && block.querySelector('pre code')
      if (!code) return

      var text = code.textContent
      var done = function (ok) {
        btn.textContent = ok ? 'Copied' : 'Failed'
        btn.setAttribute('data-copied', ok ? 'true' : 'false')
        window.setTimeout(function () {
          btn.textContent = 'Copy'
          btn.removeAttribute('data-copied')
        }, 1600)
      }

      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(
          function () {
            done(true)
          },
          function () {
            done(fallbackCopy(text))
          }
        )
      } else {
        done(fallbackCopy(text))
      }
    })
  }

  function fallbackCopy(text) {
    var ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    var ok = false
    try {
      ok = document.execCommand('copy')
    } catch (e) {
      ok = false
    }
    document.body.removeChild(ta)
    return ok
  }

  /* ------------------------------------------------------------------ tabs */
  // Tab choice is synced site-wide by label (so picking "pnpm" once picks it
  // everywhere) and remembered per group signature.

  var TAB_KEY = 'handbook:tab:'

  function selectTab(group, index, focus) {
    var buttons = group.querySelectorAll('[role="tab"]')
    var panels = group.querySelectorAll('[role="tabpanel"]')
    for (var i = 0; i < buttons.length; i++) {
      var selected = i === index
      buttons[i].setAttribute('aria-selected', selected ? 'true' : 'false')
      buttons[i].setAttribute('tabindex', selected ? '0' : '-1')
      if (panels[i]) panels[i].hidden = !selected
    }
    if (focus && buttons[index]) buttons[index].focus()
  }

  function initTabs() {
    var groups = document.querySelectorAll('[data-tabs]')

    Array.prototype.forEach.call(groups, function (group) {
      var signature = group.getAttribute('data-tab-group') || ''
      var buttons = group.querySelectorAll('[role="tab"]')

      var remembered = readStore(TAB_KEY + signature)
      if (remembered) {
        for (var i = 0; i < buttons.length; i++) {
          if (buttons[i].getAttribute('data-tab-key') === remembered) {
            selectTab(group, i, false)
            break
          }
        }
      }

      group.addEventListener('click', function (event) {
        var btn = event.target.closest('[role="tab"]')
        if (!btn || !group.contains(btn)) return
        var index = Array.prototype.indexOf.call(buttons, btn)
        if (index === -1) return
        var key = btn.getAttribute('data-tab-key')
        writeStore(TAB_KEY + signature, key)
        syncAll(signature, key)
      })

      group.addEventListener('keydown', function (event) {
        var btn = event.target.closest('[role="tab"]')
        if (!btn) return
        var index = Array.prototype.indexOf.call(buttons, btn)
        var next = null
        if (event.key === 'ArrowRight') next = (index + 1) % buttons.length
        else if (event.key === 'ArrowLeft') next = (index - 1 + buttons.length) % buttons.length
        else if (event.key === 'Home') next = 0
        else if (event.key === 'End') next = buttons.length - 1
        if (next === null) return
        event.preventDefault()
        var key = buttons[next].getAttribute('data-tab-key')
        writeStore(TAB_KEY + signature, key)
        syncAll(signature, key)
        buttons[next].focus()
      })
    })

    function syncAll(signature, key) {
      Array.prototype.forEach.call(groups, function (group) {
        if (group.getAttribute('data-tab-group') !== signature) return
        var buttons = group.querySelectorAll('[role="tab"]')
        for (var i = 0; i < buttons.length; i++) {
          if (buttons[i].getAttribute('data-tab-key') === key) {
            selectTab(group, i, false)
            return
          }
        }
      })
    }
  }

  /* ------------------------------------------------------------- scroll spy */

  function initScrollSpy() {
    var links = document.querySelectorAll('.toc__link')
    if (!links.length) return

    var map = {}
    var targets = []
    Array.prototype.forEach.call(links, function (link) {
      var id = decodeURIComponent((link.getAttribute('href') || '').replace(/^#/, ''))
      var el = id && document.getElementById(id)
      if (!el) return
      map[id] = link
      targets.push(el)
    })
    if (!targets.length) return

    var active = null
    function setActive(link) {
      if (active === link) return
      if (active) active.classList.remove('is-active')
      active = link
      if (active) {
        active.classList.add('is-active')
        // Keep the marker in view without hijacking the page scroll.
        var toc = active.closest('.toc')
        if (toc && toc.scrollHeight > toc.clientHeight) {
          var top = active.offsetTop - toc.clientHeight / 2
          toc.scrollTo({ top: top, behavior: 'auto' })
        }
      }
    }

    // A direct scroll computation rather than IntersectionObserver: the active
    // heading is simply the last one whose top has passed under the sticky
    // header, with the first heading active above that and the last heading
    // forced active at the bottom of the page (so the final short section can
    // still be reached). This is easier to reason about than tuning a
    // rootMargin band, and it always resolves to exactly one entry.
    var OFFSET = 96

    function update() {
      var chosen = targets[0]
      for (var i = 0; i < targets.length; i++) {
        if (targets[i].getBoundingClientRect().top <= OFFSET) chosen = targets[i]
        else break
      }

      var scrollBottom = window.innerHeight + window.scrollY
      var atBottom = scrollBottom >= document.documentElement.scrollHeight - 2
      if (atBottom) chosen = targets[targets.length - 1]

      setActive(map[chosen.id] || null)
    }

    var ticking = false
    function onScroll() {
      if (ticking) return
      ticking = true
      window.requestAnimationFrame(function () {
        ticking = false
        update()
      })
    }

    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll)
    update()
  }

  /* -------------------------------------------------------------- mobile nav */

  /* --------------------------------------------------- top navigation */
  // One dropdown per documentation section, plus a mobile panel holding all of
  // them. Everything degrades to plain links without JS: the panels are simply
  // `hidden`, and each section index page lists its own contents.

  function initTopNav() {
    var triggers = [].slice.call(document.querySelectorAll('.topnav__trigger'))
    var openTrigger = null
    var hoverTimer = null

    function panelFor(trigger) {
      return document.getElementById(trigger.getAttribute('aria-controls'))
    }

    function close(trigger) {
      if (!trigger) return
      var panel = panelFor(trigger)
      trigger.setAttribute('aria-expanded', 'false')
      if (panel) panel.hidden = true
      if (openTrigger === trigger) openTrigger = null
    }

    function closeAll() {
      for (var i = 0; i < triggers.length; i++) close(triggers[i])
    }

    function open(trigger) {
      if (openTrigger && openTrigger !== trigger) close(openTrigger)
      var panel = panelFor(trigger)
      if (!panel) return
      panel.hidden = false
      trigger.setAttribute('aria-expanded', 'true')
      openTrigger = trigger

      // Keep the panel inside the viewport on narrow desktops.
      panel.classList.remove('is-flipped')
      var rect = panel.getBoundingClientRect()
      if (rect.right > window.innerWidth - 8) panel.classList.add('is-flipped')
    }

    triggers.forEach(function (trigger, index) {
      trigger.addEventListener('click', function (event) {
        event.preventDefault()
        if (trigger.getAttribute('aria-expanded') === 'true') close(trigger)
        else open(trigger)
      })

      // Pointer users get hover-to-open once any panel is already open, which
      // makes scanning across sections feel immediate without hijacking the
      // first click.
      trigger.addEventListener('mouseenter', function () {
        if (!openTrigger) return
        window.clearTimeout(hoverTimer)
        hoverTimer = window.setTimeout(function () { open(trigger) }, 60)
      })

      trigger.addEventListener('keydown', function (event) {
        var next = null
        if (event.key === 'ArrowRight') next = (index + 1) % triggers.length
        else if (event.key === 'ArrowLeft') next = (index - 1 + triggers.length) % triggers.length
        else if (event.key === 'ArrowDown') {
          event.preventDefault()
          open(trigger)
          var first = panelFor(trigger) && panelFor(trigger).querySelector('a')
          if (first) first.focus()
          return
        }
        if (next === null) return
        event.preventDefault()
        closeAll()
        triggers[next].focus()
      })
    })

    var nav = document.querySelector('.topnav')
    if (nav) {
      nav.addEventListener('mouseleave', function () {
        window.clearTimeout(hoverTimer)
      })
    }

    document.addEventListener('click', function (event) {
      if (!event.target.closest('.topnav__item')) closeAll()
    })

    document.addEventListener('keydown', function (event) {
      if (event.key !== 'Escape' || !openTrigger) return
      var trigger = openTrigger
      closeAll()
      trigger.focus()
    })

    // Focus leaving the whole item (tabbing past the last link) closes it.
    document.addEventListener('focusin', function (event) {
      if (!openTrigger) return
      if (!event.target.closest('.topnav__item')) closeAll()
    })

    /* ------------------------------------------------- mobile panel */

    var toggle = document.getElementById('nav-toggle')
    var mobile = document.getElementById('mobile-nav')
    if (!toggle || !mobile) return

    function setMobileOpen(isOpen) {
      mobile.hidden = !isOpen
      document.body.setAttribute('data-nav', isOpen ? 'open' : 'closed')
      toggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false')
      toggle.setAttribute('aria-label', isOpen ? 'Close navigation' : 'Open navigation')
    }

    toggle.addEventListener('click', function () {
      setMobileOpen(mobile.hidden)
      if (!mobile.hidden) {
        var active = mobile.querySelector('[aria-current="page"]') || mobile.querySelector('a')
        if (active && active.scrollIntoView) active.scrollIntoView({ block: 'center' })
      }
    })

    mobile.addEventListener('click', function (event) {
      if (event.target.closest('a')) setMobileOpen(false)
    })

    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && !mobile.hidden) {
        setMobileOpen(false)
        toggle.focus()
      }
    })

    // A resize back to desktop must not leave the mobile panel stranded open.
    window.addEventListener('resize', function () {
      if (!mobile.hidden && window.innerWidth > 1180) setMobileOpen(false)
    })

    setMobileOpen(false)
  }

  /* ---------------------------------------------------------------- search */

  var searchIndex = null
  var indexPromise = null

  function loadIndex() {
    if (indexPromise) return indexPromise
    indexPromise = fetch(BASE + 'search-index.json')
      .then(function (r) {
        if (!r.ok) throw new Error('search index ' + r.status)
        return r.json()
      })
      .then(function (data) {
        searchIndex = data.pages || []
        return searchIndex
      })
      .catch(function () {
        searchIndex = []
        return searchIndex
      })
    return indexPromise
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
    })
  }

  function scoreEntry(entry, terms) {
    var title = entry.title.toLowerCase()
    var section = entry.section.toLowerCase()
    var headings = entry.headings.join(' ').toLowerCase()
    var body = entry.text.toLowerCase()

    var total = 0
    for (var i = 0; i < terms.length; i++) {
      var t = terms[i]
      var s = 0
      if (title === t) s += 240
      else if (title.indexOf(t) === 0) s += 140
      else if (title.indexOf(t) !== -1) s += 90
      if (section.indexOf(t) !== -1) s += 20
      if (headings.indexOf(t) !== -1) s += 45
      var idx = body.indexOf(t)
      if (idx !== -1) {
        s += 18
        var occurrences = body.split(t).length - 1
        s += Math.min(occurrences, 8) * 2
      }
      if (s === 0) return 0 // every term must appear somewhere
      total += s
    }
    return total
  }

  function snippetFor(entry, term) {
    var body = entry.text
    var idx = body.toLowerCase().indexOf(term)
    if (idx === -1) return escapeHtml(body.slice(0, 120)) + '…'
    var start = Math.max(0, idx - 45)
    var end = Math.min(body.length, idx + term.length + 90)
    var raw = (start > 0 ? '…' : '') + body.slice(start, end) + (end < body.length ? '…' : '')
    var safe = escapeHtml(raw)
    var safeTerm = escapeHtml(term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return safe.replace(new RegExp('(' + safeTerm + ')', 'ig'), '<mark>$1</mark>')
  }

  function initSearch() {
    var input = document.getElementById('search-input')
    var results = document.getElementById('search-results')
    if (!input || !results) return

    var selected = -1
    var hits = []

    function close() {
      results.hidden = true
      results.innerHTML = ''
      selected = -1
      hits = []
      input.setAttribute('aria-expanded', 'false')
    }

    function render(list, term) {
      hits = list
      selected = list.length ? 0 : -1
      if (!list.length) {
        results.innerHTML = '<p class="search__empty">No matches for “' + escapeHtml(term) + '”.</p>'
        results.hidden = false
        input.setAttribute('aria-expanded', 'true')
        return
      }
      results.innerHTML = list
        .map(function (entry, i) {
          return (
            '<a class="search__hit" role="option" id="search-hit-' + i + '"' +
            ' aria-selected="' + (i === 0 ? 'true' : 'false') + '"' +
            ' href="' + escapeHtml(BASE + entry.url) + '">' +
            '<span class="search__hit-section">' + escapeHtml(entry.section) + '</span>' +
            '<span class="search__hit-title">' + escapeHtml(entry.title) + '</span>' +
            '<span class="search__hit-snippet">' + snippetFor(entry, term) + '</span>' +
            '</a>'
          )
        })
        .join('')
      results.hidden = false
      input.setAttribute('aria-expanded', 'true')
    }

    function move(delta) {
      if (!hits.length) return
      var nodes = results.querySelectorAll('.search__hit')
      if (selected >= 0 && nodes[selected]) nodes[selected].setAttribute('aria-selected', 'false')
      selected = (selected + delta + hits.length) % hits.length
      var node = nodes[selected]
      if (node) {
        node.setAttribute('aria-selected', 'true')
        node.scrollIntoView({ block: 'nearest' })
        input.setAttribute('aria-activedescendant', node.id)
      }
    }

    var timer = null
    input.addEventListener('input', function () {
      window.clearTimeout(timer)
      var raw = input.value.trim()
      if (raw.length < 2) {
        close()
        return
      }
      timer = window.setTimeout(function () {
        loadIndex().then(function (index) {
          var terms = raw.toLowerCase().split(/\s+/).filter(Boolean)
          var scored = []
          for (var i = 0; i < index.length; i++) {
            var s = scoreEntry(index[i], terms)
            if (s > 0) scored.push({ entry: index[i], score: s })
          }
          scored.sort(function (a, b) {
            return b.score - a.score
          })
          render(
            scored.slice(0, 12).map(function (x) {
              return x.entry
            }),
            terms[0]
          )
        })
      }, 90)
    })

    input.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        move(1)
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        move(-1)
      } else if (e.key === 'Enter') {
        var nodes = results.querySelectorAll('.search__hit')
        if (selected >= 0 && nodes[selected]) {
          e.preventDefault()
          window.location.href = nodes[selected].getAttribute('href')
        }
      } else if (e.key === 'Escape') {
        close()
        input.blur()
      }
    })

    input.addEventListener('focus', function () {
      loadIndex()
    })

    document.addEventListener('click', function (e) {
      if (!e.target.closest('.search')) close()
    })

    document.addEventListener('keydown', function (e) {
      var isSlash = e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey
      var isCmdK = (e.key === 'k' || e.key === 'K') && (e.metaKey || e.ctrlKey)
      var tag = (document.activeElement && document.activeElement.tagName) || ''
      var typing = tag === 'INPUT' || tag === 'TEXTAREA' || (document.activeElement && document.activeElement.isContentEditable)
      if ((isSlash && !typing) || isCmdK) {
        e.preventDefault()
        input.focus()
        input.select()
      }
    })
  }

  /* ------------------------------------------------------------------- boot */

  function boot() {
    initTheme()
    initCopyButtons()
    initTabs()
    initScrollSpy()
    initTopNav()
    initSearch()
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot)
  else boot()
})()
