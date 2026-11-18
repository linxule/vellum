import { expect, test } from 'bun:test'
import { GRACE_HOURS, watchVerdict, type WatchFacts } from '../../scripts/production-watch'

const live: WatchFacts = { build: '6b06825aa0', known: true, onMain: true, changed: [], newestShippedAgeHours: 300 }

test('production on main with no shipped difference passes, however old', () => {
  expect(watchVerdict(live).ok).toBe(true)
})

test('docs or CI merged after the deploy do not count as behind', () => {
  // The caller only diffs shipped paths, so such commits leave `changed` empty.
  expect(watchVerdict({ ...live, newestShippedAgeHours: 1 }).ok).toBe(true)
})

test('a fresh merge gets a day to be deployed, then fails', () => {
  const behind = { ...live, changed: ['worker/src/cache.ts'] }
  expect(watchVerdict({ ...behind, newestShippedAgeHours: GRACE_HOURS - 1 }).ok).toBe(true)
  const late = watchVerdict({ ...behind, newestShippedAgeHours: GRACE_HOURS + 1 })
  expect(late.ok).toBe(false)
  expect(late.line).toContain('behind origin/main')
})

test('the 2026-09-30 case fails: a build with no id, or one GitHub does not have', () => {
  expect(watchVerdict({ ...live, build: null }).ok).toBe(false)
  expect(watchVerdict({ ...live, known: false }).ok).toBe(false)
})

test('a build from a branch that differs from main fails at once', () => {
  expect(watchVerdict({ ...live, onMain: false, changed: ['src/main.ts'], newestShippedAgeHours: 1 }).ok).toBe(false)
})
