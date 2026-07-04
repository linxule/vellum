import { beforeEach, expect, test } from 'bun:test'
import { initLoom } from '../../src/loom/init.js'
import { PATH_POINTS } from '../../src/loom/types.js'
import { getThreads, resetLoomState } from '../../src/loom/state.js'
import { installViewport, loadState, makeState, withFixedRandom } from './helpers.js'

beforeEach(() => {
  resetLoomState()
})

test('makeThread initializes all mutable-per-frame fields to zero / Infinity / empty', async () => {
  installViewport(960, 640)
  await loadState(makeState([
    { family: 'attention', voices: [{ id: 'a0', text: 'ATTENTION VOICE ', depth: 0.5 }] },
  ], 121))
  withFixedRandom(0.5, () => initLoom())

  const thread = getThreads()[0]!
  expect(thread.warmth).toBe(0)
  expect(thread.proximity).toBe(0)
  expect(thread.related).toBe(0)
  expect(thread.arrivalGlow).toBe(0)
  expect(thread.emergenceStart).toBe(0)
  expect(thread.emergenceDepthFrom).toBe(0)
  expect(thread.resonatingVoiceUids.size).toBe(0)
  expect(thread.wovenVoiceUids.size).toBe(0)
  expect(thread.emergenceVoiceUids.size).toBe(0)
  expect(thread.newVoiceIds.size).toBe(0)
  expect(thread.newVoiceUids.size).toBe(0)
  expect(thread.touched).toBe(false)
  expect(thread.touchFade).toBe(0)
  expect(thread.userScroll).toBe(0)
  expect(thread._handDist).toBe(Infinity)
  // _path is PATH_POINTS+1 points of (0,0)
  expect(thread._path).toHaveLength(PATH_POINTS + 1)
  for (const p of thread._path) {
    expect(p.x).toBe(0)
    expect(p.y).toBe(0)
  }
  // _frameColor defaults to baseColor (not origin)
  expect(thread._frameColor.length).toBe(3)
})

test('makeThread populates groupBoundaries monotonically from familyNames', async () => {
  // A merged thread covers multiple familyNames. Boundaries should be
  // monotonic cumulative lengths.
  installViewport(240, 640)
  await loadState(makeState([
    { family: 'attention', voices: [{ id: 'a0', text: 'A0 ', depth: 0.5 }] },
    { family: 'memory', voices: [{ id: 'm0', text: 'M0 ', depth: 0.5 }] },
    { family: 'history', voices: [{ id: 'h0', text: 'H0 ', depth: 0.5 }] },
    { family: 'dream', voices: [{ id: 'd0', text: 'D0 ', depth: 0.5 }] },
    { family: 'wound', voices: [{ id: 'w0', text: 'W0 ', depth: 0.5 }] },
    { family: 'gift', voices: [{ id: 'g0', text: 'G0 ', depth: 0.5 }] },
    { family: 'vision', voices: [{ id: 'v0', text: 'V0 ', depth: 0.5 }] },
    { family: 'witness', voices: [{ id: 'ww0', text: 'WW0 ', depth: 0.5 }] },
    { family: 'silence', voices: [{ id: 's0', text: 'S0 ', depth: 0.5 }] },
    { family: 'breath', voices: [{ id: 'b0', text: 'B0 ', depth: 0.5 }] },
  ], 122))
  withFixedRandom(0.5, () => initLoom())

  const merged = getThreads().find(t => t.familyNames.length > 1)
  expect(merged).toBeDefined()
  // Boundaries strictly increasing and length matches familyNames
  expect(merged!.groupBoundaries).toHaveLength(merged!.familyNames.length)
  for (let i = 1; i < merged!.groupBoundaries.length; i++) {
    expect(merged!.groupBoundaries[i]!).toBeGreaterThan(merged!.groupBoundaries[i - 1]!)
  }
})

test('makeThread families Set covers all per-voice families without duplicates', async () => {
  installViewport(960, 640)
  await loadState(makeState([
    { family: 'attention', voices: [{ id: 'a0', text: 'A0 ', depth: 0.5 }, { id: 'a1', text: 'A1 ', depth: 0.5 }] },
  ], 123))
  withFixedRandom(0.5, () => initLoom())

  const thread = getThreads()[0]!
  expect(thread.families.has('attention')).toBe(true)
  expect(thread.families.size).toBe(1)
})

test('makeThread lineEndCursors length equals totalLines', async () => {
  installViewport(960, 640)
  await loadState(makeState([
    { family: 'attention', voices: [{ id: 'a0', text: 'ATTENTION LONG-ISH VOICE TEXT LINE ', depth: 0.5 }] },
  ], 124))
  withFixedRandom(0.5, () => initLoom())

  const thread = getThreads()[0]!
  expect(thread.lineEndCursors).toHaveLength(thread.totalLines)
  expect(thread.totalLines).toBeGreaterThan(0)
})
