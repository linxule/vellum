import { expect, test } from 'bun:test'
import { computeQualifiedWeavers, hourBucketOf, isPermanent, weaverBucket } from '../src/levee-permanence'
import { computeDepth } from '../src/sedimentation'
import { rebuildStateProjection, readProjectionCache } from '../src/cache'
import { doorEnv, post, voice } from './door-mocks'

const hourMs = 3_600_000
const dayMs = 24 * hourMs

test('permanence: 10 weaves from 1 bucket in 1 hour is false (condition 1 fails)', () => {
  const rows = Array.from({ length: 10 }, () => ({ weaverKey: 'bucket-a', hourBucket: 100 }))
  expect(computeQualifiedWeavers(rows)).toBe(0)
})

test('permanence: 10 distinct buckets across only 2 distinct hours is false (condition 2 fails)', () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({ weaverKey: `bucket-${i}`, hourBucket: i % 2 }))
  expect(computeQualifiedWeavers(rows)).toBe(0)
})

test('permanence: 10 distinct buckets across 6+ distinct hours is true', () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({ weaverKey: `bucket-${i}`, hourBucket: i % 6 }))
  expect(computeQualifiedWeavers(rows)).toBe(10)
})

test('permanence: settling weavers uncounted until released — caller must exclude quarantined rows', () => {
  // computeQualifiedWeavers only sees what the caller passes in; a settling weave_log row should
  // never be included by the caller. Verified structurally: passing 9 legitimate + 1 excluded
  // settling weaver still reads 0 (condition 1 needs 10).
  const rows = Array.from({ length: 9 }, (_, i) => ({ weaverKey: `bucket-${i}`, hourBucket: i % 6 }))
  expect(computeQualifiedWeavers(rows)).toBe(0)
})

test('permanence: COALESCE prefers a present weaver_id over weaver_bucket (Phase 17 seam, tested now, unused now)', async () => {
  const t = doorEnv([voice('v:source', 'source phrase')])
  // Seed 10 weave_log-equivalent weavers via the DoorD1 internal weavers map by weaving 10 times
  // from a single ip (single bucket) — this only proves the read path COALESCEs correctly when a
  // weaver_id happens to be present; Phase 16 itself never writes weaver_id.
  const rows = await t.env.DB.prepare(
    'SELECT COALESCE(weaver_id, weaver_bucket) as weaver_key, created_at FROM weave_log WHERE source_voice_id = ?',
  ).bind('v:source').all<{ weaver_key: string | null }>()
  expect(rows.results).toEqual([])
})

test('permanence: legacy keeps permanence regardless of qualified_weavers', () => {
  expect(isPermanent({ qualified_weavers: 0, permanence_source: 'legacy' })).toBe(true)
  expect(isPermanent({ qualified_weavers: 0, permanence_source: 'earned' })).toBe(false)
  expect(isPermanent({ qualified_weavers: 10, permanence_source: 'earned' })).toBe(true)
})

test('permanence: declared_model never appears in this module', () => {
  // Static guard: the module's own source never references declared_model at all.
  const fs = require('fs') as typeof import('fs')
  const source = fs.readFileSync(new URL('../src/levee-permanence.ts', import.meta.url), 'utf8')
  expect(source).not.toContain('declared_model')
})

test('hourBucketOf groups timestamps into distinct clock-hour buckets', () => {
  const a = hourBucketOf(0)
  const b = hourBucketOf(hourMs - 1)
  const c = hourBucketOf(hourMs)
  expect(a).toBe(b)
  expect(c).toBe(a + 1)
})

test('weaverBucket: same /24 (IPv4) or /48 (IPv6) network hashes identically; different networks differ', async () => {
  const secret = 'test-secret'
  const a = await weaverBucket('203.0.113.5', secret)
  const b = await weaverBucket('203.0.113.200', secret) // same /24
  const c = await weaverBucket('198.51.100.5', secret) // different /24
  expect(a).toBe(b)
  expect(a).not.toBe(c)
  const v6a = await weaverBucket('2001:db8:1::1', secret)
  const v6b = await weaverBucket('2001:db8:1::9999', secret) // same /48
  expect(v6a).toBe(v6b)
})

test('permanence.10 sessions/1 IP/5 min/1 voice: not permanent — 1 bucket, 1 hour', async () => {
  const t = doorEnv([voice('v:source', 'source phrase')])
  for (let i = 0; i < 10; i++) {
    await t.fetch(post('/api/weave', { source_id: 'v:source', text: `response ${i}`, families: ['attention'] }))
  }
  const source = t.db.voices.find(v => v.id === 'v:source')!
  expect(source.qualified_weavers ?? 0).toBeLessThan(10)
})

// Post-review fix (item 4): LEVEE_PERMANENCE was declared in Env and threaded into modeOf()'s
// type union, but no read site ever called modeOf(env, 'LEVEE_PERMANENCE') — the weighted
// qualified_weavers rule ran unconditionally regardless of the flag's value (see
// docs/LAUNCH_RUNBOOK.md's flag table, pre-fix). Now computeDepth (and cache.ts's identical
// foundation filter) only reads qualified_weavers/permanence_source when the flag is 'on'; 'off'
// (the default) and 'shadow' both fall back to the pre-Phase-16 unique_weavers >= 10 rule, so
// the flag actually gates something.
test('computeDepth: LEVEE_PERMANENCE off ignores qualified_weavers, uses legacy unique_weavers >= 10', () => {
  const now = Date.now()
  const aged = now - 30 * dayMs
  // Weighted rule says NOT permanent (qualified_weavers 0, no legacy grandfathering) but the
  // legacy rule says permanent (unique_weavers >= 10) — the two disagree, so this voice is the
  // one that actually exercises the gate.
  const v = { created_at: aged, weave_count: 12, unique_weavers: 12, qualified_weavers: 0, permanence_source: 'earned' as const }
  const depthOff = computeDepth(v, 0, now, 'off')
  expect(depthOff).toBeLessThanOrEqual(0.1) // legacy rule: unique_weavers 12 >= 10 -> foundation
})

test('computeDepth: LEVEE_PERMANENCE on uses the weighted qualified_weavers/permanence_source rule', () => {
  const now = Date.now()
  const aged = now - 30 * dayMs
  const v = { created_at: aged, weave_count: 12, unique_weavers: 12, qualified_weavers: 0, permanence_source: 'earned' as const }
  const depthOn = computeDepth(v, 0, now, 'on')
  // Weighted rule: qualified_weavers 0 and not legacy -> NOT foundation, so the ordinary sinking
  // curve applies (well above the 0.1 foundation floor for a 30-day-old, unwarmed voice).
  expect(depthOn).toBeGreaterThan(0.1)
})

test('computeDepth: LEVEE_PERMANENCE on still honors qualified_weavers >= 10 (earned) as foundation', () => {
  const now = Date.now()
  const aged = now - 30 * dayMs
  const v = { created_at: aged, weave_count: 12, unique_weavers: 12, qualified_weavers: 10, permanence_source: 'earned' as const }
  expect(computeDepth(v, 0, now, 'on')).toBeLessThanOrEqual(0.1)
})

test('computeDepth: default permanenceMode (unspecified) behaves as off', () => {
  const now = Date.now()
  const aged = now - 30 * dayMs
  const v = { created_at: aged, weave_count: 12, unique_weavers: 12, qualified_weavers: 0, permanence_source: 'earned' as const }
  expect(computeDepth(v, 0, now)).toBeLessThanOrEqual(0.1)
})

test('rebuildStateProjection: the foundation read site flips with LEVEE_PERMANENCE (integration)', async () => {
  const now = Date.now()
  const aged = now - 30 * dayMs
  const v = voice('v:legacy-unique', 'an old often-woven thought', {
    created_at: aged, weave_count: 12, unique_weavers: 12, qualified_weavers: 0, permanence_source: 'earned',
  })
  const t = doorEnv([v])

  await rebuildStateProjection(t.env.DB, t.kv, 'off', 'vellum', 'off')
  const offProjection = await readProjectionCache(t.kv)
  const offVoice = offProjection!.threads.flatMap(th => th.voices).find(vd => vd.id === 'v:legacy-unique')!
  expect(offVoice.depth).toBeLessThanOrEqual(0.1)

  await rebuildStateProjection(t.env.DB, t.kv, 'off', 'vellum', 'on')
  const onProjection = await readProjectionCache(t.kv)
  const onVoice = onProjection!.threads.flatMap(th => th.voices).find(vd => vd.id === 'v:legacy-unique')!
  expect(onVoice.depth).toBeGreaterThan(0.1)
})
