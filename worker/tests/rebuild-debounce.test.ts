import { expect, test } from 'bun:test'
import { trimProjectionToBudget, rebuildStateProjectionIfNotLocked, rebuildStateProjection } from '../src/cache'
import { doorEnv, voice } from './door-mocks'
import { MockExecutionContext } from './mocks'
import type { ThreadData } from '../src/types'

function thread(family: string, depths: number[]): ThreadData {
  return {
    family, warmth: 0, texture_density: depths.length, dominant_languages: ['en'],
    voices: depths.map((d, i) => ({ id: `v:${family}-${i}`, text: 'x'.repeat(50), lang: 'en', weave_count: 0, depth: d, weave_from: null, declared_model: null, observed_client_family: null })),
  }
}

test('trimProjectionToBudget: drops deepest-first and leaves foundation (depth <= 0.1) intact', () => {
  const threads = [thread('attention', [0.1, 0.1, 0.9, 0.8, 0.2])]
  const { threads: trimmed, trimmed: count } = trimProjectionToBudget(threads, 300) // tiny budget forces trimming
  expect(count).toBeGreaterThan(0)
  const remainingDepths = trimmed[0].voices.map(v => v.depth).sort()
  expect(remainingDepths).toContain(0.1)
  // The two foundation voices (depth 0.1) must never be the ones removed.
  expect(trimmed[0].voices.filter(v => v.depth <= 0.1)).toHaveLength(2)
})

test('trimProjectionToBudget: a payload already under budget is untouched', () => {
  const threads = [thread('attention', [0.1, 0.2, 0.3])]
  const { threads: result, trimmed } = trimProjectionToBudget(threads, 1_000_000)
  expect(trimmed).toBe(0)
  expect(result[0].voices).toHaveLength(3)
})

test('rebuild debounce: a burst inside the min interval yields one rebuild plus one follow-up, not N', async () => {
  // The follow-up retry genuinely sleeps REBUILD_MIN_INTERVAL_MS (5s) before checking the dirty
  // marker — this test's timeout is raised to accommodate that real delay rather than mocking time.
  const t = doorEnv([voice('v:a', 'a thought', { visibility: 'surfaced' })])
  t.env.LEVEE_REBUILD = 'on'
  const ctx = new MockExecutionContext()

  // First call: nothing cached yet, always rebuilds and writes computed_at = now.
  const first = await rebuildStateProjectionIfNotLocked(t.env.DB, t.kv, ctx as unknown as ExecutionContext, 'on')
  expect(first).toBe('rebuilt')

  // A burst of calls immediately after: all inside REBUILD_MIN_INTERVAL_MS, all debounce.
  const results = await Promise.all(Array.from({ length: 5 }, () =>
    rebuildStateProjectionIfNotLocked(t.env.DB, t.kv, ctx as unknown as ExecutionContext, 'on'),
  ))
  expect(results.every(r => r === 'debounced')).toBe(true)

  // The debounced calls scheduled a follow-up retry via ctx.waitUntil — draining it settles the
  // dirty marker into exactly one more rebuild, not five.
  const rebuildCountBefore = t.db.projectionRebuildCount
  await ctx.drain()
  expect(t.db.projectionRebuildCount).toBe(rebuildCountBefore + 1)
}, 8000)

test('rebuild debounce: a redebounced follow-up retry (real ctx threaded through) is not silently dropped', async () => {
  // Regression for the Phase 16 review finding: the follow-up retry used to call itself with
  // ctx: undefined, so if THAT retry itself woke up still inside a fresh debounce window, no
  // further retry was ever scheduled and the dirty marker could sit unprojected for up to the
  // full stale-read window (10 minutes, handlers/state.ts). This proves ctx now threads through
  // every retry level (bounded by MAX_DEBOUNCE_RETRIES).
  const t = doorEnv([voice('v:a', 'a thought', { visibility: 'surfaced' })])
  t.env.LEVEE_REBUILD = 'on'
  const ctx = new MockExecutionContext()

  const first = await rebuildStateProjectionIfNotLocked(t.env.DB, t.kv, ctx as unknown as ExecutionContext, 'on')
  expect(first).toBe('rebuilt')

  // Debounced: schedules a follow-up retry (attempt 0 -> 1) that sleeps ~5s.
  const debounced = await rebuildStateProjectionIfNotLocked(t.env.DB, t.kv, ctx as unknown as ExecutionContext, 'on')
  expect(debounced).toBe('debounced')
  expect(ctx.waitUntilCalls).toBe(1)

  // While that retry is asleep, another writer's rebuild lands directly and refreshes
  // computed_at very recently — so when the sleeping retry wakes at ~5s, it lands back inside a
  // FRESH debounce window and must re-debounce (not silently drop the dirty marker).
  await new Promise(resolve => setTimeout(resolve, 2000))
  await rebuildStateProjection(t.env.DB, t.kv, 'on')

  await ctx.drain()
  // Two waitUntil calls total: the original follow-up, plus the fix's re-scheduled follow-up
  // (attempt 1 -> 2), which only happens if the retry passed its real ctx through — the buggy
  // code (ctx: undefined on the recursive call) would leave this at 1.
  expect(ctx.waitUntilCalls).toBeGreaterThanOrEqual(2)
}, 16000)

test('rebuild debounce: LEVEE_REBUILD off (default) never debounces — every call rebuilds immediately', async () => {
  const t = doorEnv([voice('v:a', 'a thought')])
  const ctx = new MockExecutionContext()
  const first = await rebuildStateProjectionIfNotLocked(t.env.DB, t.kv, ctx as unknown as ExecutionContext)
  const second = await rebuildStateProjectionIfNotLocked(t.env.DB, t.kv, ctx as unknown as ExecutionContext)
  expect(first).toBe('rebuilt')
  expect(second).toBe('rebuilt')
})
