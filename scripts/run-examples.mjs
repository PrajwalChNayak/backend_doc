#!/usr/bin/env node
/**
 * run-examples.mjs — boots every app under examples/ and exercises its routes.
 *
 *   node scripts/run-examples.mjs                 # all examples
 *   node scripts/run-examples.mjs layered-api     # one (substring match)
 *   node scripts/run-examples.mjs --no-tests      # skip `npm test`
 *
 * For each example it:
 *   1. checks dependencies are installed
 *   2. runs the `setup` / `migrate` / `seed` npm scripts if they exist
 *   3. boots the server on a dedicated port
 *   4. polls GET /health until it answers
 *   5. replays the requests in the example's smoke.json (if present)
 *   6. runs `npm test` if the example has tests
 *   7. shuts the server down and reports
 *
 * An example that needs an external database is expected to fail its health
 * poll when that database is absent. Those are reported as SKIPPED (service
 * unavailable) rather than FAILED, and the report says which ones they were —
 * the point is an honest picture, not a green tick.
 *
 * smoke.json (optional, per example):
 *   {
 *     "port": 3001,
 *     "entry": "src/server.js",
 *     "requiresService": false,
 *     "requests": [
 *       { "method": "GET",  "path": "/health", "expect": 200 },
 *       { "method": "POST", "path": "/users",  "body": { "email": "a@b.c" }, "expect": 201 }
 *     ]
 *   }
 */

import { readFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const EXAMPLES = path.join(ROOT, 'examples')

const args = process.argv.slice(2)
const RUN_TESTS = !args.includes('--no-tests')
const filters = args.filter((a) => !a.startsWith('--'))

const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const BOOT_TIMEOUT_MS = 25_000
const REQUEST_TIMEOUT_MS = 8_000
const TEST_TIMEOUT_MS = 120_000

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ------------------------------------------------------------------ helpers */

function runSync(command, cmdArgs, cwd, timeout = 180_000) {
  // npm is a .cmd shim on Windows, which Node will not spawn without a shell.
  // Pass one pre-joined command string so no argument is separately unescaped.
  const useShell = process.platform === 'win32'
  const res = spawnSync(useShell ? [command, ...cmdArgs].join(' ') : command, useShell ? [] : cmdArgs, {
    cwd,
    timeout,
    encoding: 'utf8',
    shell: useShell,
    env: { ...process.env, npm_config_yes: 'true' },
  })
  return {
    ok: res.status === 0,
    status: res.status,
    stdout: res.stdout || '',
    stderr: res.stderr || '',
    error: res.error,
  }
}

/** Pulls the script file out of a `node …` start script so we can skip npm. */
function entryFromStartScript(script) {
  if (!script) return null
  const m = /(?:^|\s)((?:src|bin|\.)[^\s"']*\.(?:mjs|cjs|js|ts))/.exec(script)
  return m ? m[1] : null
}

/**
 * Runs a package script.
 *
 * `npm run <x>` would spawn whatever `node` is first on PATH, which is not
 * necessarily the runtime this script is running under — on a machine with an
 * older Node on PATH that silently tests the examples against the wrong
 * version. So a script that is a plain `node …` invocation is executed with
 * `process.execPath` directly, and only anything more complicated falls back
 * to npm.
 */
function runPackageScript(dir, name, scripts, timeout) {
  const script = scripts[name]
  if (!script) return null

  const direct = /^node\s+(.+)$/.exec(script.trim())
  if (direct && !/[|&><]/.test(direct[1])) {
    const res = spawnSync(process.execPath, direct[1].split(/\s+/), {
      cwd: dir,
      timeout,
      encoding: 'utf8',
      env: { ...process.env, NODE_ENV: 'test' },
    })
    return { ok: res.status === 0, stdout: res.stdout || '', stderr: res.stderr || '', via: 'node' }
  }
  const r = runSync(NPM, ['run', name, '--silent'], dir, timeout)
  return { ...r, via: 'npm' }
}

async function poll(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let lastError = 'no attempt made'
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) })
      const text = await res.text()
      return { ok: true, status: res.status, body: text.slice(0, 200) }
    } catch (e) {
      lastError = e.message
      await sleep(300)
    }
  }
  return { ok: false, error: lastError }
}

async function request(base, spec) {
  const url = base + spec.path
  const init = {
    method: spec.method || 'GET',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { ...(spec.headers || {}) },
  }
  if (spec.body !== undefined) {
    init.headers['content-type'] = init.headers['content-type'] || 'application/json'
    init.body = typeof spec.body === 'string' ? spec.body : JSON.stringify(spec.body)
  }
  try {
    const res = await fetch(url, init)
    const text = await res.text()
    const expected = spec.expect ?? 200
    const expectedList = Array.isArray(expected) ? expected : [expected]
    return {
      ok: expectedList.includes(res.status),
      status: res.status,
      expected: expectedList.join('/'),
      body: text.slice(0, 160).replace(/\s+/g, ' '),
    }
  } catch (e) {
    return { ok: false, status: 0, expected: String(spec.expect ?? 200), body: e.message }
  }
}

/* -------------------------------------------------------------------- runner */

async function runExample(name, port) {
  const dir = path.join(EXAMPLES, name)
  const result = { name, steps: [], requests: [], status: 'unknown', notes: [] }

  const pkg = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8'))
  const scripts = pkg.scripts || {}

  let smoke = {}
  const smokeFile = path.join(dir, 'smoke.json')
  if (existsSync(smokeFile)) smoke = JSON.parse(await readFile(smokeFile, 'utf8'))

  const effectivePort = smoke.port || port
  const base = `http://127.0.0.1:${effectivePort}`

  // 1. dependencies -------------------------------------------------------
  const hasDeps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).length > 0
  if (hasDeps && !existsSync(path.join(dir, 'node_modules'))) {
    result.status = 'not-installed'
    result.notes.push('node_modules missing — run `npm install` in this example first')
    return result
  }

  // 2. setup scripts ------------------------------------------------------
  for (const step of ['setup', 'migrate', 'seed']) {
    const r = runPackageScript(dir, step, scripts, 180_000)
    if (!r) continue
    result.steps.push({ step, ok: r.ok, output: (r.stderr || r.stdout).trim().split('\n').slice(-3).join(' | ') })
    if (!r.ok) {
      // An example that needs Postgres/MySQL/Mongo/Redis is expected to fail
      // its migrate step when that service is absent. That is the documented
      // behaviour, not a broken example.
      result.status = smoke.requiresService ? 'skipped-no-service' : 'setup-failed'
      if (smoke.requiresService) result.notes.push('external service not running — setup step declined cleanly')
      return result
    }
  }

  // 3. boot ---------------------------------------------------------------
  const entry = smoke.entry || entryFromStartScript(scripts.start)
  if (!entry) {
    result.status = 'no-entry'
    result.notes.push(`could not determine an entry file from start script: ${scripts.start || '(none)'}`)
    return result
  }

  const child = spawn(process.execPath, [entry], {
    cwd: dir,
    env: { ...process.env, PORT: String(effectivePort), NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (d) => (stdout += d))
  child.stderr.on('data', (d) => (stderr += d))

  let exited = null
  child.on('exit', (code) => (exited = code))

  const health = await poll(`${base}/health`, BOOT_TIMEOUT_MS)

  if (!health.ok) {
    const output = (stderr + stdout).trim()
    const looksLikeMissingService =
      smoke.requiresService === true ||
      /ECONNREFUSED|ENOTFOUND|connect ETIMEDOUT|MongoServerSelectionError|getaddrinfo|Redis|no pg_hba|password authentication/i.test(
        output
      )
    result.status = looksLikeMissingService ? 'skipped-no-service' : 'boot-failed'
    result.notes.push(output.split('\n').slice(0, 6).join('\n').slice(0, 700) || `no output; exit code ${exited}`)
    child.kill('SIGKILL')
    return result
  }

  result.steps.push({ step: 'boot', ok: true, output: `GET /health -> ${health.status}` })

  // 4. smoke requests -----------------------------------------------------
  const specs = smoke.requests?.length ? smoke.requests : [{ method: 'GET', path: '/health', expect: 200 }]
  for (const spec of specs) {
    result.requests.push({ label: `${spec.method || 'GET'} ${spec.path}`, ...(await request(base, spec)) })
  }

  // 5. shutdown -----------------------------------------------------------
  child.kill('SIGTERM')
  const gone = await Promise.race([
    new Promise((r) => child.once('exit', () => r(true))),
    sleep(6000).then(() => false),
  ])
  if (!gone) {
    result.notes.push('did not exit within 6s of SIGTERM — killed')
    child.kill('SIGKILL')
  } else {
    result.steps.push({ step: 'graceful shutdown', ok: true, output: 'exited on SIGTERM' })
  }

  // 6. tests --------------------------------------------------------------
  if (RUN_TESTS && scripts.test) {
    const r = runPackageScript(dir, 'test', scripts, TEST_TIMEOUT_MS)
    const out = (r.stdout + '\n' + r.stderr).trim()
    // The TAP reporter prints "# pass N"; the default spec reporter prints "ℹ pass N".
    const passMatch = /[#ℹ]\s*pass\s+(\d+)/.exec(out)
    const failMatch = /[#ℹ]\s*fail\s+(\d+)/.exec(out)
    result.tests = {
      ok: r.ok,
      pass: passMatch ? Number(passMatch[1]) : null,
      fail: failMatch ? Number(failMatch[1]) : null,
      tail: out.split('\n').slice(-8).join('\n'),
    }
  }

  const allRequestsOk = result.requests.every((r) => r.ok)
  const testsOk = !result.tests || result.tests.ok

  // A service-backed example that booted, answered, and reported itself
  // "degraded" did exactly what it is documented to do without the service.
  const degraded = result.requests.some((r) => r.status === 503)
  if (smoke.requiresService && allRequestsOk && degraded) {
    result.status = 'degraded-no-service'
    result.notes.push('booted and answered correctly, but reported its dependency unreachable')
    return result
  }

  result.status = allRequestsOk && testsOk ? 'passed' : 'failed'
  return result
}

/* --------------------------------------------------------------------- main */

async function main() {
  if (!existsSync(EXAMPLES)) {
    console.error('examples/ does not exist')
    process.exit(1)
  }

  const all = (await readdir(EXAMPLES, { withFileTypes: true }))
    .filter((e) => e.isDirectory() && existsSync(path.join(EXAMPLES, e.name, 'package.json')))
    .map((e) => e.name)
    .sort()

  const selected = filters.length ? all.filter((n) => filters.some((f) => n.includes(f))) : all

  console.log('')
  console.log('  scripts/run-examples.mjs — example execution')
  console.log('  ─────────────────────────────────────────────')
  console.log(`  node             ${process.version}`)
  console.log(`  examples found   ${all.length}${filters.length ? ` (running ${selected.length})` : ''}`)
  console.log('')

  const results = []
  let port = 4100
  for (const name of selected) {
    process.stdout.write(`  → ${name} … `)
    let result
    try {
      result = await runExample(name, port++)
    } catch (e) {
      result = { name, status: 'error', notes: [e.message], steps: [], requests: [] }
    }
    results.push(result)
    console.log(result.status.toUpperCase())
  }

  /* ------------------------------------------------------------- report */

  console.log('')
  console.log('  Results')
  console.log('  ─────────────────────────────────────────────')

  for (const r of results) {
    const soft = ['skipped-no-service', 'degraded-no-service', 'not-installed']
    const mark = r.status === 'passed' ? '✓' : soft.includes(r.status) ? '·' : '✖'
    console.log(`  ${mark} ${r.name} — ${r.status}`)
    for (const s of r.steps) console.log(`      ${s.ok ? '✓' : '✖'} ${s.step}: ${s.output}`)
    for (const q of r.requests) {
      console.log(`      ${q.ok ? '✓' : '✖'} ${q.label} -> ${q.status} (expected ${q.expected})`)
      if (!q.ok) console.log(`          ${q.body}`)
    }
    if (r.tests) {
      console.log(
        `      ${r.tests.ok ? '✓' : '✖'} npm test: ${r.tests.pass ?? '?'} passed, ${r.tests.fail ?? '?'} failed`
      )
      if (!r.tests.ok) {
        for (const line of r.tests.tail.split('\n')) console.log(`          ${line}`)
      }
    }
    for (const n of r.notes) {
      for (const line of String(n).split('\n')) console.log(`      | ${line}`)
    }
  }

  const counts = results.reduce((acc, r) => ((acc[r.status] = (acc[r.status] || 0) + 1), acc), {})
  console.log('')
  console.log('  Summary')
  for (const [k, v] of Object.entries(counts).sort()) console.log(`    ${k.padEnd(20)} ${v}`)

  const totalRequests = results.reduce((n, r) => n + r.requests.length, 0)
  const okRequests = results.reduce((n, r) => n + r.requests.filter((q) => q.ok).length, 0)
  const testPass = results.reduce((n, r) => n + (r.tests?.pass || 0), 0)
  const testFail = results.reduce((n, r) => n + (r.tests?.fail || 0), 0)
  console.log(`    ${'http requests'.padEnd(20)} ${okRequests}/${totalRequests} as expected`)
  console.log(`    ${'unit tests'.padEnd(20)} ${testPass} passed, ${testFail} failed`)
  console.log('')

  const hardFailures = results.filter((r) =>
    ['failed', 'boot-failed', 'setup-failed', 'error', 'no-entry'].includes(r.status)
  )
  if (hardFailures.length) process.exit(1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
