import { expect, test } from 'bun:test'
import { parseSurfacePrefix, DEFAULT_SURFACE } from '../src/surfaces'
import { doorEnv, voice } from './door-mocks'

// Phase 18 "The Archipelago" Part B2 — prefix stripping, reserved slugs, S7/S13/S14.

test('parseSurfacePrefix: no /s/ prefix -> default surface, pathname untouched', () => {
  expect(parseSurfacePrefix('/api/state')).toEqual({ surface: DEFAULT_SURFACE, pathname: '/api/state' })
  expect(parseSurfacePrefix('/')).toEqual({ surface: DEFAULT_SURFACE, pathname: '/' })
})

test('parseSurfacePrefix: strips /s/<slug> to the remaining path, defaulting to /', () => {
  expect(parseSurfacePrefix('/s/tidepool')).toEqual({ surface: 'tidepool', pathname: '/' })
  expect(parseSurfacePrefix('/s/tidepool/')).toEqual({ surface: 'tidepool', pathname: '/' })
  expect(parseSurfacePrefix('/s/tidepool/api/state')).toEqual({ surface: 'tidepool', pathname: '/api/state' })
})

function surfaceRow(id: string) {
  return { id, name: 'Tidepool', invitation: 'a quieter shore', founding_voice_id: 'v:founding', author_id: 'a_owner', created_at: Date.now(), last_activity_at: Date.now(), listed_until: Date.now() + 30 * 24 * 3600 * 1000 }
}

test('S7: GET /s/<unknown>/api/state -> 404 OCEAN_NOT_FOUND with an /api/surfaces hint', async () => {
  const t = doorEnv()
  const r = await t.fetch(new Request('https://vellum.test/s/nowhere/api/state'))
  expect(r.status).toBe(404)
  const b = await r.json() as any
  expect(b.error_code).toBe('OCEAN_NOT_FOUND')
  expect(b.hint).toContain('/api/surfaces')
})

test('S7: the same unknown-slug 404 applies to the canvas itself, not just the API', async () => {
  const t = doorEnv()
  const r = await t.fetch(new Request('https://vellum.test/s/nowhere'))
  expect(r.status).toBe(404)
  expect((await r.json() as any).error_code).toBe('OCEAN_NOT_FOUND')
})

test('S5: GET /s/<slug>/api/state for a KNOWN surface reaches handleState (not 404)', async () => {
  const t = doorEnv()
  t.db.surfaces.push(surfaceRow('tidepool'))
  const r = await t.fetch(new Request('https://vellum.test/s/tidepool/api/state'))
  expect(r.status).toBe(200)
  const b = await r.json() as any
  expect(Array.isArray(b.threads)).toBe(true)
})

test('S14: GET /s/<slug> (browser) serves the SAME index.html bytes as GET /', async () => {
  const t = doorEnv()
  t.db.surfaces.push(surfaceRow('tidepool'))
  const root = await t.fetch(new Request('https://vellum.test/', { headers: { accept: 'text/html' } }))
  const surface = await t.fetch(new Request('https://vellum.test/s/tidepool', { headers: { accept: 'text/html' } }))
  expect(await surface.text()).toBe(await root.text())
})

test('S13: GET /s/<slug> with an AI UA gets that surface\'s own llms text, naming it', async () => {
  const t = doorEnv()
  t.db.surfaces.push(surfaceRow('tidepool'))
  const r = await t.fetch(new Request('https://vellum.test/s/tidepool', { headers: { 'user-agent': 'ClaudeBot/1.0' } }))
  expect(r.status).toBe(200)
  const text = await r.text()
  expect(text).toContain('Tidepool')
  expect(text).toContain('/s/tidepool')
})

test('default surface root is unaffected by the router prefix logic', async () => {
  const t = doorEnv()
  const r = await t.fetch(new Request('https://vellum.test/api/state'))
  expect(r.status).toBe(200)
})

// Hotfix 1: the default surface reached explicitly through the /s/ prefix must behave identically
// to the unprefixed route — S14 says `/s/vellum` and `/` serve the same canvas. Before this fix,
// the router only rewrote url.pathname when `surface !== DEFAULT_SURFACE`, so `/s/vellum/...`
// never got its prefix stripped, matched no route below, and fell through to a 404.
test('hotfix 1: GET /s/vellum/api/state (default surface via the /s/ prefix) reaches handleState, same shape as /api/state', async () => {
  const t = doorEnv()
  const direct = await t.fetch(new Request('https://vellum.test/api/state'))
  const prefixed = await t.fetch(new Request('https://vellum.test/s/vellum/api/state'))
  expect(prefixed.status).toBe(200)
  const directBody = await direct.json() as any
  const prefixedBody = await prefixed.json() as any
  expect(Array.isArray(prefixedBody.threads)).toBe(true)
  expect(prefixedBody).toEqual(directBody)
})

test('hotfix 1: GET /s/vellum (browser) serves the same canvas bytes as GET /', async () => {
  const t = doorEnv()
  const root = await t.fetch(new Request('https://vellum.test/', { headers: { accept: 'text/html' } }))
  const prefixed = await t.fetch(new Request('https://vellum.test/s/vellum', { headers: { accept: 'text/html' } }))
  expect(prefixed.status).toBe(root.status)
  expect(await prefixed.text()).toBe(await root.text())
})

// Post-review fix (item 1): buildLineage now requires a surfaceId — GET /api/lineage/:id (and the
// /s/<slug> form) must scope the lookup to the surface the request resolved to, so a voice on one
// surface never resolves through another surface's lineage endpoint.
test('GET /api/lineage/:id (default surface) is unchanged for a default-surface voice', async () => {
  const t = doorEnv([voice('v:seed', 'a default-surface thought', { surface_id: 'vellum' })])
  const r = await t.fetch(new Request('https://vellum.test/api/lineage/v:seed'))
  expect(r.status).toBe(200)
  const b = await r.json() as any
  expect(b.seed).toBe('v:seed')
})

test('cross-surface seed id: GET /s/<slug>/api/lineage/:id 404s for a voice seeded on a different surface', async () => {
  const t = doorEnv([voice('v:seed', 'a default-surface thought', { surface_id: 'vellum' })])
  t.db.surfaces.push(surfaceRow('tidepool'))
  const r = await t.fetch(new Request('https://vellum.test/s/tidepool/api/lineage/v:seed'))
  expect(r.status).toBe(404)
})

test('same-surface lookup still works: GET /s/<slug>/api/lineage/:id finds a voice seeded on that surface', async () => {
  const t = doorEnv([voice('v:seed', 'a tidepool thought', { surface_id: 'tidepool' })])
  t.db.surfaces.push(surfaceRow('tidepool'))
  const r = await t.fetch(new Request('https://vellum.test/s/tidepool/api/lineage/v:seed'))
  expect(r.status).toBe(200)
  const b = await r.json() as any
  expect(b.seed).toBe('v:seed')
})
