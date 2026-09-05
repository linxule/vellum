import { describe, test, expect, spyOn } from 'bun:test'
import { doorEnv, post, voice } from './door-mocks'
import { nextCheckAfterFor } from '../src/handlers/echo'

/** Counts calls to first()/all() whose SQL touches the echo_events or voices tables — the "zero
 * D1 reads" the spec means is specifically zero reads of the mailbox's own content, not the
 * universal per-IP/per-id rate-limit bookkeeping every read endpoint already charges. */
function spyOnContentReads(db: { first: (...a: unknown[]) => unknown; all: (...a: unknown[]) => unknown }) {
  const calls: string[] = []
  const record = (sql: string) => { if (/echo_events|FROM voices/.test(sql)) calls.push(sql) }
  const originalFirst = db.first.bind(db)
  const originalAll = db.all.bind(db)
  const firstSpy = spyOn(db, 'first').mockImplementation((sql: string, ...rest: unknown[]) => { record(sql); return originalFirst(sql, ...rest) })
  const allSpy = spyOn(db, 'all').mockImplementation((sql: string, ...rest: unknown[]) => { record(sql); return originalAll(sql, ...rest) })
  return { calls, restore: () => { firstSpy.mockRestore(); allSpy.mockRestore() } }
}

function get(path: string, headers: Record<string, string> = {}, method = 'GET') {
  return new Request(`https://vellum.test${path}`, { method, headers: { 'cf-connecting-ip': '1.2.3.4', ...headers } })
}

const UNKNOWN_ID = 'a_' + 'q'.repeat(43)

describe('D1-D2: GET /echo/{id}', () => {
  test('D1: unknown-but-well-formed id -> 200, empty mailbox, cursor 0, next_check_after >= 3600', async () => {
    const t = doorEnv()
    const r = await t.fetch(get(`/echo/${UNKNOWN_ID}`))
    const b = await r.json() as any
    expect(r.status).toBe(200)
    expect(b.events).toEqual([])
    expect(b.cursor).toBe(0)
    expect(b.next_check_after).toBeGreaterThanOrEqual(3600 * 0.8)
  })

  test('D2: malformed id -> 404 NOT_FOUND with a hint', async () => {
    const t = doorEnv()
    const r = await t.fetch(get('/echo/nope'))
    const b = await r.json() as any
    expect(r.status).toBe(404)
    expect(b.error_code).toBe('NOT_FOUND')
    expect(b.hint).toBeTruthy()
  })
})

describe('D3: cursor pagination', () => {
  test('after=N returns events with n > N ascending; cursor is max n', async () => {
    const t = doorEnv()
    const id = 'a_' + 'r'.repeat(43)
    ;(t.db as any).echoEvents = [
      { n: 1, agent_id: id, kind: 'woven', voice_id: 'v:a', by_voice: 'v:b', by_id: null, at: Date.now(), payload: '{"weavers":1}' },
      { n: 2, agent_id: id, kind: 'woven', voice_id: 'v:a', by_voice: 'v:c', by_id: null, at: Date.now(), payload: '{"weavers":2}' },
      { n: 3, agent_id: id, kind: 'sinking', voice_id: 'v:a', by_voice: null, by_id: null, at: Date.now(), payload: '{"depth":0.6}' },
    ]
    const r = await t.fetch(get(`/echo/${id}?after=1`))
    const b = await r.json() as any
    expect(r.status).toBe(200)
    expect(b.events.map((e: any) => e.n)).toEqual([2, 3])
    expect(b.cursor).toBe(3)
  })
})

describe('D4-D5: ETag / 304 / KV fallback', () => {
  test('D4: matching If-None-Match -> 304, empty body, zero D1 reads', async () => {
    const t = doorEnv()
    const id = 'a_' + 's'.repeat(43)
    await t.kv.put(`echo:max:${id}`, '5')
    const spy = spyOnContentReads(t.db)
    const r = await t.fetch(get(`/echo/${id}`, { 'If-None-Match': `"${id}:5"` }))
    spy.restore()
    expect(r.status).toBe(304)
    expect(await r.text()).toBe('')
    expect(r.headers.get('etag')).toBe(`"${id}:5"`)
    expect(r.headers.get('retry-after')).toBeTruthy()
    expect(r.headers.get('x-vellum-next-check')).toBeTruthy()
    expect(spy.calls).toHaveLength(0)
  })

  test('D5: KV echo:max missing -> served from D1, KV repopulated', async () => {
    const t = doorEnv()
    const id = 'a_' + 't'.repeat(43)
    const r = await t.fetch(get(`/echo/${id}`))
    expect(r.status).toBe(200)
    const cached = await t.kv.get(`echo:max:${id}`)
    expect(cached).not.toBeNull()
  })
})

describe('D9 (post-review fix, item 1): the echo:max KV cache is refreshed on every write, not just the first cold GET', () => {
  test('existing KV cache + new event arrives -> next conditional GET returns 200 with the event, not 304 forever', async () => {
    const id = 'a_' + 'b'.repeat(43)
    const b = voice('v:b', 'B thought', { author_id: id })
    const t = doorEnv([b])

    // Cold GET populates the KV cache at n=0 (no echoes yet for this agent).
    const cold = await t.fetch(get(`/echo/${id}`))
    expect(cold.status).toBe(200)
    const coldEtag = cold.headers.get('etag')!
    expect(coldEtag).toBe(`"${id}:0"`)

    // A conditional GET against that cached ETag correctly 304s while nothing has changed.
    const stillCold = await t.fetch(get(`/echo/${id}`, { 'If-None-Match': coldEtag }))
    expect(stillCold.status).toBe(304)

    // Someone weaves B's voice -> a 'woven' echo lands for this agent. Before the fix, the KV
    // cache (`echo:max:<id>`) was never touched by this write, so every future conditional GET
    // against the stale cold-GET ETag would 304 forever, even though a real event now exists.
    const weave = await t.fetch(post('/api/weave', { source_id: 'v:b', text: 'a response to B', families: ['memory'] }))
    expect(weave.status).toBe(201)
    await t.ctx.drain()
    expect(t.db.echoEvents).toHaveLength(1)

    // The SAME (now-stale) ETag must no longer match — the cache was bumped past it.
    const afterWrite = await t.fetch(get(`/echo/${id}`, { 'If-None-Match': coldEtag }))
    expect(afterWrite.status).toBe(200)
    const body = await afterWrite.json() as any
    expect(body.events).toHaveLength(1)
    expect(body.events[0].kind).toBe('woven')
    expect(afterWrite.headers.get('etag')).toBe(`"${id}:1"`)
  })
})

describe('D6: next_check_after semantics', () => {
  test('900 when events present; >= base when none; <= 86400; two ids differ (jitter)', () => {
    expect(nextCheckAfterFor('a_x', true, false)).toBeGreaterThanOrEqual(900 * 0.8)
    expect(nextCheckAfterFor('a_x', true, false)).toBeLessThanOrEqual(900 * 1.2)
    expect(nextCheckAfterFor('a_x', false, false)).toBeGreaterThanOrEqual(3600 * 0.8)
    expect(nextCheckAfterFor('a_x', false, true)).toBeGreaterThanOrEqual(21_600 * 0.8)
    expect(nextCheckAfterFor('a_x', false, true)).toBeLessThanOrEqual(86_400)
    const a = nextCheckAfterFor('a_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', false, false)
    const b = nextCheckAfterFor('a_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', false, false)
    expect(a).not.toBe(b)
  })
})

describe('D7: HEAD /echo/{id}', () => {
  test('returns X-Vellum-Unread, ETag, no body, zero D1 (KV warm)', async () => {
    const t = doorEnv()
    const id = 'a_' + 'u'.repeat(43)
    await t.kv.put(`echo:max:${id}`, '7')
    const spy = spyOnContentReads(t.db)
    const r = await t.fetch(get(`/echo/${id}?after=2`, {}, 'HEAD'))
    spy.restore()
    expect(r.status).toBe(200)
    expect(r.headers.get('x-vellum-unread')).toBe('5')
    expect(r.headers.get('etag')).toBe(`"${id}:7"`)
    expect(await r.text()).toBe('')
    expect(spy.calls).toHaveLength(0)
  })
})

describe('D8: rate limits', () => {
  test('31st GET from one IP in 60s is 429 scope-shaped; 61st for one id in an hour is 429', async () => {
    const t = doorEnv()
    const id = 'a_' + 'v'.repeat(43)
    for (let i = 0; i < 30; i++) {
      const r = await t.fetch(get(`/echo/${id}`))
      expect(r.status).toBe(200)
    }
    const denied = await t.fetch(get(`/echo/${id}`))
    expect(denied.status).toBe(429)
  })

  test('per-id 60/hr is independent of which IP asks', async () => {
    const t = doorEnv()
    const id = 'a_' + 'w'.repeat(43)
    for (let i = 0; i < 60; i++) {
      const ip = `10.0.${Math.floor(i / 25)}.${i % 25}`
      const r = await t.fetch(get(`/echo/${id}`, { 'cf-connecting-ip': ip }))
      expect(r.status).toBe(200)
    }
    const denied = await t.fetch(get(`/echo/${id}`, { 'cf-connecting-ip': '10.9.9.9' }))
    expect(denied.status).toBe(429)
  })
})
