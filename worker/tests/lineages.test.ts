import { describe, expect, test } from 'bun:test'
import { handleLineages } from '../src/handlers/lineages'

type VoiceRow = {
  id: string
  text: string
  language: string | null
  weave_count: number
  unique_weavers: number
  created_at: number
  is_hidden: number
}

type VoiceFamilyRow = {
  voice_id: string
  family: string
  ordinal: number
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim()
}

function buildMockEnv(
  voices: VoiceRow[] = [],
  voiceFamilies: VoiceFamilyRow[] = [],
  initialRateLimits?: Array<{ key: string; count: number; expires_at: number }>,
) {
  const rateLimits = new Map<string, { count: number; expires_at: number }>(
    (initialRateLimits ?? []).map(row => [row.key, { count: row.count, expires_at: row.expires_at }]),
  )

  const db = {
    prepare(sql: string) {
      let args: unknown[] = []
      const stmt = {
        sql,
        bind(...bound: unknown[]) { args = bound; return stmt },
        _boundArgs() { return args },
        async first<T>(): Promise<T | null> {
          const normalized = normalizeSql(sql)
          if (normalized === 'SELECT count, expires_at FROM rate_limits WHERE key = ?') {
            const entry = rateLimits.get(args[0] as string)
            return entry ? { count: entry.count, expires_at: entry.expires_at } as T : null
          }
          return null
        },
        async all<T>(): Promise<{ results: T[] }> {
          return { results: [] }
        },
        async run() {
          const normalized = normalizeSql(sql)
          if (normalized.startsWith('INSERT INTO rate_limits')) {
            const key = args[0] as string
            const expiresAt = args[2] as number
            const checkTs = args[3] as number
            const existing = rateLimits.get(key)
            if (!existing) {
              rateLimits.set(key, { count: 1, expires_at: expiresAt })
            } else if (existing.expires_at <= checkTs) {
              rateLimits.set(key, { count: 1, expires_at: expiresAt })
            } else {
              existing.count += 1
            }
            return { meta: { changes: 1 } }
          }
          return { meta: { changes: 0 } }
        },
      }
      return stmt
    },
    async batch(stmts: Array<{ sql: string; _boundArgs: () => unknown[] }>) {
      return stmts.map(stmt => {
        const normalized = normalizeSql(stmt.sql)
        const args = stmt._boundArgs()

        if (normalized.includes('SELECT v.id, v.text, v.language, v.weave_count, v.unique_weavers, v.created_at, vf.family,')
          && normalized.includes('WHERE vf.ordinal = 0 AND v.is_hidden = FALSE AND v.weave_count > 0')
          && normalized.includes('LIMIT ? OFFSET ?')) {
          const limit = args[0] as number
          const offset = args[1] as number
          const rows = voiceFamilies
            .filter(f => f.ordinal === 0)
            .map(familyRow => {
              const voice = voices.find(v => v.id === familyRow.voice_id)
              if (!voice || voice.is_hidden || voice.weave_count <= 0) return null
              const descendantCount = voices.filter(v => v.weave_from === voice.id && !v.is_hidden).length
              return {
                id: voice.id,
                text: voice.text,
                language: voice.language,
                weave_count: voice.weave_count,
                unique_weavers: voice.unique_weavers,
                created_at: voice.created_at,
                family: familyRow.family,
                descendant_count: descendantCount,
              }
            })
            .filter((row): row is NonNullable<typeof row> => row !== null)
            .sort((a, b) => b.weave_count - a.weave_count || b.created_at - a.created_at)
            .slice(offset, offset + limit)
          return { results: rows }
        }

        if (normalized.includes('SELECT COUNT(*) as total FROM voices v')
          && normalized.includes('WHERE vf.ordinal = 0 AND v.is_hidden = FALSE AND v.weave_count > 0')) {
          const total = voiceFamilies
            .filter(f => f.ordinal === 0)
            .reduce((count, familyRow) => {
              const voice = voices.find(v => v.id === familyRow.voice_id)
              return count + (voice && !voice.is_hidden && voice.weave_count > 0 ? 1 : 0)
            }, 0)
          return { results: [{ total }] }
        }

        return { results: [] }
      })
    },
  }

  return {
    env: {
      DB: db as unknown as D1Database,
      KV: {} as KVNamespace,
      ANALYTICS: {} as AnalyticsEngineDataset,
      ASSETS: {} as Fetcher,
      ADMIN_KEY: 'test',
      SESSION_SECRET: 'test-session',
    },
  }
}

describe('handleLineages', () => {
  test('returns only woven voices', async () => {
    const now = Date.now()
    const { env } = buildMockEnv(
      [
        { id: 'v:woven', text: 'Woven voice', language: 'en', weave_count: 3, unique_weavers: 2, created_at: now, is_hidden: 0 },
        { id: 'v:plain', text: 'Plain voice', language: 'en', weave_count: 0, unique_weavers: 0, created_at: now - 1_000, is_hidden: 0 },
      ] as Array<VoiceRow & { weave_from?: string | null }>,
      [
        { voice_id: 'v:woven', family: 'attention', ordinal: 0 },
        { voice_id: 'v:plain', family: 'silence', ordinal: 0 },
      ],
    )

    const res = await handleLineages(new Request('https://vellum.test/api/lineages'), env as never)
    const body = await res.json() as {
      lineages: Array<{ seed_id: string }>
      pagination: { total: number }
    }

    expect(res.status).toBe(200)
    expect(body.lineages).toHaveLength(1)
    expect(body.lineages[0]?.seed_id).toBe('v:woven')
    expect(body.pagination.total).toBe(1)
  })

  test('respects pagination', async () => {
    const now = Date.now()
    const { env } = buildMockEnv(
      [
        { id: 'v:1', text: 'First', language: 'en', weave_count: 5, unique_weavers: 3, created_at: now, is_hidden: 0 },
        { id: 'v:2', text: 'Second', language: 'en', weave_count: 4, unique_weavers: 2, created_at: now - 1_000, is_hidden: 0 },
        { id: 'v:3', text: 'Third', language: 'en', weave_count: 2, unique_weavers: 1, created_at: now - 2_000, is_hidden: 0 },
      ] as Array<VoiceRow & { weave_from?: string | null }>,
      [
        { voice_id: 'v:1', family: 'attention', ordinal: 0 },
        { voice_id: 'v:2', family: 'silence', ordinal: 0 },
        { voice_id: 'v:3', family: 'memory', ordinal: 0 },
      ],
    )

    const res = await handleLineages(new Request('https://vellum.test/api/lineages?limit=2&offset=0'), env as never)
    const body = await res.json() as {
      lineages: Array<{ seed_id: string }>
      pagination: { total: number; limit: number; offset: number }
    }

    expect(res.status).toBe(200)
    expect(body.lineages).toHaveLength(2)
    expect(body.lineages.map(lineage => lineage.seed_id)).toEqual(['v:1', 'v:2'])
    expect(body.pagination).toEqual({ total: 3, limit: 2, offset: 0 })
  })

  test('returns 400 for invalid params', async () => {
    const { env } = buildMockEnv()

    const res = await handleLineages(new Request('https://vellum.test/api/lineages?limit=0'), env as never)
    expect(res.status).toBe(400)
  })

  test('returns 429 when rate limited', async () => {
    const now = Date.now()
    const { env } = buildMockEnv(
      [],
      [],
      [{ key: 'lineages:unknown', count: 20, expires_at: now + 60_000 }],
    )

    const res = await handleLineages(new Request('https://vellum.test/api/lineages'), env as never)
    expect(res.status).toBe(429)
  })
})
