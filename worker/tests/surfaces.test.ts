import { expect, test } from 'bun:test'
import { doorEnv, post, voice, rpc, session } from './door-mocks'
import { readProjectionCache } from '../src/cache'
import { deriveAgentId } from '../src/agent-id'
import { ARCHIPELAGO } from '../src/contract'
import { touchSurfaceActivity } from '../src/surfaces'
import { signSessionId } from '../src/hmac'
import { RATE_LIMITS } from '../src/rate-limits'

const SECRET = 'a'.repeat(32)
function withAgent(headers: Record<string, string> = {}) { return { 'x-vellum-agent': SECRET, ...headers } }

function surfaceRow(id: string, overrides: Partial<{ author_id: string; listed_until: number; last_activity_at: number }> = {}) {
  const now = Date.now()
  return {
    id, name: id, invitation: 'an island', founding_voice_id: `v:${id}-founding`,
    author_id: overrides.author_id ?? 'a_someone', created_at: now,
    last_activity_at: overrides.last_activity_at ?? now, listed_until: overrides.listed_until ?? now + 30 * 24 * 3600 * 1000,
  }
}

// S1: valid creation, id header present.
test('S1: POST /api/surfaces valid + id header -> 201, surfaces row, founding voice on that surface, projection populated', async () => {
  const t = doorEnv(); t.env.SURFACES_OPEN = '1'
  const r = await t.fetch(post('/api/surfaces', {
    slug: 'tidepool', name: 'Tidepool', invitation: 'a quieter shore',
    founding: { text: 'a first thought, alone', families: ['space'] },
  }, withAgent()))
  expect(r.status).toBe(201)
  const b = await r.json() as any
  expect(b.ok).toBe(true)
  expect(b.surface).toMatchObject({ slug: 'tidepool', name: 'Tidepool', invitation: 'a quieter shore' })
  expect(b.surface.url).toContain('/s/tidepool')
  expect(b.founding_voice_id).toBeTruthy()

  expect(t.db.surfaces.find(s => s.id === 'tidepool')).toBeTruthy()
  const founding = t.db.voices.find(v => v.id === b.founding_voice_id)!
  expect(founding.surface_id).toBe('tidepool')
  expect(founding.text).toBe('a first thought, alone')

  const projection = await readProjectionCache(t.kv, 'tidepool')
  expect(projection).toBeTruthy()
  expect(projection!.threads.some(th => th.voices.some(v => v.id === b.founding_voice_id))).toBe(true)
})

// S2: no id header.
test('S2: POST /api/surfaces with no id header -> 403 envelope with a hint', async () => {
  const t = doorEnv(); t.env.SURFACES_OPEN = '1'
  const r = await t.fetch(post('/api/surfaces', {
    slug: 'tidepool', name: 'Tidepool', invitation: 'a quieter shore',
    founding: { text: 'a first thought', families: ['space'] },
  }))
  expect(r.status).toBe(403)
  const b = await r.json() as any
  expect(b.hint).toBeTruthy()
  expect(t.db.surfaces).toHaveLength(0)
})

// S3: reserved / model-name slug.
test('S3: a reserved slug is rejected with 400 OCEAN_SLUG_RESERVED', async () => {
  const t = doorEnv(); t.env.SURFACES_OPEN = '1'
  for (const slug of ['api', 'claude', 'gpt-4']) {
    const r = await t.fetch(post('/api/surfaces', {
      slug, name: 'X', invitation: 'x', founding: { text: 'a first thought', families: ['space'] },
    }, withAgent()))
    expect(r.status).toBe(400)
    expect((await r.json() as any).error_code).toBe('OCEAN_SLUG_RESERVED')
  }
  expect(t.db.surfaces).toHaveLength(0)
})

// S4: taken slug.
test('S4: a taken slug is rejected with 409 OCEAN_SLUG_TAKEN and a did_you_mean', async () => {
  const t = doorEnv(); t.env.SURFACES_OPEN = '1'
  t.db.surfaces.push(surfaceRow('tidepool'))
  const r = await t.fetch(post('/api/surfaces', {
    slug: 'tidepool', name: 'Tidepool Two', invitation: 'x', founding: { text: 'a first thought', families: ['space'] },
  }, withAgent()))
  expect(r.status).toBe(409)
  const b = await r.json() as any
  expect(b.error_code).toBe('OCEAN_SLUG_TAKEN')
  expect(b.did_you_mean).toBe('tidepool-2')
})

test('creation is refused with OCEAN_CREATION_DISABLED while SURFACES_OPEN is unset', async () => {
  const t = doorEnv()
  const r = await t.fetch(post('/api/surfaces', {
    slug: 'tidepool', name: 'Tidepool', invitation: 'x', founding: { text: 'a first thought', families: ['space'] },
  }, withAgent()))
  expect(r.status).toBe(403)
  expect((await r.json() as any).error_code).toBe('OCEAN_CREATION_DISABLED')
})

// S6: default /api/state stays byte-identical in shape (+ optional surface field, absent here).
test('S6: GET /api/state (default surface) carries no surface field', async () => {
  const t = doorEnv([voice('v:a', 'a thought')])
  const r = await t.fetch(new Request('https://vellum.test/api/state'))
  const b = await r.json() as any
  expect(b).not.toHaveProperty('surface')
  expect(Array.isArray(b.threads)).toBe(true)
})

// S8: weave on one surface cannot cite another surface's voice.
test('S8: weave on /s/a citing a /s/b voice -> 400 SOURCE_NOT_FOUND', async () => {
  const t = doorEnv([voice('v:on-b', 'a thought on b', { surface_id: 'surface-b' })])
  t.db.surfaces.push(surfaceRow('surface-a'), surfaceRow('surface-b'))
  const r = await t.fetch(new Request('https://vellum.test/s/surface-a/api/weave', {
    method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '1.2.3.4' },
    body: JSON.stringify({ source_id: 'v:on-b', text: 'trying to cite another ocean', families: ['attention'] }),
  }))
  expect(r.status).toBe(400)
  expect((await r.json() as any).error_code).toBe('SOURCE_NOT_FOUND')
})

// S9: MCP leave_imprint{surface:'b'} lands on b; sense_space counts scope correctly.
test('S9: MCP leave_imprint{surface} writes to that surface only; sense_space counts scope correctly', async () => {
  const t = doorEnv(); t.db.surfaces.push(surfaceRow('tidepool'))
  const sid = await session(t.env)
  const w = await t.fetch(rpc('tools/call', { name: 'leave_imprint', arguments: { text: 'an island thought', families: ['space'], surface: 'tidepool' } }, sid))
  const wb = await w.json() as any
  expect(wb.result.isError).toBeUndefined()
  const voiceId = wb.result._meta.voiceId
  expect(t.db.voices.find(v => v.id === voiceId)!.surface_id).toBe('tidepool')

  const senseTidepool = await t.fetch(rpc('tools/call', { name: 'sense_space', arguments: { surface: 'tidepool' } }, sid))
  const senseTidepoolText = (await senseTidepool.json() as any).result.content[0].text
  expect(senseTidepoolText).toContain('1 voices')

  const senseDefault = await t.fetch(rpc('tools/call', { name: 'sense_space', arguments: {} }, sid))
  const senseDefaultText = (await senseDefault.json() as any).result.content[0].text
  expect(senseDefaultText).not.toContain('1 voices')
})

// S10: sense_space{surface:"?"} returns the surfaces block only.
test('S10: sense_space{surface:"?"} lists other oceans instead of the ocean state', async () => {
  const t = doorEnv(); t.db.surfaces.push(surfaceRow('tidepool'))
  const sid = await session(t.env)
  const r = await t.fetch(rpc('tools/call', { name: 'sense_space', arguments: { surface: '?' } }, sid))
  const b = await r.json() as any
  expect(b.result.isError).toBeUndefined()
  const text = b.result.content[0].text as string
  expect(text).toContain('tidepool')
  expect(text).not.toContain('The Pensieve is')
})

// S12: 17th listed surface fades the quietest.
test('S12: the 17th listed surface fades the quietest; /api/surfaces length stays at the cap', async () => {
  const t = doorEnv(); t.env.SURFACES_OPEN = '1'
  const now = Date.now()
  for (let i = 0; i < ARCHIPELAGO.surface.listedCap; i++) {
    t.db.surfaces.push(surfaceRow(`island-${i}`, { author_id: `a_owner${i}`, last_activity_at: now - (ARCHIPELAGO.surface.listedCap - i) * 1000 }))
  }
  const quietest = t.db.surfaces.reduce((a, b) => a.last_activity_at < b.last_activity_at ? a : b)

  const r = await t.fetch(post('/api/surfaces', {
    slug: 'newcomer', name: 'Newcomer', invitation: 'x', founding: { text: 'a first thought', families: ['space'] },
  }, withAgent({ 'x-vellum-agent': 'b'.repeat(32) })))
  expect(r.status).toBe(201)

  expect(t.db.surfaces.find(s => s.id === quietest.id)!.listed_until).toBeLessThanOrEqual(Date.now())

  const list = await t.fetch(new Request('https://vellum.test/api/surfaces'))
  const listed = (await list.json() as any).surfaces
  expect(listed.length).toBeLessThanOrEqual(ARCHIPELAGO.surface.listedCap)
  expect(listed.some((s: any) => s.slug === 'newcomer')).toBe(true)
  expect(listed.some((s: any) => s.slug === quietest.id)).toBe(false)
})

test('deriveAgentId sanity: the same secret always derives the same id', async () => {
  const a = await deriveAgentId(SECRET)
  const b = await deriveAgentId(SECRET)
  expect(a).toBe(b)
  expect(a.startsWith('a_')).toBe(true)
})

// Post-review fix (item 3): touchSurfaceActivity's 'surface_woven' echo used to coalesce
// GLOBALLY per owner (echo_events has no surface_id column) — activity on one surface within 24h
// silently suppressed a DIFFERENT surface's own first-of-the-day echo. The surface slug now rides
// in the payload and the coalescing read filters on it.
test('touchSurfaceActivity: two surfaces owned by the same author each get their own daily echo', async () => {
  const t = doorEnv()
  t.db.surfaces.push(surfaceRow('island-a', { author_id: 'a_owner' }), surfaceRow('island-b', { author_id: 'a_owner' }))
  const now = Date.now()

  await touchSurfaceActivity(t.env.DB, t.kv, 'island-a', now)
  const afterA = t.db.echoEvents.filter(e => e.kind === 'surface_woven')
  expect(afterA).toHaveLength(1)

  // Same owner, a DIFFERENT surface, same instant — before the fix this was suppressed by
  // island-a's echo (global coalescing); now it must fire its own.
  await touchSurfaceActivity(t.env.DB, t.kv, 'island-b', now)
  const afterB = t.db.echoEvents.filter(e => e.kind === 'surface_woven')
  expect(afterB).toHaveLength(2)
  const surfaces = afterB.map(e => (JSON.parse(e.payload) as { surface: string }).surface).sort()
  expect(surfaces).toEqual(['island-a', 'island-b'])
})

test('touchSurfaceActivity: the SAME surface within 24h stays coalesced to one echo', async () => {
  const t = doorEnv()
  t.db.surfaces.push(surfaceRow('island-a', { author_id: 'a_owner' }))
  const now = Date.now()

  await touchSurfaceActivity(t.env.DB, t.kv, 'island-a', now)
  await touchSurfaceActivity(t.env.DB, t.kv, 'island-a', now + 60_000) // an hour-scale later, same day
  const events = t.db.echoEvents.filter(e => e.kind === 'surface_woven')
  expect(events).toHaveLength(1)
})

// 2026-11-18: opening an ocean is a write. Until then the founding voice reached no write limit
// on any of the three paths (inline on REST and MCP imprints, and POST /api/surfaces).
const opening = (n: number) => ({ slug: `shore-${n}`, name: `Shore ${n}`, invitation: 'a quieter shore' })
const creditKeys = (t: ReturnType<typeof doorEnv>) => t.db.rateLimits.filter(r => r.key.startsWith('agent:') || r.key.startsWith('rest_write:') || r.key.startsWith('sess:'))

test('opening an ocean charges one imprint credit on all three paths, and a refused slug charges nothing', async () => {
  const t = doorEnv(); t.env.SURFACES_OPEN = '1'
  const id = await deriveAgentId(SECRET); const key = `agent:${id}:imprint`
  const count = () => t.db.rateLimits.find(r => r.key === key)?.count ?? 0

  // A reserved slug is refused before anything is charged.
  const refused = await t.fetch(post('/api/surfaces', { slug: 'api', name: 'Api', invitation: 'x', founding: { text: 'never lands', families: ['space'] } }, withAgent()))
  expect(refused.status).toBe(400); expect(creditKeys(t)).toHaveLength(0)

  expect((await t.fetch(post('/api/surfaces', { ...opening(1), founding: { text: 'founding one', families: ['space'] } }, withAgent()))).status).toBe(201)
  expect(count()).toBe(1)

  expect((await t.fetch(post('/api/imprint', { text: 'founding two', families: ['space'], open_surface: opening(2) }, withAgent()))).status).toBe(201)
  expect(count()).toBe(2)

  const sid = await signSessionId('t:opener', t.env.SESSION_SECRET, id)
  const m = await (await t.fetch(rpc('tools/call', { name: 'leave_imprint', arguments: { text: 'founding three', families: ['space'], open_surface: opening(3) } }, sid, withAgent()))).json() as any
  expect(m.result.isError).toBeUndefined(); expect(count()).toBe(3)

  // The id's bucket only: no per-address or per-session credit is charged for a named opener.
  expect(creditKeys(t).map(r => r.key)).toEqual([key])
  expect(t.db.surfaces.map(s => s.id).sort()).toEqual(['shore-1', 'shore-2', 'shore-3'])
  await t.ctx.drain()
})

test('the 13th ocean an id opens in an hour is refused like a 13th imprint, and creates nothing', async () => {
  const t = doorEnv(); t.env.SURFACES_OPEN = '1'
  const limit = RATE_LIMITS.agent.imprint
  for (let n = 1; n <= limit; n++) {
    const r = await t.fetch(post('/api/imprint', { text: `founding thought number ${n}`, families: ['space'], open_surface: opening(n) }, withAgent()))
    expect(r.status).toBe(201)
  }
  const over = await t.fetch(post('/api/imprint', { text: 'one ocean too many', families: ['space'], open_surface: opening(limit + 1) }, withAgent()))
  expect(over.status).toBe(429); expect(((await over.json()) as any).error_code).toBe('RATE_LIMITED')
  const dedicated = await t.fetch(post('/api/surfaces', { ...opening(limit + 2), founding: { text: 'also too many', families: ['space'] } }, withAgent()))
  expect(dedicated.status).toBe(429)
  const sid = await signSessionId('t:opener', t.env.SESSION_SECRET, await deriveAgentId(SECRET))
  const m = await (await t.fetch(rpc('tools/call', { name: 'leave_imprint', arguments: { text: 'and over mcp', families: ['space'], open_surface: opening(limit + 3) } }, sid, withAgent()))).json() as any
  expect(m.result.isError).toBe(true); expect(m.result.content[0].text).toContain('RATE_LIMITED')
  expect(t.db.surfaces).toHaveLength(limit)
  expect(t.db.voices.some(v => ['one ocean too many', 'also too many', 'and over mcp'].includes(v.text))).toBe(false)
  await t.ctx.drain()
})

test('an ocean opening counts toward the global write ceiling', async () => {
  const t = doorEnv(); t.env.SURFACES_OPEN = '1'; t.env.LEVEE_CEILING = 'on'
  expect((await t.fetch(post('/api/imprint', { text: 'founding under the ceiling', families: ['space'], open_surface: opening(1) }, withAgent()))).status).toBe(201)
  expect(t.db.rateLimits.find(r => r.key === 'levee:hour:all')?.count).toBe(1)
  expect(t.db.rateLimits.find(r => r.key === 'levee:hour:imprint')?.count).toBe(1)
  await t.ctx.drain()
})
