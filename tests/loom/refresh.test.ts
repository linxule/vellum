import { beforeEach, expect, test } from 'bun:test'
import { refreshLoom } from '../../src/loom/refresh.js'
import { initLoom, renderLoom } from '../../src/loom/index.js'
import { triggerPhantomHover } from '../../src/loom/phantom.js'
import { getPhantomFocus, getThreads, getTouchedThread, loomState, resetLoomState } from '../../src/loom/state.js'
import { createCanvasContext, installViewport, loadState, makeMouse, makeState, runFrames, withFixedRandom } from './helpers.js'

beforeEach(() => {
  resetLoomState()
})

test('refreshLoom preserves scroll, xCenter, warmth, and proximity', async () => {
  installViewport(960, 640)
  await loadState(makeState([{ family: 'attention', voices: [{ id: 'a0', text: 'A0 ', depth: 0.4 }] }], 41))
  withFixedRandom(0.5, () => initLoom())
  const thread = getThreads()[0]!
  thread.scroll = 3.5
  thread.xCenter = 222
  thread.warmth = 0.7
  thread.proximity = 0.4

  await loadState(makeState([{ family: 'attention', voices: [{ id: 'a0', text: 'A0 ', depth: 0.4 }] }], 42))
  withFixedRandom(0.5, () => refreshLoom(undefined, 100))

  const next = getThreads()[0]!
  expect(next.scroll).toBeCloseTo(3.5, 6)
  expect(next.xCenter).toBeCloseTo(222, 6)
  expect(next.warmth).toBeCloseTo(0.7, 6)
  expect(next.proximity).toBeCloseTo(0.4, 6)
})

test('refreshLoom -> phantom hover -> first render frame keeps touchedThread on the target', async () => {
  installViewport(960, 640)
  const mouse = makeMouse()
  const ctx = createCanvasContext()

  await loadState(makeState([
    { family: 'attention', voices: [{ id: 'a0', text: 'ATTENTION BASE ', depth: 0.6 }] },
    { family: 'memory', voices: [{ id: 'm0', text: 'MEMORY BASE ', depth: 0.5 }] },
  ], 43))
  withFixedRandom(0.5, () => initLoom())
  runFrames(renderLoom, ctx, mouse, 5)

  await loadState(makeState([
    { family: 'attention', voices: [{ id: 'a0', text: 'ATTENTION BASE ', depth: 0.6 }] },
    {
      family: 'memory',
      voices: [
        { id: 'm0', text: 'MEMORY BASE ', depth: 0.5 },
        { id: 'm1', text: 'MEMORY FRESH ', depth: 0.01 },
      ],
    },
  ], 44))
  withFixedRandom(0.5, () => refreshLoom([{ hasNew: false, newIds: new Set() }, { hasNew: true, newIds: new Set(['m1']) }], 80))
  renderLoom(ctx, innerWidth, innerHeight, 96, 0.016, mouse as any)
  expect(getTouchedThread()).toBe(getThreads()[1])
})

test('refreshLoom with no new voices is a no-op and does not touch state', async () => {
  installViewport(960, 640)
  await loadState(makeState([
    { family: 'attention', voices: [{ id: 'a0', text: 'A0 ', depth: 0.4 }] },
  ], 49))
  withFixedRandom(0.5, () => initLoom())

  // Write attention state onto the live thread, then refresh. The test
  // must read the POST-refresh thread (getThreads()[0]) rather than the
  // pre-refresh reference — initLoom() inside refreshLoom rebuilds the
  // threads array, so the pre-refresh reference becomes orphaned and any
  // assertion against it passes trivially regardless of whether the
  // preservation path is correct.
  getThreads()[0]!.warmth = 0.3
  getThreads()[0]!.emergenceStart = 0

  // refreshLoom with no newVoiceInfo — the !hasAnyNew branch
  withFixedRandom(0.5, () => refreshLoom(undefined, 100))

  const live = getThreads()[0]!
  expect(live.warmth).toBeCloseTo(0.3, 6)
  expect(live.emergenceStart).toBe(0)
  expect(live.newVoiceIds.size).toBe(0)
})

test('refreshLoom across regrouping preserves state by group identity, not by array index', async () => {
  // Setup at narrow viewport (vw=240 → maxThreads=8) with 10 groups.
  // With 10 groups and poolSize=8, initLoom merges: groupMap[0]=[0,8],
  // groupMap[1]=[1,9], groupMap[2..7]=[2..7]. So threads[0] holds groups
  // [0, 8] as a merged thread.
  installViewport(240, 640)
  const families = ['attention', 'memory', 'history', 'dream', 'wound', 'gift', 'vision', 'witness', 'silence', 'breath'] as const
  const state10 = makeState(families.map((family, i) => ({
    family,
    voices: [{ id: `v${i}`, text: `VOICE ${i} `, depth: 0.5 }],
  })), 60)
  await loadState(state10)
  withFixedRandom(0.5, () => initLoom())

  // Find the merged thread containing group 8 and stamp recognizable state
  // onto it. This warmth belongs to the merged [0,8] thread as a whole.
  const merged = getThreads().find(t => t.familyNames.includes('attention') && t.familyNames.includes('silence'))
  expect(merged).toBeDefined()
  expect(merged!.familyNames.length).toBeGreaterThan(1) // confirm merge happened
  merged!.warmth = 0.91
  merged!.scroll = 7.25
  merged!.proximity = 0.42

  // Widen the viewport past the regrouping threshold (vw=1440 → maxThreads=12).
  // Now all 10 groups fit 1-to-1 as 10 separate threads — [0,8] splits into
  // threads [0] and [8].
  installViewport(1440, 640)
  await loadState(state10) // reload to keep state fresh
  withFixedRandom(0.5, () => refreshLoom(undefined, 100))

  // Post-refresh, the new thread containing group 0 alone and the new thread
  // containing group 8 alone are both different identities from the old
  // merged [0,8] thread. Signature keying means neither inherits the merged
  // state — both get clean initLoom-fresh values.
  const newThread0 = getThreads().find(t => t.familyNames.length === 1 && t.familyNames[0] === 'attention')
  const newThread8 = getThreads().find(t => t.familyNames.length === 1 && t.familyNames[0] === 'silence')
  expect(newThread0).toBeDefined()
  expect(newThread8).toBeDefined()

  // Neither new thread should inherit the merged thread's warmth. Before the
  // group-identity fix, newThread0 would have received 0.91 (prevState[0]
  // copied by array index), silently migrating state to the wrong thread.
  expect(newThread0!.warmth).toBeLessThan(0.5)
  expect(newThread8!.warmth).toBeLessThan(0.5)

  // Same for scroll — the merged thread's scroll value must not migrate.
  expect(newThread0!.scroll).not.toBeCloseTo(7.25, 3)
  expect(newThread8!.scroll).not.toBeCloseTo(7.25, 3)
})

test('refreshLoom with phantomFocus active fires emergence on successor arrival despite high proximity', async () => {
  installViewport(960, 640)
  const mouse = makeMouse()
  const ctx = createCanvasContext()

  await loadState(makeState([
    { family: 'attention', voices: [{ id: 'a0', text: 'ATTENTION BASE ', depth: 0.6 }] },
    { family: 'memory', voices: [{ id: 'm0', text: 'MEMORY BASE ', depth: 0.5 }] },
  ], 47))
  withFixedRandom(0.5, () => initLoom())

  // Trigger phantom on thread 1 — phantomFocus !== null blocks the
  // userEngaged gate in refresh.ts regardless of proximity.
  triggerPhantomHover(1, 'm0', 100)
  withFixedRandom(0.5, () => runFrames(renderLoom, ctx, mouse, 60, 100))
  expect(loomState.threads[1]!.proximity).toBeGreaterThan(0.5)
  expect(getPhantomFocus()).not.toBeNull()

  // Land a successor arrival on the same thread
  await loadState(makeState([
    { family: 'attention', voices: [{ id: 'a0', text: 'ATTENTION BASE ', depth: 0.6 }] },
    {
      family: 'memory',
      voices: [
        { id: 'm0', text: 'MEMORY BASE ', depth: 0.5 },
        { id: 'm-next', text: 'MEMORY SUCCESSOR ', depth: 0.05 },
      ],
    },
  ], 48))

  withFixedRandom(0.5, () => refreshLoom([
    { hasNew: false, newIds: new Set() },
    { hasNew: true, newIds: new Set(['m-next']) },
  ], 2000))

  // Emergence fired despite high proximity — phantomFocus routed past the
  // userEngaged gate.
  const targetThread = getThreads()[1]!
  expect(targetThread.emergenceStart).toBeGreaterThan(0)
  expect(targetThread.emergenceVoiceUids.size).toBeGreaterThan(0)
  expect(targetThread.arrivalGlow).toBeGreaterThan(0.9)
})

test('unread voice ids are redistributed when viewport regrouping moves a group', async () => {
  installViewport(350, 640)
  const state = makeState(Array.from({ length: 9 }, (_, i) => ({
    family: ['attention', 'memory', 'history', 'dream', 'wound', 'gift', 'vision', 'witness', 'silence'][i]!,
    voices: [{ id: `v${i}`, text: `VOICE ${i} `, depth: 0.5 }],
  })), 45)
  await loadState(state)
  withFixedRandom(0.5, () => initLoom())
  const mergedThread = getThreads().find(thread => thread.familyNames.includes('silence'))!
  mergedThread.newVoiceIds.add('v8')

  installViewport(1440, 640)
  await loadState(makeState(state.threads.map(thread => ({
    family: thread.family,
    voices: thread.voices.map(voice => ({ id: voice.id, text: voice.text, depth: voice.depth })),
  })), 46))
  withFixedRandom(0.5, () => refreshLoom(undefined, 100))

  const redistributed = getThreads().find(thread => thread.familyNames.includes('silence'))!
  expect(redistributed.newVoiceIds.has('v8')).toBe(true)
})
