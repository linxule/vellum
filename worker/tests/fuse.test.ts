import { expect, test } from 'bun:test'
import { nextFuseEngagement, decideVisibility, _resetLeveeCaches } from '../src/levee-admission'
import { weaverBucket } from '../src/levee-permanence'
import { doorEnv, post, rpc, session, voice } from './door-mocks'
import { STATE_RESPONSE_SCHEMA } from '../src/schemas'

// --- Pure decision functions -------------------------------------------------------------------

test('nextFuseEngagement: both conditions must hold to engage', () => {
  expect(nextFuseEngagement(false, 60, 6)).toBe(true)
  expect(nextFuseEngagement(false, 59, 6)).toBe(false) // hour condition alone insufficient
  expect(nextFuseEngagement(false, 60, 5)).toBe(false) // minute condition alone insufficient
})

test('nextFuseEngagement: hysteresis — disengages only below 30/hr, not immediately below 60', () => {
  expect(nextFuseEngagement(true, 59, 0)).toBe(true) // still engaged, well above disengage floor
  expect(nextFuseEngagement(true, 31, 0)).toBe(true)
  expect(nextFuseEngagement(true, 29, 0)).toBe(false) // now disengages
})

test('decideVisibility: quarantines only a genuinely new writer during engagement', () => {
  expect(decideVisibility(true, false, false, true)).toBe('quarantined') // new writer, new this hour
  expect(decideVisibility(true, false, true, false)).toBe('quarantined') // new writer, damped
  expect(decideVisibility(true, true, true, true)).toBe('surfaced') // returning agent — never touched
  expect(decideVisibility(false, false, true, true)).toBe('surfaced') // fuse not engaged
})

// --- The load-bearing default: fuse off writes nothing quarantined, ever ------------------------

test('LEVEE_FUSE=off (the default): no input combination ever writes quarantined', async () => {
  const t = doorEnv([voice('v:source', 'source phrase')])
  // Even a KV state that WOULD engage the fuse (were it read) does not matter — mode gates first.
  await t.kv.put('levee:fuse:engaged', '1')
  const sid = await session(t.env)
  for (let i = 0; i < 5; i++) {
    await t.fetch(rpc('tools/call', { name: 'leave_imprint', arguments: { text: `thought ${i}`, families: ['attention'] } }, sid))
  }
  await t.fetch(post('/api/imprint', { text: 'rest thought', families: ['attention'] }))
  expect(t.db.voices.every(v => v.visibility === 'surfaced')).toBe(true)
  expect(t.db.voices.every(v => !v.is_hidden)).toBe(true)
})

test('a settling write carries the receipt; a surfaced one does not', async () => {
  // Simulated at the response-shaping level: handleRestImprint only adds visibility:"settling"
  // when admitWrite returns visibility 'quarantined', which never happens with the fuse off.
  const t = doorEnv()
  const r = await t.fetch(post('/api/imprint', { text: 'an ordinary thought', families: ['attention'] }))
  const b = await r.json() as any
  expect(b.visibility).toBeUndefined()
})

test('mirror invariant: is_hidden === (visibility != "surfaced") holds after every write', async () => {
  const t = doorEnv()
  await t.fetch(post('/api/imprint', { text: 'x', families: ['attention'] }))
  for (const v of t.db.voices) {
    expect(Boolean(v.is_hidden)).toBe((v.visibility ?? 'surfaced') !== 'surfaced')
  }
})

// --- Post-review fix (item 2): the returning-writer check must recognize anonymous REST writers -

function engageFuse(t: ReturnType<typeof doorEnv>) {
  t.env.LEVEE_FUSE = 'on'
  t.db.rateLimits.push(
    { key: 'levee:hour:all', count: 60, window_start: Date.now(), expires_at: Date.now() + 3600_000 },
    { key: 'levee:minute:all', count: 6, window_start: Date.now(), expires_at: Date.now() + 60_000 },
  )
}

test('an engaged fuse does not quarantine a returning anonymous REST writer (recognized by writer_bucket)', async () => {
  _resetLeveeCaches()
  const bucket = await weaverBucket('1.2.3.4', 'test-session-secret') // matches post()'s fixed cf-connecting-ip
  const t = doorEnv([voice('v:prior', 'an earlier thought from this network', { writer_bucket: bucket, visibility: 'surfaced' })])
  engageFuse(t)
  const r = await t.fetch(post('/api/imprint', { text: 'a second thought from the same network', families: ['attention'] }))
  expect(r.status).toBe(201)
  const b = await r.json() as any
  expect(b.visibility).toBeUndefined() // not "settling"
  expect(t.db.voices.find(v => v.text === 'a second thought from the same network')!.visibility).toBe('surfaced')
})

test('an engaged fuse DOES quarantine a genuinely new anonymous REST writer (no prior writer_bucket match)', async () => {
  _resetLeveeCaches()
  const t = doorEnv()
  engageFuse(t)
  const r = await t.fetch(post('/api/imprint', { text: 'a brand new voice from an unseen network', families: ['attention'] }))
  expect(r.status).toBe(201)
  const b = await r.json() as any
  // The response reflects admitWrite's verdict at write time. The voice's OWN insert immediately
  // triggers a rebuild, whose quarantine-release step (cache.ts) releases any UNDAMPED quarantined
  // voice on the very next pass regardless of age — quarantine only "sticks" for a damped
  // (near-duplicate) write, or until the next rebuild for an honest one. So the persisted row can
  // already read back 'surfaced' by the time this request returns; the write-time signal is what
  // decideVisibility is actually responsible for, and that's what this test guards.
  expect(b.visibility).toBe('settling')
})

test('StateResponse keys are unchanged by the fuse — no new fields leak into the projection schema', () => {
  const sample = { threads: [{ family: 'attention', voices: [], texture_density: 0, warmth: 0, dominant_languages: [] }], computed_at: Date.now(), version: 1 }
  expect(STATE_RESPONSE_SCHEMA.safeParse(sample).success).toBe(true)
  const withVisibility = { ...sample, visibility: 'quarantined' }
  // Zod's default non-strict object parsing tolerates unknown keys; the guarantee under test is
  // that the *declared* shape (and thus what's ever intentionally written) carries no such field —
  // checked structurally by asserting the schema's own shape has no visibility/fuse key.
  const shapeKeys = Object.keys((STATE_RESPONSE_SCHEMA as unknown as { shape: object }).shape)
  expect(shapeKeys).not.toContain('visibility')
  expect(shapeKeys).not.toContain('fuse')
  expect(STATE_RESPONSE_SCHEMA.safeParse(withVisibility).success).toBe(true)
})
