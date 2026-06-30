// Tiny structured logger for the web app.
//
// In production, every call serialises to a single-line JSON object on
// stdout/stderr so log aggregators (Vercel, Logflare, Datadog, etc.) can
// parse it without an SDK. In development, calls render as human-readable
// console output instead.
//
// Sensitive keys are redacted before serialisation — the denylist matches
// substring-by-name so `apiKey`, `apikey`, `api_key`, `headers.authorization`
// all collapse to `"[REDACTED]"`. Keep the list short and grow it only when
// a real leak risk shows up; an over-aggressive scrubber hides bugs.
//
// Why not pino: zero extra runtime dep, no transport setup, fits the
// uselu-on-Vercel deploy where stdout IS the transport.

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export type LogContext = Record<string, unknown>

const DENY_SUBSTRINGS = [
  'password',
  'token',
  'secret',
  'authorization',
  'cookie',
  'apikey',
  'api_key',
  'service_role',
  'private_key',
]

const isProd = () => process.env.NODE_ENV === 'production'

function scrub(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || value === undefined) return value
  if (typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const lower = k.toLowerCase()
    if (DENY_SUBSTRINGS.some((d) => lower.includes(d))) {
      out[k] = '[REDACTED]'
    } else {
      out[k] = scrub(v, depth + 1)
    }
  }
  return out
}

function serializeError(err: unknown): Record<string, unknown> | unknown {
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
      stack: err.stack,
    }
  }
  return err
}

function emit(level: LogLevel, msg: string, ctx?: LogContext): void {
  if (level === 'debug' && isProd()) return

  const safeCtx = ctx
    ? Object.fromEntries(
        Object.entries(ctx).map(([k, v]) => [
          k,
          k.toLowerCase() === 'err' || k.toLowerCase() === 'error'
            ? serializeError(v)
            : v,
        ]),
      )
    : undefined
  const cleaned = scrub(safeCtx) as LogContext | undefined

  if (isProd()) {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      msg,
      ...(cleaned ?? {}),
    })
    if (level === 'error' || level === 'warn') console.error(line)
    else console.log(line)
    return
  }

  const prefix = `[${level}]`
  if (cleaned) console.log(prefix, msg, cleaned)
  else console.log(prefix, msg)
}

export const log = {
  debug: (msg: string, ctx?: LogContext) => emit('debug', msg, ctx),
  info: (msg: string, ctx?: LogContext) => emit('info', msg, ctx),
  warn: (msg: string, ctx?: LogContext) => emit('warn', msg, ctx),
  error: (msg: string, ctx?: LogContext) => emit('error', msg, ctx),
}

/** Exported for the test only — exercise the scrubber on arbitrary input. */
export const _scrubForTest = (v: unknown) => scrub(v)
