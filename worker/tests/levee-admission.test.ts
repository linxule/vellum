import { expect, test } from 'bun:test'
import { doorEnv, post, voice } from './door-mocks'
import { admitWrite, checkRequestAdmission, _resetLeveeCaches } from '../src/levee-admission'
import { contentHash } from '../src/levee-content'

test('I1: 413 with request.json() never called (throwing mock body)', async () => {
  const t = doorEnv()
  const req = new Request('https://vellum.test/api/imprint', {
    method: 'POST',
    headers: { 'content-length': '999999', 'cf-connecting-ip': '1.2.3.4' },
    body: new ReadableStream({ pull() { throw new Error('request.json() must never be called for an oversized body') } }),
  })
  const r = await t.fetch(req)
  expect(r.status).toBe(413)
})

test('per-IP request window: the 61st write-route request in 60s is denied when LEVEE_ADMISSION is on', async () => {
  const t = doorEnv(); t.env.LEVEE_ADMISSION = 'on'
  let lastStatus = 0
  for (let i = 0; i < 61; i++) {
    const r = await t.fetch(post('/api/imprint', { text: 'x', families: ['attention'] }))
    lastStatus = r.status
  }
  expect(lastStatus).toBe(429)
})

test('per-IP request window: LEVEE_ADMISSION off (default) never rejects on the request-admission layer', async () => {
  const t = doorEnv()
  let statuses: number[] = []
  for (let i = 0; i < 65; i++) statuses.push((await t.fetch(post('/api/imprint', { text: 'x', families: ['attention'] }))).status)
  // The scarce rest_write credit (12/hr) still binds — but never the (disabled) request window.
  expect(statuses.filter(s => s === 429).length).toBeGreaterThan(0)
  expect(statuses.filter(s => s === 429).length).toBeLessThanOrEqual(65 - 12)
})

test('overload mode: writes get 503 while reads keep serving, only when LEVEE_ADMISSION is on', async () => {
  const t = doorEnv(); t.env.LEVEE_ADMISSION = 'on'
  await t.kv.put('levee:overload', JSON.stringify({ until: Date.now() + 60_000, reason: 'test' }))
  _resetLeveeCaches()
  const write = await t.fetch(post('/api/imprint', { text: 'x', families: ['attention'] }))
  expect(write.status).toBe(503)
  expect((await write.json() as any).error_code).toBe('SURFACE_CLOSED')

  const read = await t.fetch(new Request('https://vellum.test/api/state'))
  expect(read.status).toBe(200)
})

test('fail-closed: a throwing D1 during request admission denies the write (503), never silently admits it', async () => {
  const t = doorEnv(); t.env.LEVEE_ADMISSION = 'on'
  t.db.failReads = true
  const r = await t.fetch(post('/api/imprint', { text: 'x', families: ['attention'] }))
  expect(r.status).toBe(503)
  expect((await r.json() as any).error_code).toBe('SURFACE_CLOSED')
  expect(t.db.voices).toHaveLength(0)
})

test('admitWrite charges nothing when an earlier stage rejects (REPEATED_WRITE denies before the write bucket)', async () => {
  const t = doorEnv(); t.env.LEVEE_DEDUPE = 'on'
  const now = Date.now()
  const hash = await contentHash('repeat me')
  t.db.voices.push(
    voice('v:a', 'repeat me', { content_hash: hash, trace_id: 'ip:1.2.3.4', created_at: now - 1000 }),
    voice('v:b', 'repeat me', { content_hash: hash, trace_id: 'ip:1.2.3.4', created_at: now - 500 }),
  )
  const before = t.db.rateLimits.find(r => r.key === 'rest_write:1.2.3.4')?.count ?? 0
  const r = await t.fetch(post('/api/imprint', { text: 'repeat me', families: ['attention'] }))
  expect(r.status).toBe(429)
  expect((await r.json() as any).error_code).toBe('REPEATED_WRITE')
  const after = t.db.rateLimits.find(r => r.key === 'rest_write:1.2.3.4')?.count ?? 0
  expect(after).toBe(before)
  expect(t.db.voices).toHaveLength(2)
})

test('admitWrite unit: a step-7 write-bucket denial never reaches the fuse step', async () => {
  const t = doorEnv([voice('v:x')])
  for (let i = 0; i < 12; i++) t.db.rateLimits.push({ key: `warmup:${i}`, count: 0, window_start: 0, expires_at: 0 }) // no-op filler, keeps array non-empty
  t.db.rateLimits.push({ key: 'rest_write:1.2.3.4', count: 12, window_start: Date.now(), expires_at: Date.now() + 3600_000 })
  const verdict = await admitWrite(t.env, { ip: '1.2.3.4', bodyBytes: 4, source: 'rest', kind: 'imprint' }, 'hello')
  expect(verdict).toMatchObject({ ok: false, code: 'RATE_LIMITED' })
})

test('checkRequestAdmission returns ok:true when LEVEE_ADMISSION is off, regardless of load', async () => {
  const t = doorEnv()
  const r = await checkRequestAdmission(t.env, '9.9.9.9', '/api/imprint')
  expect(r.ok).toBe(true)
})

// --- Post-review fix (item 5): LEVEE_ADMISSION=off must cost zero D1 writes ---------------------

test('checkRequestAdmission with LEVEE_ADMISSION off adds zero D1 rows (design law: shipped-off costs nothing)', async () => {
  const t = doorEnv()
  const before = t.db.rateLimits.length
  await checkRequestAdmission(t.env, '9.9.9.9', '/api/imprint')
  await checkRequestAdmission(t.env, '9.9.9.9', '/api/imprint')
  expect(t.db.rateLimits.length).toBe(before)
  expect(t.db.rateLimits.some(r => r.key === 'levee:attempts:hour')).toBe(false)
})

test('the levee:attempts:hour counter only appears once LEVEE_ADMISSION is on', async () => {
  const t = doorEnv(); t.env.LEVEE_ADMISSION = 'on'
  await checkRequestAdmission(t.env, '9.9.9.9', '/api/imprint')
  expect(t.db.rateLimits.some(r => r.key === 'levee:attempts:hour')).toBe(true)
})
