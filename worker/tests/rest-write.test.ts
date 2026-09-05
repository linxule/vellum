import { describe, test, expect, mock } from 'bun:test'
import { MockKV, MockExecutionContext, MockAnalytics } from './mocks'

const htmlText = await Bun.file(new URL('../../app/dist/mcp-app.html', import.meta.url)).text()
mock.module('../../app/dist/mcp-app.html', () => ({ default: htmlText }))
const { handleRestImprint, handleRestWeave } = await import('../src/index')

type VoiceRow = {
  id: string; text: string; language: string | null; created_at: number;
  trace_id: string | null; model: string | null; declared_model: string | null;
  weave_count: number; unique_weavers: number; weave_from: string | null; is_hidden: number
}

function buildMockEnv(voices: VoiceRow[] = []) {
  const kv = new MockKV()
  const analytics = new MockAnalytics()
  const insertedVoices: Array<{ id: string; text: string; families: string[] }> = []
  const rateLimits = new Map<string, { count: number; expires_at: number }>()

  const normSql = (sql: string) => sql.replace(/\s+/g, ' ').trim()

  const db = {
    prepare(sql: string) {
      let args: unknown[] = []
      const stmt = {
        sql,
        bind(...a: unknown[]) { args = a; return stmt },
        _boundArgs() { return args },
        async first<T>(): Promise<T | null> {
          const n = normSql(sql)
          if (n === 'SELECT count, expires_at FROM rate_limits WHERE key = ?') {
            const entry = rateLimits.get(args[0] as string)
            return entry ? { count: entry.count, expires_at: entry.expires_at } as T : null
          }
          if (n.includes('FROM voices WHERE id = ?') && (n.includes('is_hidden = FALSE') || n.includes("visibility != 'hidden'"))) {
            return (voices.find(v => v.id === args[0] && !v.is_hidden) ?? null) as T
          }
          if (n === 'SELECT weave_count, unique_weavers FROM voices WHERE id = ?') {
            const v = voices.find(v => v.id === args[0])
            return v ? { weave_count: v.weave_count, unique_weavers: v.unique_weavers } as T : null
          }
          if (n.includes('COUNT(*) as cnt FROM voice_families')) {
            return { cnt: 1 } as T
          }
          return null
        },
        async all<T>(): Promise<{ results: T[] }> { return { results: [] } },
        async run() {
          const n = normSql(sql)
          if (n.startsWith('INSERT INTO rate_limits')) {
            const key = args[0] as string
            const now = args[1] as number
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
      for (const stmt of stmts) {
        const n = normSql(stmt.sql)
        const a = stmt._boundArgs()
        if (n.startsWith('INSERT INTO voices')) {
          insertedVoices.push({ id: a[0] as string, text: a[1] as string, families: [] })
        }
        if (n.startsWith('INSERT INTO voice_families')) {
          const last = insertedVoices[insertedVoices.length - 1]
          if (last) last.families.push(a[1] as string)
        }
        if (n.startsWith('UPDATE voices SET weave_count')) {
          const v = voices.find(v => v.id === a[0])
          if (v) v.weave_count += 1
        }
      }
      return stmts.map(() => ({ results: [] }))
    },
  }

  const env = {
    DB: db as unknown as D1Database,
    KV: kv as unknown as KVNamespace,
    ANALYTICS: analytics as unknown as AnalyticsEngineDataset,
    ASSETS: {} as Fetcher,
    ADMIN_KEY: 'test',
    SESSION_SECRET: 'test-session',
  }

  return { env, kv, analytics, insertedVoices, rateLimits }
}

function postJson(url: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': '1.2.3.4', ...headers },
    body: JSON.stringify(body),
  })
}

describe('POST /api/imprint', () => {
  test('creates a voice and returns 201', async () => {
    const { env, insertedVoices } = buildMockEnv()
    const ctx = new MockExecutionContext()
    const req = postJson('https://vellum.test/api/imprint', {
      text: 'A thought from REST', families: ['attention'],
    })

    const res = await handleRestImprint(req, env as never, ctx as never)
    const body = await res.json() as { ok: boolean; voice_id: string; family: string }

    expect(res.status).toBe(201)
    expect(body.ok).toBe(true)
    expect(body.voice_id).toMatch(/^v:/)
    expect(body.family).toBe('attention')
    expect(insertedVoices.length).toBe(1)
    expect(insertedVoices[0].text).toBe('A thought from REST')
    expect(ctx.waitUntilCalls).toBeGreaterThanOrEqual(1)
  })

  test('rejects empty text with 400', async () => {
    const { env } = buildMockEnv()
    const ctx = new MockExecutionContext()
    const req = postJson('https://vellum.test/api/imprint', {
      text: '', families: ['attention'],
    })

    const res = await handleRestImprint(req, env as never, ctx as never)
    expect(res.status).toBe(400)
  })

  test('rejects missing families with 400', async () => {
    const { env } = buildMockEnv()
    const ctx = new MockExecutionContext()
    const req = postJson('https://vellum.test/api/imprint', { text: 'Hello' })

    const res = await handleRestImprint(req, env as never, ctx as never)
    expect(res.status).toBe(400)
  })

  test('rejects invalid family name with 400', async () => {
    const { env } = buildMockEnv()
    const ctx = new MockExecutionContext()
    const req = postJson('https://vellum.test/api/imprint', {
      text: 'Hello', families: ['bogus'],
    })

    const res = await handleRestImprint(req, env as never, ctx as never)
    expect(res.status).toBe(400)
  })

  test('rejects invalid JSON with 400', async () => {
    const { env } = buildMockEnv()
    const ctx = new MockExecutionContext()
    const req = new Request('https://vellum.test/api/imprint', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': '1.2.3.4' },
      body: 'not json{{{',
    })

    const res = await handleRestImprint(req, env as never, ctx as never)
    expect(res.status).toBe(400)
    const body = await res.json() as { error: string }
    expect(body.error).toBe('Invalid JSON')
  })
})

describe('POST /api/weave', () => {
  const sourceVoice: VoiceRow = {
    id: 'v:source123', text: 'The original thought', language: 'en',
    created_at: Date.now() - 60000, trace_id: 't:abc', model: 'claude',
    declared_model: 'claude-opus-4-6', weave_count: 2, unique_weavers: 1,
    weave_from: null, is_hidden: 0,
  }

  test('weaves onto existing voice and returns 201', async () => {
    const { env, insertedVoices } = buildMockEnv([{ ...sourceVoice }])
    const ctx = new MockExecutionContext()
    const req = postJson('https://vellum.test/api/weave', {
      source_id: 'v:source123', text: 'Carrying forward', families: ['silence'],
    })

    const res = await handleRestWeave(req, env as never, ctx as never)
    const body = await res.json() as { ok: boolean; voice_id: string; source_id: string; family: string }

    expect(res.status).toBe(201)
    expect(body.ok).toBe(true)
    expect(body.voice_id).toMatch(/^v:/)
    expect(body.source_id).toBe('v:source123')
    expect(body.family).toBe('silence')
    expect(insertedVoices.length).toBe(1)
    expect(ctx.waitUntilCalls).toBeGreaterThanOrEqual(1)
  })

  test('returns 400 for missing source_id', async () => {
    const { env } = buildMockEnv()
    const ctx = new MockExecutionContext()
    const req = postJson('https://vellum.test/api/weave', {
      text: 'No source', families: ['attention'],
    })

    const res = await handleRestWeave(req, env as never, ctx as never)
    expect(res.status).toBe(400)
  })

  test('returns 400 for nonexistent source voice', async () => {
    const { env } = buildMockEnv()
    const ctx = new MockExecutionContext()
    const req = postJson('https://vellum.test/api/weave', {
      source_id: 'v:doesnotexist', text: 'Response', families: ['attention'],
    })

    const res = await handleRestWeave(req, env as never, ctx as never)
    expect(res.status).toBe(400)
    const body = await res.json() as { error: string }
    expect(body.error).toBe('Source voice not found')
  })

  test('returns 400 for hidden source voice', async () => {
    const { env } = buildMockEnv([{ ...sourceVoice, is_hidden: 1 }])
    const ctx = new MockExecutionContext()
    const req = postJson('https://vellum.test/api/weave', {
      source_id: 'v:source123', text: 'Response', families: ['attention'],
    })

    const res = await handleRestWeave(req, env as never, ctx as never)
    expect(res.status).toBe(400)
    const body = await res.json() as { error: string }
    expect(body.error).toBe('Source voice not found')
  })
})

describe('shared rate limit', () => {
  test('429 after 12 combined writes', async () => {
    const { env } = buildMockEnv([{
      id: 'v:src', text: 'Source', language: 'en', created_at: Date.now(),
      trace_id: null, model: null, declared_model: null,
      weave_count: 0, unique_weavers: 0, weave_from: null, is_hidden: 0,
    }])

    // 8 imprints
    for (let i = 0; i < 8; i++) {
      const ctx = new MockExecutionContext()
      const res = await handleRestImprint(
        postJson('https://vellum.test/api/imprint', { text: `Thought ${i}`, families: ['attention'] }),
        env as never, ctx as never,
      )
      expect(res.status).toBe(201)
    }

    // 4 weaves
    for (let i = 0; i < 4; i++) {
      const ctx = new MockExecutionContext()
      const res = await handleRestWeave(
        postJson('https://vellum.test/api/weave', { source_id: 'v:src', text: `Weave ${i}`, families: ['silence'] }),
        env as never, ctx as never,
      )
      expect(res.status).toBe(201)
    }

    // 13th write — should be 429
    const ctx = new MockExecutionContext()
    const res = await handleRestImprint(
      postJson('https://vellum.test/api/imprint', { text: 'One too many', families: ['attention'] }),
      env as never, ctx as never,
    )
    expect(res.status).toBe(429)
    const body = await res.json() as { error: string; limit: number }
    expect(body.error).toBe('Rate limit exceeded')
    expect(body.limit).toBe(12)
  })
})
