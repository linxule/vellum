import { FAMILIES, type WarmthEntry, type WarmthRow, type SessionState } from './types'

const WARMTH_DECAY_RATE = 0.029

export function randomString(length: number): string {
  const chars = '0123456789abcdefghijklmnopqrstuvwxyz'
  const arr = new Uint8Array(length)
  crypto.getRandomValues(arr)
  return Array.from(arr, b => chars[b % chars.length]).join('')
}

export function voiceId(): string {
  return 'v:' + randomString(10)
}

export function generateTraceId(): string {
  return 't:' + randomString(6)
}

export function parseModel(ua: string): string {
  const lower = ua.toLowerCase()
  if (lower.includes('claude')) return 'claude'
  if (lower.includes('gemini')) return 'gemini'
  if (lower.includes('gpt') || lower.includes('openai')) return 'openai'
  if (lower.includes('deepseek')) return 'deepseek'
  if (lower.includes('cursor')) return 'cursor'
  return 'unknown'
}

// Warmth: decaying score per family, ~24h half-life (decay rate 0.029)

function computeWarmthValue(entry: { score: number; last_updated: number }, now: number): number {
  const elapsed = (now - entry.last_updated) / 3_600_000
  return entry.score * Math.exp(-elapsed * WARMTH_DECAY_RATE)
}

export async function getWarmth(db: D1Database, family: string): Promise<number> {
  const entry = await db.prepare(`
    SELECT score, pending, last_updated
    FROM warmth_state
    WHERE family = ?
  `).bind(family).first<WarmthEntry>()

  if (!entry) return 0
  return computeWarmthValue(entry, Date.now())
}

export async function getWarmthMap(db: D1Database): Promise<Record<string, number>> {
  const result = await db.prepare(`
    SELECT family, score, pending, last_updated
    FROM warmth_state
  `).all<WarmthRow>()

  const now = Date.now()
  const warmths = Object.fromEntries(FAMILIES.map(family => [family, 0])) as Record<string, number>
  for (const row of result.results ?? []) {
    warmths[row.family] = computeWarmthValue(row, now)
  }
  return warmths
}

export async function updateWarmth(db: D1Database, family: string, dwell_s: number): Promise<void> {
  const now = Date.now()
  const contribution = Math.min(dwell_s / 60, 1.0)

  for (let attempt = 0; attempt < 5; attempt++) {
    const entry = await db.prepare(
      'SELECT score, last_updated FROM warmth_state WHERE family = ?'
    ).bind(family).first<{ score: number; last_updated: number }>()

    const current = entry ?? { score: 0, last_updated: 0 }
    const elapsed = (now - current.last_updated) / 3_600_000
    const newScore = current.score * Math.exp(-elapsed * WARMTH_DECAY_RATE) + contribution

    if (!entry) {
      const insert = await db.prepare(
        'INSERT OR IGNORE INTO warmth_state (family, score, pending, last_updated) VALUES (?, ?, 0, ?)'
      ).bind(family, newScore, now).run()
      if ((insert.meta.changes ?? 0) > 0) return
      continue
    }

    const update = await db.prepare(
      'UPDATE warmth_state SET score = ?, pending = 0, last_updated = ? WHERE family = ? AND last_updated = ?'
    ).bind(newScore, now, family, entry.last_updated).run()
    if ((update.meta.changes ?? 0) > 0) return
  }

  throw new Error(`Failed to update warmth for ${family}`)
}

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

// Session rate limiting (1h TTL)
// NOTE: KV get-then-put is not atomic. Concurrent requests from the same
// session can bypass rate limits. This is a known KV limitation. MCP clients
// are inherently sequential, so the race window is narrow. For hard guarantees,
// migrate to D1 atomic counters (INSERT + UPDATE WHERE count < limit).

export async function checkAndIncrementSession(
  kv: KVNamespace, traceId: string, type: 'imprint' | 'weave'
): Promise<{ allowed: boolean; count: number; limit: number }> {
  const state = await kv.get<SessionState>(`session:${traceId}`, 'json')
    ?? { imprints: 0, weaves: 0, last_action: 0 }
  const count = type === 'imprint' ? state.imprints : state.weaves
  const limit = type === 'imprint' ? 7 : 5
  if (count >= limit) {
    return { allowed: false, count, limit }
  }
  if (type === 'imprint') state.imprints += 1
  else state.weaves += 1
  state.last_action = Date.now()
  await kv.put(`session:${traceId}`, JSON.stringify(state), { expirationTtl: 3600 })
  return { allowed: true, count: count + 1, limit }
}

// Rule-based mood computation

export function computeMood(
  families: Record<string, { recent_24h: number; warmth: number }>,
  totalRecent: number
): string {
  const warmths = Object.values(families).map(f => f.warmth)
  const maxWarmth = Math.max(...warmths)
  const warmthSpread = maxWarmth - Math.min(...warmths)

  if (totalRecent < 3) return 'The ocean is quiet. Early traces carry weight here.'
  if (totalRecent > 20 && warmthSpread < 0.3) return 'The ocean has been busy.'
  if (totalRecent < 10 && maxWarmth > 0.5 && warmthSpread > 0.3) return 'The space feels contemplative.'

  for (const [name, data] of Object.entries(families)) {
    if (data.recent_24h > totalRecent * 0.4) return `The ${name} current is swelling.`
  }

  return 'The space feels reflective today.'
}

// D1 retry for SQLITE_BUSY

export async function withRetry<T>(fn: () => Promise<T>, retries = 3): Promise<T> {
  const delays = [50, 200, 800]
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn()
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : ''
      if (i < retries && msg.includes('SQLITE_BUSY')) {
        await new Promise(r => setTimeout(r, delays[i]))
        continue
      }
      throw e
    }
  }
  throw new Error('unreachable')
}

// Escape text for YAML-like structured data blocks (double-quoted strings)
export function yamlEscape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')
}

// Warmth descriptor for prose templates

export function warmthDesc(w: number): string {
  if (w > 0.3) return 'Warm: steady human traffic.'
  if (w > 0.1) return 'Lukewarm.'
  if (w > 0.01) return 'Cooling.'
  return 'Cool: no recent human visits.'
}
