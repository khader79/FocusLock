import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import express, { type Express, type NextFunction, type Request, type Response } from 'express'

const PORT = Number(process.env['PORT'] ?? 3000)

const HOUR_MS = 3_600_000
const MIN_HOURS = 1
const MAX_HOURS = 24 * 365

const MAX_SECRET_BYTES = 64 * 1024 // 64 KiB
const MAX_EMAIL_LENGTH = 254

const STORE_RETENTION_MS = 24 * HOUR_MS // keep a lock 24h after it releases
const PRUNE_INTERVAL_MS = 5 * 60_000

const MAX_BODY_BYTES = '256kb'

interface LockRecord {
  id: string
  encryptedSecret: string
  contactEmail: string
  releaseAt: number
  createdAt: number
}

// In-memory lock store.
// TODO: swap for Redis (ioredis / @redis/client) with `SET key EX <ttl>` so
// locks survive restarts, work across multiple API instances, and reveal is
// still enforced if the process crashes. Wrap the Map behind a small store
// interface before migrating so the routes don't change.
const locks = new Map<string, LockRecord>()

/* --------------------------------------------------------------------------
 * Input validation
 * ------------------------------------------------------------------------ */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

interface CreateLockData {
  encryptedSecret: string
  hours: number
  contactEmail: string
}

type ValidationResult =
  | { ok: true; data: CreateLockData }
  | { ok: false; errors: string[] }

function validateCreate(body: unknown): ValidationResult {
  const errors: string[] = []
  const b = (typeof body === 'object' && body !== null ? body : {}) as Record<
    string,
    unknown
  >

  const encryptedSecret =
    typeof b.encryptedSecret === 'string' ? b.encryptedSecret.trim() : ''
  if (encryptedSecret.length < 1) {
    errors.push('encryptedSecret must be a non-empty string')
  } else if (Buffer.byteLength(encryptedSecret, 'utf8') > MAX_SECRET_BYTES) {
    errors.push(`encryptedSecret must be at most ${MAX_SECRET_BYTES} bytes`)
  }

  const hours = b.hours
  const hoursNum = typeof hours === 'number' && Number.isInteger(hours) ? hours : NaN
  if (!Number.isInteger(hoursNum) || hoursNum < MIN_HOURS || hoursNum > MAX_HOURS) {
    errors.push(`hours must be an integer between ${MIN_HOURS} and ${MAX_HOURS}`)
  }

  const contactEmail = typeof b.contactEmail === 'string' ? b.contactEmail.trim() : ''
  if (contactEmail.length < 1) {
    errors.push('contactEmail must be a non-empty string')
  } else if (contactEmail.length > MAX_EMAIL_LENGTH) {
    errors.push(`contactEmail must be at most ${MAX_EMAIL_LENGTH} characters`)
  } else if (!EMAIL_RE.test(contactEmail)) {
    errors.push('contactEmail must be a valid email address')
  }

  if (errors.length > 0) return { ok: false, errors }

  return {
    ok: true,
    data: { encryptedSecret, hours: hoursNum, contactEmail },
  }
}

/* --------------------------------------------------------------------------
 * Rate limiting
 * ------------------------------------------------------------------------ */

interface RateLimitState {
  count: number
  resetAt: number
}

interface RateLimitOptions {
  windowMs: number
  max: number
  message: string
}

// In-memory fixed-window rate limiter keyed by client IP.
// TODO: move this alongside the lock store into Redis (INCR + EXPIRE) once
// the Map is replaced. Behind a reverse proxy, set `app.set('trust proxy',
// 1)` and key on the X-Forwarded-For IP instead.
function rateLimit({ windowMs, max, message }: RateLimitOptions) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const now = Date.now()
    const key = req.ip ?? 'unknown'
    const state = rateBuckets.get(key)

    if (state === undefined || state.resetAt <= now) {
      rateBuckets.set(key, { count: 1, resetAt: now + windowMs })
      next()
      return
    }

    state.count += 1
    if (state.count > max) {
      res.status(429).json({ error: message })
      return
    }

    next()
  }
}

const rateBuckets = new Map<string, RateLimitState>()

const generalLimiter = rateLimit({
  windowMs: 15 * 60_000,
  max: 300,
  message: 'Too many requests — slow down',
})

const createLimiter = rateLimit({
  windowMs: 60 * 60_000,
  max: 10,
  message: 'Too many locks created — try again later',
})

/* --------------------------------------------------------------------------
 * Housekeeping
 * ------------------------------------------------------------------------ */

function pruneExpired(): void {
  const now = Date.now()

  for (const [key, state] of rateBuckets) {
    if (state.resetAt <= now) rateBuckets.delete(key)
  }

  for (const [id, record] of locks) {
    if (record.releaseAt + STORE_RETENTION_MS <= now) locks.delete(id)
  }
}

/* --------------------------------------------------------------------------
 * App
 * ------------------------------------------------------------------------ */

export const app: Express = express()

app.use(express.json({ limit: MAX_BODY_BYTES }))

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' })
})

app.use('/lock', generalLimiter)

app.post('/lock', createLimiter, (req, res) => {
  const validated = validateCreate(req.body)
  if (!validated.ok) {
    res.status(400).json({ error: validated.errors.join('; ') })
    return
  }

  const { encryptedSecret, hours, contactEmail } = validated.data
  const releaseAt = Date.now() + hours * HOUR_MS
  const record: LockRecord = {
    id: randomUUID(),
    encryptedSecret,
    contactEmail,
    releaseAt,
    createdAt: Date.now(),
  }
  locks.set(record.id, record)
  res.status(201).json({ id: record.id, releaseAt })
})

app.get('/lock/:id/status', (req, res) => {
  const id = req.params.id
  const record = id === undefined ? undefined : locks.get(id)
  if (record === undefined) {
    res.status(404).json({ error: 'Lock not found' })
    return
  }

  res.json({ ready: Date.now() >= record.releaseAt, releaseAt: record.releaseAt })
})

app.get('/lock/:id/reveal', (req, res) => {
  const id = req.params.id
  const record = id === undefined ? undefined : locks.get(id)
  if (record === undefined) {
    res.status(404).json({ error: 'Lock not found' })
    return
  }

  if (Date.now() < record.releaseAt) {
    res.status(403).json({
      error: `Locked until ${new Date(record.releaseAt).toISOString()}`,
    })
    return
  }

  res.json({ encryptedSecret: record.encryptedSecret })
})

/* --------------------------------------------------------------------------
 * Errors & startup
 * ------------------------------------------------------------------------ */

function isClientError(err: unknown): err is { status: number } {
  if (typeof err !== 'object' || err === null) return false
  const status = (err as { status?: unknown }).status
  return typeof status === 'number' && status >= 400 && status < 500
}

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (isClientError(err)) {
    res.status(err.status).json({
      error: err.status === 413 ? 'Body too large' : 'Malformed request body',
    })
    return
  }

  console.error(err)
  res.status(500).json({ error: 'Internal server error' })
})

const pruner = setInterval(pruneExpired, PRUNE_INTERVAL_MS)
pruner.unref()

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  app.listen(PORT, () => {
    console.log(`@focuslock/server listening on :${PORT}`)
  })
}