/**
 * All environment reading happens here and nowhere else.
 *
 * Every other module imports `config`, so there is exactly one place to look when
 * you want to know what the process is configured with — and exactly one place a
 * test has to override.
 */
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

function num(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function list(value, fallback) {
  if (!value) return fallback
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

export function loadConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV ?? 'development'
  const isProduction = nodeEnv === 'production'

  // In production a missing secret must be fatal. In development we generate an
  // ephemeral one so `npm start` works with zero setup — tokens simply do not
  // survive a restart, which is the honest trade-off.
  let jwtSecret = env.JWT_SECRET
  if (!jwtSecret) {
    if (isProduction) throw new Error('JWT_SECRET is required in production')
    jwtSecret = crypto.randomBytes(32).toString('hex')
  }

  return {
    nodeEnv,
    isProduction,
    port: num(env.PORT, 3002),

    // A temp file, not ':memory:', so the example demonstrates a real file handle
    // that graceful shutdown has to close. Removed again on clean exit.
    databaseFile:
      env.DATABASE_FILE ??
      path.join(os.tmpdir(), `layered-api-${crypto.randomUUID()}.sqlite`),

    jwt: {
      secret: jwtSecret,
      issuer: env.JWT_ISSUER ?? 'https://layered-api.example',
      audience: env.JWT_AUDIENCE ?? 'layered-api-clients',
      expiresIn: env.JWT_EXPIRES_IN ?? '15m',
      algorithm: 'HS256',
    },

    cors: {
      // Exact-match allow-list. Never reflect an arbitrary Origin header back.
      allowedOrigins: list(env.CORS_ORIGINS, [
        'http://localhost:5173',
        'http://localhost:3000',
      ]),
    },

    rateLimit: {
      windowMs: num(env.RATE_LIMIT_WINDOW_MS, 60_000),
      max: num(env.RATE_LIMIT_MAX, 100),
      authMax: num(env.RATE_LIMIT_AUTH_MAX, 10),
    },

    logLevel: env.LOG_LEVEL ?? (nodeEnv === 'test' ? 'silent' : 'info'),

    shutdown: {
      // How long in-flight requests get to finish before we stop being polite.
      drainDeadlineMs: num(env.SHUTDOWN_DEADLINE_MS, 10_000),
    },
  }
}

export const config = loadConfig()
export default config
