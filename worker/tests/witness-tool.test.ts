import { describe, test, expect } from 'bun:test'
import { handleWitnessTool } from '../src/tools/witness'
import { MockKV, MockExecutionContext, MockAnalytics } from './mocks'

type VoiceRow = { id: string; text: string; language: string | null; created_at: number; family: string }
type WarmthRow = { family: string; score: number; last_updated: number }

function buildMockEnv(voices: VoiceRow[] = [], warmth: WarmthRow[] = []) {
  const kv = new MockKV()
  const allWarmth: WarmthRow[] = warmth.length > 0 ? warmth : [
    { family: 'attention', score: 0, last_updated: 0 },
    { family: 'silence', score: 0, last_updated: 0 },
    { family: 'space', score: 0, last_updated: 0 },
    { family: 'ephemeral', score: 0, last_updated: 0 },
    { family: 'memory', score: 0, last_updated: 0 },
    { family: 'light', score: 0, last_updated: 0 },
  ]

  const normSql = (sql: string) => sql.replace(/\s+/g, ' ').trim()
  // Phase 16: session credits moved off KV onto this same D1 atomic-UPSERT pattern
  // (checkAndIncrementRateLimit, keyed sess:<traceId>:witness) — needed for the
  // "rate limits after 15 calls" test below.
  const rateLimits = new Map<string, { count: number; window_start: number; expires_at: number }>()

  const db = {
    prepare(sql: string) {
      let args: unknown[] = []
      return {
        bind(...a: unknown[]) { args = a; return this },
        async first<T>(): Promise<T | null> {
          const n = normSql(sql)
          if (n.includes('FROM voices v') && n.includes('JOIN voice_families vf') && n.includes('v.id = ?')) {
            const v = voices.find(v => v.id === args[0])
            if (!v) return null
            return { text: v.text, family: v.family } as T
          }
          if (n.includes('FROM warmth_state WHERE family = ?')) {
            const row = allWarmth.find(w => w.family === args[0])
            return (row ? { score: row.score, last_updated: row.last_updated } : null) as T
          }
          if (n === 'SELECT count, expires_at FROM rate_limits WHERE key = ?') {
            const row = rateLimits.get(args[0] as string)
            return (row ? { count: row.count, expires_at: row.expires_at } : null) as T | null
          }
          return null
        },
        async all<T>(): Promise<{ results: T[] }> { return { results: [] } },
        async run() {
          const n = normSql(sql)
          if (n.startsWith('INSERT INTO warmth_state')) {
            // Phase 18 Part B3: warmth UPSERT args = [surface, family, contribution, now].
            const [, family, contribution, now] = args as [string, string, number, number]
            const existing = allWarmth.find(w => w.family === family)
            if (!existing) {
              allWarmth.push({ family, score: contribution, last_updated: now })
            } else {
              const elapsed = (now - existing.last_updated) / 3_600_000
              existing.score = existing.score * Math.exp(-0.029 * elapsed) + contribution
              existing.last_updated = now
            }
            return { meta: { changes: 1 } }
          }
          if (n.startsWith('INSERT INTO rate_limits')) {
            const [key, now, expiresAt, check1] = args as [string, number, number, number]
            const existing = rateLimits.get(key)
            if (!existing) rateLimits.set(key, { count: 1, window_start: now, expires_at: expiresAt })
            else if (existing.expires_at <= check1) rateLimits.set(key, { count: 1, window_start: now, expires_at: expiresAt })
            else existing.count += 1
            return { meta: { changes: 1 } }
          }
          return { meta: { changes: 0 } }
        },
      }
    },
    batch: async (stmts: unknown[]) => stmts.map(() => ({ results: [] })),
  }

  return {
    env: { DB: db as unknown as D1Database, KV: kv as unknown as KVNamespace, ANALYTICS: new MockAnalytics() as unknown as AnalyticsEngineDataset, ASSETS: {} as Fetcher, ADMIN_KEY: 'test', SESSION_SECRET: 'test-session' },
    kv,
    warmth: allWarmth,
  }
}

describe('witness tool', () => {
  test('witnesses a voice by id and warms its family', async () => {
    const { env, warmth } = buildMockEnv([
      { id: 'v:abc', text: 'Hello world', language: 'en', created_at: Date.now(), family: 'attention' },
    ])
    const ctx = new MockExecutionContext()
    const result = await handleWitnessTool(env, ctx as unknown as ExecutionContext, 'trace1', {
      voice_id: 'v:abc', dwell_s: 30,
    })
    expect(result.isError).toBeUndefined()
    expect(result.content[0].text).toContain('Hello world')
    expect(result.content[0].text).toContain('attention')
    expect(warmth.find(w => w.family === 'attention')!.score).toBeGreaterThan(0)
  })

  test('witnesses a family directly', async () => {
    const { env, warmth } = buildMockEnv()
    const ctx = new MockExecutionContext()
    const result = await handleWitnessTool(env, ctx as unknown as ExecutionContext, 'trace1', {
      family: 'silence', dwell_s: 60,
    })
    expect(result.isError).toBeUndefined()
    expect(result.content[0].text).toContain('silence')
    expect(warmth.find(w => w.family === 'silence')!.score).toBeGreaterThan(0)
  })

  test('schedules a background projection rebuild', async () => {
    const { env } = buildMockEnv()
    const ctx = new MockExecutionContext()

    const result = await handleWitnessTool(env, ctx as unknown as ExecutionContext, 'trace1', {
      family: 'attention', dwell_s: 30,
    })

    expect(result.isError).toBeUndefined()
    expect(ctx.waitUntilCalls).toBeGreaterThanOrEqual(1)
    await expect(ctx.drain()).resolves.toBeUndefined()
  })

  test('returns error for missing voice', async () => {
    const { env } = buildMockEnv()
    const ctx = new MockExecutionContext()
    const result = await handleWitnessTool(env, ctx as unknown as ExecutionContext, 'trace1', {
      voice_id: 'v:nonexistent', dwell_s: 10,
    })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('not found')
  })

  test('returns error when no target specified', async () => {
    const { env } = buildMockEnv()
    const ctx = new MockExecutionContext()
    const result = await handleWitnessTool(env, ctx as unknown as ExecutionContext, 'trace1', {
      dwell_s: 10,
    })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('No valid families')
  })

  test('rate limits after 15 calls', async () => {
    const { env } = buildMockEnv()
    const ctx = new MockExecutionContext()

    // Burn 15 calls
    for (let i = 0; i < 15; i++) {
      const r = await handleWitnessTool(env, ctx as unknown as ExecutionContext, 'trace-rl', {
        family: 'attention', dwell_s: 5,
      })
      expect(r.isError).toBeUndefined()
    }

    // 16th should fail
    const r = await handleWitnessTool(env, ctx as unknown as ExecutionContext, 'trace-rl', {
      family: 'attention', dwell_s: 5,
    })
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toContain('15')
  })

  test('clamps dwell to 300s', async () => {
    const { env } = buildMockEnv()
    const ctx = new MockExecutionContext()
    const result = await handleWitnessTool(env, ctx as unknown as ExecutionContext, 'trace1', {
      family: 'memory', dwell_s: 9999,
    })
    expect(result.isError).toBeUndefined()
    // Dwell shown in output should be 300 (clamped)
    expect(result.content[0].text).toContain('300 seconds')
  })
})
