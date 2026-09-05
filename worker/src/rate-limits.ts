import { withRetry } from './helpers'

export const SESSION_WINDOW_S = 3600

// Single source of truth for all rate limits (D1-backed per-IP + KV per-session)
export const RATE_LIMITS = {
  init:       { limit: 20,  window: 3600 },   // /mcp initialize — per IP
  witness:    { limit: 5,   window: 60 },     // /api/witness (REST) — per IP
  state:      { limit: 60,  window: 60 },     // /api/state — per IP
  lineage:    { limit: 20,  window: 60 },     // /api/lineage/:id — per IP
  voices:     { limit: 30,  window: 60 },     // /api/voices — per IP
  lineages:   { limit: 20,  window: 60 },     // /api/lineages — per IP
  rest_write: { limit: 12,  window: 3600 },   // /api/imprint + /api/weave combined — per IP
  session: { imprint: 7, weave: 5, witness: 15, lineage: 30 },
  // Phase 17 "The Echo" Part A5: flat, generous, per-id (not per-IP). Replaces the anonymous
  // rest_write bucket / MCP session bucket for named writes — never stacks with either.
  agent: { imprint: 12, weave: 20, window: 3600 },
  // Phase 17 Part D1: GET/HEAD /echo/{id} — per-IP (matches /api/voices) + per-id.
  echo: { limit: 30, window: 60 },
  echo_id: { limit: 60, window: 3600 },
} as const

type RateLimitRow = {
  count: number
  expires_at: number
}

export async function checkAndIncrementRateLimit(
  db: D1Database,
  key: string,
  limit: number,
  windowSeconds: number,
  now = Date.now(),
): Promise<{ allowed: boolean; count: number; limit: number; retryAfter: number }> {
  const expiresAt = now + windowSeconds * 1000

  await withRetry(() => db.prepare(`
    INSERT INTO rate_limits (key, count, window_start, expires_at)
    VALUES (?, 1, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      count = CASE
        WHEN rate_limits.expires_at <= ? THEN 1
        ELSE rate_limits.count + 1
      END,
      window_start = CASE
        WHEN rate_limits.expires_at <= ? THEN excluded.window_start
        ELSE rate_limits.window_start
      END,
      expires_at = CASE
        WHEN rate_limits.expires_at <= ? THEN excluded.expires_at
        ELSE rate_limits.expires_at
      END
  `).bind(key, now, expiresAt, now, now, now).run())

  const row = await db.prepare(
    'SELECT count, expires_at FROM rate_limits WHERE key = ?'
  ).bind(key).first<RateLimitRow>()

  const count = row?.count ?? 0
  const retryAfter = Math.max(1, Math.ceil(((row?.expires_at ?? expiresAt) - now) / 1000))
  return {
    allowed: count <= limit,
    count,
    limit,
    retryAfter,
  }
}

export async function checkRateLimitDO(
  rateLimiterNs: DurableObjectNamespace,
  ip: string,
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<{ allowed: boolean; count: number; limit: number; retryAfter: number }> {
  const id = rateLimiterNs.idFromName(ip)
  const stub = rateLimiterNs.get(id)
  const response = await stub.fetch(new Request('http://do/check', {
    method: 'POST',
    body: JSON.stringify({ key, limit, windowSeconds }),
  }))

  if (!response.ok) {
    throw new Error(`RateLimiterDO returned ${response.status}`)
  }

  return response.json()
}

// Session rate limiting — Phase 16 "The Levee" Part A2: migrated off KV onto the same D1 atomic
// UPSERT used everywhere else (`checkAndIncrementRateLimit`), keyed `sess:<traceId>:<type>`.
// The old KV read-modify-write admitted the race its own comment described (concurrent requests
// from one session could bypass the limit); D1's UPSERT is atomic. `count` is reported as `limit`
// on rejection (never the true post-reject count) to preserve the pre-migration external contract:
// a session can be probed repeatedly after hitting its quota without the reported count climbing.
export async function checkAndIncrementSession(
  db: D1Database, traceId: string, type: 'imprint' | 'weave' | 'witness' | 'lineage'
): Promise<{ allowed: boolean; count: number; limit: number; retryAfter: number }> {
  const limit = RATE_LIMITS.session[type]
  const result = await checkAndIncrementRateLimit(db, `sess:${traceId}:${type}`, limit, SESSION_WINDOW_S)
  return result.allowed ? result : { ...result, count: limit }
}
