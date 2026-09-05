import { expect, test } from 'bun:test'
import { doorEnv, post, voice, rpc, session } from './door-mocks'
import { readProjectionCache } from '../src/cache'
import { deriveAgentId } from '../src/agent-id'
import { ARCHIPELAGO } from '../src/contract'
import { touchSurfaceActivity } from '../src/surfaces'

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
