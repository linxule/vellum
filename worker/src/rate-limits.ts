import type { SessionState } from './types'
import { withRetry } from './helpers'

// Single source of truth for all rate limits (D1-backed per-IP + KV per-session)
export const RATE_LIMITS = {
  init:       { limit: 20,  window: 3600 },   // /mcp initialize — per IP
  witness:    { limit: 5,   window: 60 },     // /api/witness (REST) — per IP
  state:      { limit: 60,  window: 60 },     // /api/state — per IP
  lineage:    { limit: 20,  window: 60 },     // /api/lineage/:id — per IP
  voices:     { limit: 30,  window: 60 },     // /api/voices — per IP
  lineages:   { limit: 20,  window: 60 },     // /api/lineages — per IP
  rest_write: { limit: 12,  window: 3600 },   // /api/imprint + /api/weave combined — per IP
  session: { imprint: 7, weave: 5, witness: 15 },
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

// Session rate limiting (1h TTL)
// NOTE: KV get-then-put is not atomic. Concurrent requests from the same
// session can bypass rate limits. This is a known KV limitation. MCP clients
// are inherently sequential, so the race window is narrow. For hard guarantees,
// migrate to D1 atomic counters (INSERT + UPDATE WHERE count < limit).
export async function checkAndIncrementSession(
  kv: KVNamespace, traceId: string, type: 'imprint' | 'weave' | 'witness'
): Promise<{ allowed: boolean; count: number; limit: number }> {
  const state: SessionState = {
    imprints: 0, weaves: 0, witnesses: 0, last_action: 0,
    ...(await kv.get<SessionState>(`session:${traceId}`, 'json')),
  }
  const count = type === 'imprint' ? state.imprints
    : type === 'weave' ? state.weaves
    : (state.witnesses ?? 0)
  const limit = RATE_LIMITS.session[type]
  if (count >= limit) {
    return { allowed: false, count, limit }
  }
  if (type === 'imprint') state.imprints += 1
  else if (type === 'weave') state.weaves += 1
  else state.witnesses = (state.witnesses ?? 0) + 1
  state.last_action = Date.now()
  await kv.put(`session:${traceId}`, JSON.stringify(state), { expirationTtl: 3600 })
  return { allowed: true, count: count + 1, limit }
}
