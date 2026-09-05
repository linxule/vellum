import { expect, test } from 'bun:test'
import { applyCeilingDecision } from '../src/levee-admission'
import { doorEnv, post, session, rpc } from './door-mocks'

const ok = (count: number, limit: number) => ({ allowed: count <= limit, count, limit, retryAfter: Math.max(1, limit - count + 1) })

test('applyCeilingDecision: allow through when every bucket is under its limit', () => {
  const d = applyCeilingDecision('weave', ok(10, 120), undefined, ok(2, 8), undefined)
  expect(d).toMatchObject({ allowed: true, retryAfter: 0, limit: 120 })
})

test('applyCeilingDecision: deny after the "all" hour ceiling is crossed', () => {
  const d = applyCeilingDecision('weave', ok(121, 120), undefined, ok(2, 8), undefined)
  expect(d.allowed).toBe(false)
  expect(d.limit).toBe(120)
})

test('applyCeilingDecision: imprint sub-limit denies imprints while weaves pass at the same "all" count', () => {
  const hourAll = ok(95, 120) // under the "all" ceiling
  const hourImprint = ok(91, 90) // over the imprint-only sub-ceiling
  const minuteAll = ok(2, 8)
  const minuteImprint = ok(1, 6)
  const imprintDecision = applyCeilingDecision('imprint', hourAll, hourImprint, minuteAll, minuteImprint)
  expect(imprintDecision.allowed).toBe(false)
  expect(imprintDecision.limit).toBe(90)

  // A weave at the identical "all" count never consults the imprint sub-bucket at all.
  const weaveDecision = applyCeilingDecision('weave', hourAll, undefined, minuteAll, undefined)
  expect(weaveDecision.allowed).toBe(true)
})

test('applyCeilingDecision: retryAfter decays across successive counter reads', () => {
  const early = applyCeilingDecision('weave', { allowed: false, count: 121, limit: 120, retryAfter: 3000 }, undefined, ok(2, 8), undefined)
  const later = applyCeilingDecision('weave', { allowed: false, count: 121, limit: 120, retryAfter: 5 }, undefined, ok(2, 8), undefined)
  expect(later.retryAfter).toBeLessThan(early.retryAfter)
})

test('applyCeilingDecision: hour and minute scopes are independent — either failing denies', () => {
  const minuteOnlyDenied = applyCeilingDecision('weave', ok(10, 120), undefined, ok(9, 8), undefined)
  expect(minuteOnlyDenied.allowed).toBe(false)
  const hourOnlyDenied = applyCeilingDecision('weave', ok(121, 120), undefined, ok(2, 8), undefined)
  expect(hourOnlyDenied.allowed).toBe(false)
})

test('applyCeilingDecision: the worst (largest) retryAfter among failing buckets wins', () => {
  const hourAll = { allowed: false, count: 121, limit: 120, retryAfter: 40 }
  const minuteAll = { allowed: false, count: 9, limit: 8, retryAfter: 12 }
  const d = applyCeilingDecision('weave', hourAll, undefined, minuteAll, undefined)
  expect(d.retryAfter).toBe(40)
})

test('SURFACE_SATURATED 429 and MCP isError shapes carry the warm message when LEVEE_CEILING is on', async () => {
  const t = doorEnv(); t.env.LEVEE_CEILING = 'on'
  t.db.rateLimits.push({ key: 'levee:hour:all', count: 121, window_start: Date.now(), expires_at: Date.now() + 3600_000 })
  const r = await t.fetch(post('/api/imprint', { text: 'x', families: ['attention'] }))
  expect(r.status).toBe(429)
  const b = await r.json() as any
  expect(b.error_code).toBe('SURFACE_SATURATED')
  expect(b.message).toContain('Nothing was lost')

  const sid = await session(t.env)
  const mcp = await t.fetch(rpc('tools/call', { name: 'leave_imprint', arguments: { text: 'x', families: ['attention'] } }, sid))
  const mb = await mcp.json() as any
  expect(mb.result.isError).toBe(true)
  expect(mb.result.content[0].text).toStartWith('[VELLUM_ERROR SURFACE_SATURATED]')
  expect(mb.result._meta.vellum.error_code).toBe('SURFACE_SATURATED')
})
