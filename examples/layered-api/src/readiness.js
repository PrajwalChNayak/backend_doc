/**
 * Liveness and readiness are different questions.
 *
 *   /health  — "is this process alive?"   Never depends on anything else.
 *   /ready   — "should traffic be sent here?"  Goes false the instant SIGTERM
 *              arrives, so the load balancer stops sending new requests while
 *              the in-flight ones drain.
 *
 * Getting this wrong is the usual cause of dropped requests during a deploy: if
 * readiness only flips when the process is already closing sockets, the balancer
 * is still routing to a server that will RST the connection.
 */
const state = { ready: true, shuttingDown: false }

export function isReady() {
  return state.ready
}

export function isShuttingDown() {
  return state.shuttingDown
}

export function beginShutdown() {
  state.ready = false
  state.shuttingDown = true
}

export function resetReadiness() {
  state.ready = true
  state.shuttingDown = false
}
