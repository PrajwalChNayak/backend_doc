---
title: Debugging
description: The inspector, CPU and heap profiles, diagnostic reports, and the trace flags that turn a vague Node problem into a specific one.
status: current
updated: 2026-09-08
---

`console.log` is a fine first tool and a terrible only tool. Node ships a full debugger protocol, two profilers, heap snapshots and a diagnostic report generator — all built in, all usable against a process that is already misbehaving. This page is the toolbox, roughly in the order you should reach for things.

## The inspector

```bash
node --inspect src/server.js          # attach any time, keep running
node --inspect-brk src/server.js      # pause on the first line, wait for a debugger
node --inspect-wait src/server.js     # run only once a debugger attaches
```

The inspector listens on `127.0.0.1:9229` by default. Change it with `--inspect=127.0.0.1:9230` when you need a second process, or when the port is taken.

Use `--inspect-brk` when the bug is in startup code that runs before you could possibly attach.

:::danger
**The inspector port is remote code execution.** Anyone who can reach it can evaluate arbitrary JavaScript in your process — read secrets from memory, open files, make outbound calls. Never bind it to `0.0.0.0`, never expose it through a load balancer or a Kubernetes Service, and never leave `--inspect` in a production start command or `NODE_OPTIONS`. To debug a remote process, forward the port over SSH and keep the listener on loopback:

```bash
ssh -N -L 9229:127.0.0.1:9229 user@host
```
:::

### Attaching a client

**Chrome DevTools** — open `chrome://inspect`, and the target appears under "Remote Target". Click *inspect* for a full DevTools window with breakpoints, the console, the profiler and heap tools.

**VS Code** — an attach configuration, with source maps and `node_modules` skipped so stepping does not drop you into library internals:

```json title=".vscode/launch.json"
{
  "version": "0.2.0",
  "configurations": [
    {
      "type": "node",
      "request": "attach",
      "name": "Attach to API",
      "port": 9229,
      "restart": true,
      "sourceMaps": true,
      "skipFiles": ["<node_internals>/**", "${workspaceFolder}/node_modules/**"]
    },
    {
      "type": "node",
      "request": "launch",
      "name": "Run tests",
      "runtimeArgs": ["--test"],
      "console": "integratedTerminal",
      "skipFiles": ["<node_internals>/**"]
    }
  ]
}
```

`"restart": true` makes VS Code reattach after a `--watch` restart, which is the difference between a usable and an infuriating loop.

You can also drop a `debugger;` statement in the code; it is a no-op unless an inspector is attached.

## `NODE_OPTIONS`

`NODE_OPTIONS` injects flags into every Node process started in that environment — useful when a tool, a package script or a container entrypoint spawns Node for you and you cannot edit the command line:

```bash
NODE_OPTIONS="--enable-source-maps --stack-trace-limit=50" npm test
```

Not every flag is permitted there — Node rejects the ones that would be unsafe or ambiguous to inherit — and the value applies to child processes too, so a stray `--inspect` in a shell profile means every Node process fights for port 9229.

## Profiling CPU

When a service is slow or the event loop is stalling, sample it:

```bash
node --cpu-prof --cpu-prof-dir=./profiles src/server.js
```

Exercise the slow path, then stop the process with `SIGINT`. On exit Node writes a `.cpuprofile` file. Load it into Chrome DevTools (Performance tab → *Load profile*) and read the bottom-up view: the function with the highest **self time** is where the CPU actually went.

| Flag | Purpose |
| --- | --- |
| `--cpu-prof` | start the sampling profiler; write on exit |
| `--cpu-prof-dir=<dir>` | output directory |
| `--cpu-prof-name=<file>` | output filename |
| `--cpu-prof-interval=<µs>` | sampling interval; lower is more detail and more overhead |

The profile only shows JavaScript on the main thread. If the CPU time is inside a native addon or the libuv threadpool, it will look like idle time here — cross-reference with event-loop delay measurements from [Runtime and the event loop](./runtime-and-event-loop.md).

## Profiling memory

Two different questions, two different tools.

**"Where are allocations coming from?"** — the heap profiler samples allocation sites over time:

```bash
node --heap-prof --heap-prof-dir=./profiles src/server.js
```

**"What is in the heap right now?"** — a heap snapshot is a complete object graph. Take two, at a known interval, and use the DevTools comparison view; objects that grew between them are your leak.

```bash
node --heapsnapshot-signal=SIGUSR2 src/server.js
kill -USR2 <pid>     # writes a .heapsnapshot into the working directory
```

Or from inside the process, which is the only option on Windows:

```js title="src/diagnostics.js"
import v8 from 'node:v8'

export function snapshot() {
  return v8.writeHeapSnapshot()      // returns the filename it wrote
}
```

:::warning
A heap snapshot pauses the process for as long as it takes to walk the heap — seconds on a large heap — and writes a file roughly the size of the heap. Take one on an instance you have already removed from the load balancer.
:::

`--heapsnapshot-near-heap-limit=<n>` writes up to `n` snapshots automatically as the process approaches its heap limit, which is how you catch an OOM that only happens in production at 4 a.m.

## Diagnostic reports

A diagnostic report is a JSON dump of the process state: stack traces for every thread, resource usage, libuv handles, environment, loaded shared objects. It is the single most useful artifact for "the process died and I have no idea why".

```bash
node --report-uncaught-exception --report-on-signal src/server.js
kill -USR2 <pid>          # or let an uncaught exception trigger it
```

```js
process.report.writeReport()     // on demand, e.g. from an admin endpoint
```

The `libuv` section lists every open handle, which is how you find the 4,000 leaked sockets that a heap snapshot would not have made obvious.

:::note
Reports contain the full environment block, including secrets held in environment variables. Treat a report file as sensitive: do not attach one to a public issue tracker without redacting it.
:::

## Trace and diagnostic flags

| Flag | What it gives you |
| --- | --- |
| `--enable-source-maps` | stack traces mapped back to your original source |
| `--trace-warnings` | the **stack** behind every process warning, not just the message |
| `--trace-uncaught` | the stack of the `throw` that produced an uncaught exception |
| `--trace-deprecation` | stack for each deprecation warning; `--throw-deprecation` turns them into errors |
| `--trace-exit` | the stack that called `process.exit()` |
| `--trace-sync-io` | warns when synchronous I/O happens after the first turn of the event loop |
| `--stack-trace-limit=<n>` | frames captured per stack; default is 10 |

`--trace-warnings` is the answer to "some package is printing a `MaxListenersExceededWarning` and I cannot find it". `--trace-sync-io` is the answer to "something is blocking the loop and I cannot find the `readFileSync`".

`--stack-trace-limit=50` costs a little memory and turns a truncated async stack into a readable one. It is a reasonable default in development and in CI; leave it at the default in production where stacks are captured on every error.

Source maps deserve emphasis: if you compile or bundle, a stack trace without `--enable-source-maps` points at line 1 of a minified file and tells you nothing.

## Logging that helps

```js title="src/inspect.js"
import { inspect } from 'node:util'

console.log(inspect(config, { depth: null, colors: true, breakLength: 120 }))
```

`console.log` on a deep object truncates at depth 2 and prints `[Object]`. `util.inspect` with `depth: null` shows the whole thing.

Two environment variables are worth knowing:

```bash
NODE_DEBUG=http,net node src/server.js      # Node core's own internal tracing
DEBUG=express:*,router,router:* node src/server.js
```

`NODE_DEBUG` enables verbose logging inside Node's own modules — invaluable for connection and keep-alive problems.

`DEBUG` drives the `debug` package that Express uses. **Express 5 moved its namespaces**: the router was extracted into a separate `router` package, so `DEBUG=express:*` alone no longer shows routing decisions. Use `DEBUG=express:*,router,router:*` to see the full request path.

In production, use a structured logger instead of `console.log` so your log pipeline can index fields — see [Logging](../express-libraries/logging.md).

## Common patterns

### Fast feedback while developing

```bash
node --watch --env-file-if-exists=.env src/server.js
node --test --watch
```

`--watch` restarts on file change and needs no `nodemon`. `--watch-path` narrows what it monitors when the default set is too broad.

`node --run <script>` executes a `package.json` script without npm's startup cost, which is noticeable when you run it hundreds of times a day:

```bash
node --run dev
```

It skips `pre`/`post` scripts — see [package.json and npm scripts](./package-json-and-npm-scripts.md).

### Reproducing a production-only bug

Work in this order, because each step is cheaper than the next:

1. **Read the error properly.** Turn on `--enable-source-maps` and log `err.cause` chains; half of "mysterious" failures are legible once the stack is real.
2. **Add structured context, not more logs.** A request id on every line beats ten new `console.log` calls.
3. **Measure the loop.** `monitorEventLoopDelay` distinguishes "slow dependency" from "blocked process".
4. **Profile.** `--cpu-prof` for CPU, heap snapshots for memory growth.
5. **Attach the inspector** — over an SSH tunnel, on an instance out of rotation.

### Debugging tests

```bash
node --inspect-brk --test src/users.test.js
```

The runner pauses before the first test so you can set breakpoints, and `--test-concurrency` does not get in the way when you pass a single file.

## Common mistakes

- **Leaving `--inspect` on in production.** An open inspector port is remote code execution.
- **Binding the inspector to `0.0.0.0`** "just to debug from my laptop". Use an SSH tunnel.
- **Profiling a process that is not doing the slow thing.** Start the profiler, reproduce the load, then stop.
- **Reading a minified stack trace without source maps.** Add `--enable-source-maps`.
- **Chasing a warning by grepping.** `--trace-warnings` prints the stack that caused it.
- **Taking a heap snapshot on a live instance.** It pauses the process for seconds. Drain it first.
- **Sharing a diagnostic report unredacted.** It contains the full environment, secrets included.
- **`console.log` on a deep object and concluding the data is `[Object]`.** Use `util.inspect` with `depth: null`.
- **Expecting `DEBUG=express:*` to show Express 5 routing.** The router is a separate package now: `DEBUG=express:*,router,router:*`.
- **A stray `--inspect` in a shell profile's `NODE_OPTIONS`.** Every Node process then fights for port 9229.

## Related topics

- [Runtime and the event loop](./runtime-and-event-loop.md) — measuring loop delay before you profile.
- [Error handling](./error-handling.md) — `Error.cause`, trace flags, and crashing usefully.
- [The built-in test runner](./built-in-test-runner.md) — debugging and watching tests.
- [package.json and npm scripts](./package-json-and-npm-scripts.md) — `node --run` and script layout.
- [Logging](../express-libraries/logging.md) — structured logs and request ids in production.
- [Observability](../production/observability.md) — metrics and traces, where debugging stops being local.
- [Troubleshooting](../reference/troubleshooting.md) — symptom-to-cause lookup for common failures.
