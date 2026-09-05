import { expect, test } from 'bun:test'
import { getWarmth, getWarmthMap, updateWarmth } from '../src/warmth'
import { doorEnv } from './door-mocks'

// Phase 18 "The Archipelago" Part B1/B3 — warmth_state's PRIMARY KEY became (surface_id, family).
// S11's acceptance: witness on /s/b warms (b, family) only; default warmth unchanged.

function surfaceRow(id: string) {
  return { id, name: 'Tidepool', invitation: 'a quieter shore', founding_voice_id: 'v:founding', author_id: 'a_owner', created_at: Date.now(), last_activity_at: Date.now(), listed_until: Date.now() + 30 * 24 * 3600 * 1000 }
}

test('updateWarmth/getWarmth default to the default surface when unspecified', async () => {
  const t = doorEnv()
  await updateWarmth(t.env.DB, 'attention', 30)
  expect(await getWarmth(t.env.DB, 'attention')).toBeGreaterThan(0)
  expect(await getWarmth(t.env.DB, 'attention', 'vellum')).toBeGreaterThan(0)
})

test('S11: warmth on one surface never bleeds into another', async () => {
  const t = doorEnv()
  t.db.surfaces.push(surfaceRow('tidepool'))
  await updateWarmth(t.env.DB, 'attention', 60, 'tidepool')
  expect(await getWarmth(t.env.DB, 'attention', 'tidepool')).toBeGreaterThan(0)
  expect(await getWarmth(t.env.DB, 'attention', 'vellum')).toBe(0)
})

test('getWarmthMap is scoped per surface', async () => {
  const t = doorEnv()
  t.db.surfaces.push(surfaceRow('tidepool'))
  await updateWarmth(t.env.DB, 'silence', 45, 'tidepool')
  const tidepoolMap = await getWarmthMap(t.env.DB, 'tidepool')
  const vellumMap = await getWarmthMap(t.env.DB, 'vellum')
  expect(tidepoolMap.silence).toBeGreaterThan(0)
  expect(vellumMap.silence).toBe(0)
})

test('S11 end-to-end: POST /s/tidepool/api/witness warms (tidepool, family) only', async () => {
  const t = doorEnv()
  t.db.surfaces.push(surfaceRow('tidepool'))
  const r = await t.fetch(new Request('https://vellum.test/s/tidepool/api/witness', {
    method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '9.9.9.9' },
    body: JSON.stringify({ family: 'memory', dwell_s: 60 }),
  }))
  expect(r.status).toBe(200)
  expect(await getWarmth(t.env.DB, 'memory', 'tidepool')).toBeGreaterThan(0)
  expect(await getWarmth(t.env.DB, 'memory', 'vellum')).toBe(0)
})
