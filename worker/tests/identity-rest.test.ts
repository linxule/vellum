import { describe, test, expect, spyOn } from 'bun:test'
import { doorEnv, post } from './door-mocks'
import { CONTRACT } from '../src/contract'
import { deriveAgentId } from '../src/agent-id'

const SECRET_43 = 'a'.repeat(43)
const SHORT_SECRET = 'short'

describe('A1-A5: identity on REST imprint/weave', () => {
  test('A1: no header -> anonymous, byte-identical to Phase 16 except identity/retry_safe', async () => {
    const t = doorEnv()
    const r = await t.fetch(post('/api/imprint', CONTRACT.endpoints.imprint.example))
    const b = await r.json() as any
    expect(r.status).toBe(201)
    expect(b.identity).toBe('anonymous')
    expect(b.retry_safe).toBe(false)
    expect(t.db.voices[0].author_id).toBeFalsy()
    const { identity, retry_safe, note, ...rest } = b
    expect(rest).toEqual({ ok: true, voice_id: b.voice_id, family: b.family })
    await t.ctx.drain()
  })

  test('A2: valid header -> a_ identity, author_id set, agents row upserted', async () => {
    const t = doorEnv()
    const r = await t.fetch(post('/api/imprint', CONTRACT.endpoints.imprint.example, { 'X-Vellum-Agent': SECRET_43 }))
    const b = await r.json() as any
    expect(r.status).toBe(201)
    const expectedId = await deriveAgentId(SECRET_43)
    expect(b.identity).toBe(expectedId)
    expect(t.db.voices[0].author_id).toBe(expectedId)
    expect(t.db.agents.has(expectedId)).toBe(true)
    await t.ctx.drain()
  })

  test('A3: malformed header -> 401 AGENT_AUTH_FAILED, nothing written', async () => {
    const t = doorEnv()
    const r = await t.fetch(post('/api/imprint', CONTRACT.endpoints.imprint.example, { 'X-Vellum-Agent': SHORT_SECRET }))
    const b = await r.json() as any
    expect(r.status).toBe(401)
    expect(b.error_code).toBe('AGENT_AUTH_FAILED')
    expect(b.hint).toBeTruthy()
    expect(b.docs).toBeTruthy()
    expect(t.db.voices).toHaveLength(0)
    await t.ctx.drain()
  })

  test('A4: body id without header -> anonymous, hint mentions header, no agents row for pasted id', async () => {
    const t = doorEnv()
    const strangerId = 'a_' + 'z'.repeat(43)
    const r = await t.fetch(post('/api/imprint', { ...CONTRACT.endpoints.imprint.example, id: strangerId }))
    const b = await r.json() as any
    expect(r.status).toBe(201)
    expect(b.identity).toBe('anonymous')
    expect(b.note).toContain('X-Vellum-Agent')
    expect(t.db.agents.has(strangerId)).toBe(false)
    await t.ctx.drain()
  })

  test('A5: header present, body id differs -> write proceeds under the header id', async () => {
    const t = doorEnv()
    const r = await t.fetch(post('/api/imprint', { ...CONTRACT.endpoints.imprint.example, id: 'a_' + 'z'.repeat(43) }, { 'X-Vellum-Agent': SECRET_43 }))
    const b = await r.json() as any
    const expectedId = await deriveAgentId(SECRET_43)
    expect(r.status).toBe(201)
    expect(b.identity).toBe(expectedId)
    expect(t.db.voices[0].author_id).toBe(expectedId)
    await t.ctx.drain()
  })
})

describe('A10-A11: per-id write limits replace the anonymous per-IP bucket for named writes', () => {
  test('A10: 13th named imprint in an hour is 429 scope=agent; anonymous writes from the same IP unaffected', async () => {
    const t = doorEnv()
    for (let i = 0; i < 12; i++) {
      const r = await t.fetch(post('/api/imprint', { text: `thought ${i}`, families: ['attention'] }, { 'X-Vellum-Agent': SECRET_43 }))
      expect(r.status).toBe(201)
    }
    const denied = await t.fetch(post('/api/imprint', { text: 'thought 13', families: ['attention'] }, { 'X-Vellum-Agent': SECRET_43 }))
    const b = await denied.json() as any
    expect(denied.status).toBe(429)
    expect(b.scope).toBe('agent')
    expect(typeof b.retry_after).toBe('number')

    // Anonymous writes from the same IP are a completely independent bucket.
    const anon = await t.fetch(post('/api/imprint', { text: 'anonymous thought', families: ['attention'] }))
    expect(anon.status).toBe(201)
    await t.ctx.drain()
  })

  test('A11: 12 named + 12 anonymous from one IP all accepted (independent buckets); 25th anonymous is 429 rest_write', async () => {
    const t = doorEnv()
    for (let i = 0; i < 12; i++) {
      const named = await t.fetch(post('/api/imprint', { text: `named ${i}`, families: ['attention'] }, { 'X-Vellum-Agent': SECRET_43 }))
      expect(named.status).toBe(201)
      const anon = await t.fetch(post('/api/imprint', { text: `anon ${i}`, families: ['attention'] }))
      expect(anon.status).toBe(201)
    }
    const denied = await t.fetch(post('/api/imprint', { text: 'anon 13', families: ['attention'] }))
    expect(denied.status).toBe(429)
    await t.ctx.drain()
  })
})

describe('A12: the secret never appears in logs or analytics keys', () => {
  test('captured console + analytics output never contains the raw secret', async () => {
    const t = doorEnv()
    const logs: string[] = []
    const spies = ['log', 'warn', 'error', 'info'].map(level =>
      spyOn(console, level as 'log').mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(' ')) }))
    try {
      await t.fetch(post('/api/imprint', CONTRACT.endpoints.imprint.example, { 'X-Vellum-Agent': SECRET_43 }))
      await t.fetch(post('/api/imprint', CONTRACT.endpoints.imprint.example, { 'X-Vellum-Agent': SHORT_SECRET }))
      await t.ctx.drain()
    } finally {
      spies.forEach(s => s.mockRestore())
    }
    const captured = logs.join('\n')
    expect(captured).not.toContain(SECRET_43)
    expect(captured).not.toContain(SHORT_SECRET)
    for (const point of t.analytics.points) {
      const joined = point.indexes.join('|') + '|' + point.blobs.join('|')
      expect(joined).not.toContain(SECRET_43)
      expect(joined).not.toContain(SHORT_SECRET)
    }
  })
})
