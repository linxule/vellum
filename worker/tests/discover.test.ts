import { describe, test, expect } from 'bun:test'
import { handleDiscover } from '../src/tools/discover'
import { MockKV, MockExecutionContext, MockAnalytics } from './mocks'

type VoiceRow = { id: string; text: string; language: string | null; created_at: number; weave_count: number; unique_weavers: number; family: string }

function buildMockEnv(voices: VoiceRow[] = []) {
  const normSql = (sql: string) => sql.replace(/\s+/g, ' ').trim()

  const db = {
    prepare(sql: string) {
      let args: unknown[] = []
      return {
        bind(...a: unknown[]) { args = a; return this },
        async first<T>(): Promise<T | null> {
          const n = normSql(sql)
          if (n.includes('FROM warmth_state WHERE family = ?')) {
            return { score: 0.5, last_updated: Date.now() } as T
          }
          return null
        },
        async all<T>(): Promise<{ results: T[] }> {
          const n = normSql(sql)
          if (n.includes('FROM voices v JOIN voice_families vf')) {
            let filtered = [...voices]

            // Apply family filter
            const familyArgIdx = n.indexOf('vf.family = ?')
            if (familyArgIdx >= 0) {
              const familyArg = args[0] as string
              filtered = filtered.filter(v => v.family === familyArg)
            }

            // Apply language filter
            if (n.includes('v.language = ?')) {
              const langIdx = n.includes('vf.family = ?') ? 1 : 0
              filtered = filtered.filter(v => v.language === args[langIdx])
            }

            // Apply sort
            if (n.includes('ORDER BY v.weave_count DESC')) {
              filtered.sort((a, b) => b.weave_count - a.weave_count)
            } else {
              filtered.sort((a, b) => b.created_at - a.created_at)
            }

            // Apply limit (last numeric arg)
            const limitArg = args[args.length - 1] as number
            filtered = filtered.slice(0, limitArg)

            return { results: filtered as T[] }
          }
          return { results: [] }
        },
        async run() { return { meta: { changes: 0 } } },
      }
    },
    batch: async () => [],
  }

  return {
    env: { DB: db as unknown as D1Database, KV: new MockKV() as unknown as KVNamespace, ANALYTICS: new MockAnalytics() as unknown as AnalyticsEngineDataset, ASSETS: {} as Fetcher, ADMIN_KEY: 'test', SESSION_SECRET: 'test-session' },
  }
}

const now = Date.now()
const sampleVoices: VoiceRow[] = [
  { id: 'v:1', text: 'First voice', language: 'en', created_at: now - 1000, weave_count: 5, unique_weavers: 3, family: 'attention' },
  { id: 'v:2', text: 'Second voice', language: 'ja', created_at: now - 2000, weave_count: 2, unique_weavers: 1, family: 'silence' },
  { id: 'v:3', text: 'Third voice', language: 'en', created_at: now - 3000, weave_count: 8, unique_weavers: 5, family: 'attention' },
  { id: 'v:4', text: 'Fourth voice', language: 'en', created_at: now - 500, weave_count: 0, unique_weavers: 0, family: 'memory' },
]

describe('discover tool', () => {
  test('returns voices sorted by age by default', async () => {
    const { env } = buildMockEnv(sampleVoices)
    const ctx = new MockExecutionContext()
    const result = await handleDiscover(env, ctx as unknown as ExecutionContext, 'trace1', {})
    expect(result.content[0].text).toContain('Fourth voice') // most recent
    expect(result.content[0].text).toContain('sort: age')
  })

  test('filters by family', async () => {
    const { env } = buildMockEnv(sampleVoices)
    const ctx = new MockExecutionContext()
    const result = await handleDiscover(env, ctx as unknown as ExecutionContext, 'trace1', { family: 'attention' })
    expect(result.content[0].text).toContain('attention')
    expect(result.content[0].text).not.toContain('silence')
    expect(result.content[0].text).not.toContain('memory')
  })

  test('sorts by weaves', async () => {
    const { env } = buildMockEnv(sampleVoices)
    const ctx = new MockExecutionContext()
    const result = await handleDiscover(env, ctx as unknown as ExecutionContext, 'trace1', { sort: 'weaves' })
    expect(result.content[0].text).toContain('sort: weaves')
    // Third voice has highest weave count
    const lines = result.content[0].text.split('\n')
    const voiceLines = lines.filter(l => l.startsWith('"'))
    expect(voiceLines[0]).toContain('Third voice')
  })

  test('respects limit', async () => {
    const { env } = buildMockEnv(sampleVoices)
    const ctx = new MockExecutionContext()
    const result = await handleDiscover(env, ctx as unknown as ExecutionContext, 'trace1', { limit: 2 })
    expect(result.content[0].text).toContain('total: 2')
  })

  test('returns empty state gracefully', async () => {
    const { env } = buildMockEnv([])
    const ctx = new MockExecutionContext()
    const result = await handleDiscover(env, ctx as unknown as ExecutionContext, 'trace1', { family: 'attention' })
    expect(result.content[0].text).toContain('No voices found')
    expect(result.content[0].text).toContain('total: 0')
  })
})
