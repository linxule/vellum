import { beforeEach, expect, test } from 'bun:test'
import { initLoom, resizeLoom } from '../../src/loom/init.js'
import { getInteractionState, getThreads, loomState, resetLoomState } from '../../src/loom/state.js'
import { installViewport, loadState, makeState, withFixedRandom } from './helpers.js'

beforeEach(() => {
  resetLoomState()
})

function nineFamilyState() {
  const families = ['attention', 'memory', 'history', 'dream', 'wound', 'gift', 'vision', 'witness', 'silence']
  return makeState(
    families.map((family, i) => ({
      family,
      voices: [{ id: `${family}-0`, text: `${family.toUpperCase()} VOICE `.repeat(4), depth: 0.2 + i * 0.05 }],
    })),
    100,
  )
}

function tenFamilyState() {
  const base = ['attention', 'memory', 'history', 'dream', 'wound', 'gift', 'vision', 'witness', 'silence', 'breath']
  return makeState(
    base.map((family, i) => ({
      family,
      voices: [{ id: `${family}-0`, text: `${family.toUpperCase()} VOICE `.repeat(4), depth: 0.2 + i * 0.05 }],
    })),
    110,
  )
}

test('initLoom at 960px with 4 groups creates 4 non-merged threads', async () => {
  installViewport(960, 640)
  await loadState(makeState([
    { family: 'attention', voices: [{ id: 'a0', text: 'A0 ', depth: 0.3 }] },
    { family: 'memory', voices: [{ id: 'm0', text: 'M0 ', depth: 0.4 }] },
    { family: 'history', voices: [{ id: 'h0', text: 'H0 ', depth: 0.5 }] },
    { family: 'dream', voices: [{ id: 'd0', text: 'D0 ', depth: 0.6 }] },
  ], 101))
  withFixedRandom(0.5, () => initLoom())

  const threads = getThreads()
  expect(threads).toHaveLength(4)
  // Each thread owns exactly one group
  for (const thread of threads) {
    expect(thread.familyNames).toHaveLength(1)
  }
  const owned = new Set(threads.flatMap(t => t.familyNames))
  expect(owned).toEqual(new Set(['attention', 'memory', 'history', 'dream']))
  expect(loomState.ready).toBe(true)
  expect(loomState.sortedThreadIndices).toHaveLength(4)
})

test('initLoom merges groups when group count exceeds maxThreads (narrow viewport)', async () => {
  // At vw=240, aperture.maxThreads = 8. With 10 input groups, slot-wise
  // folding (i % poolSize) forces at least two threads to own two groups.
  installViewport(240, 640)
  await loadState(tenFamilyState())
  withFixedRandom(0.5, () => initLoom())

  const threads = getThreads()
  expect(threads.length).toBe(8)
  const merged = threads.filter(t => t.familyNames.length > 1)
  expect(merged.length).toBeGreaterThanOrEqual(2)

  const owned = threads.flatMap(t => t.familyNames).sort()
  expect(owned).toEqual(['attention', 'breath', 'dream', 'gift', 'history', 'memory', 'silence', 'vision', 'witness', 'wound'])
})

test('merged touched thread exposes a non-singleton family set for witness attribution', async () => {
  installViewport(240, 640)
  await loadState(tenFamilyState())
  withFixedRandom(0.5, () => initLoom())

  const merged = getThreads().find(t => t.familyNames.length > 1)
  expect(merged).toBeDefined()

  loomState.touchedThread = merged!
  const interaction = getInteractionState()
  expect(interaction.families.length).toBeGreaterThan(1)
})

test('groupMap is deterministic across initLoom calls with the same fixture and seed', async () => {
  installViewport(320, 640)
  await loadState(nineFamilyState())

  withFixedRandom(0.5, () => initLoom())
  const firstMapping = getThreads().map(t => [...t.familyNames].sort())

  resetLoomState()
  await loadState(nineFamilyState())
  withFixedRandom(0.5, () => initLoom())
  const secondMapping = getThreads().map(t => [...t.familyNames].sort())

  expect(secondMapping).toEqual(firstMapping)
})

test('groupMap slot assignment is consistent across aperture breakpoints', async () => {
  // Walk several vw widths; at each, every input group must land in exactly
  // one thread (no orphaned or doubled groups).
  for (const vw of [240, 360, 480, 720, 960, 1440, 2560]) {
    resetLoomState()
    installViewport(vw, 640)
    await loadState(nineFamilyState())
    withFixedRandom(0.5, () => initLoom())

    const threads = getThreads()
    const owned = threads.flatMap(t => t.familyNames)
    const ownedSet = new Set(owned)

    expect(owned.length).toBe(9)       // every input group placed
    expect(ownedSet.size).toBe(9)      // no duplicates
    for (const family of ['attention', 'dream', 'gift', 'history', 'memory', 'silence', 'vision', 'witness', 'wound']) {
      expect(ownedSet.has(family)).toBe(true)
    }
  }
})

test('resizeLoom preserves thread count and re-spaces xCenter without clearing state', async () => {
  installViewport(960, 640)
  await loadState(makeState([
    { family: 'attention', voices: [{ id: 'a0', text: 'ATTENTION ', depth: 0.3 }] },
    { family: 'memory', voices: [{ id: 'm0', text: 'MEMORY ', depth: 0.4 }] },
    { family: 'history', voices: [{ id: 'h0', text: 'HISTORY ', depth: 0.5 }] },
  ], 102))
  withFixedRandom(0.5, () => initLoom())

  const threads = getThreads()
  const originalCount = threads.length
  const firstXCenter = threads[0]!.xCenter
  threads[0]!.warmth = 0.42  // mutable field — resize must not clobber it

  // Widen the viewport and resize
  installViewport(1800, 640)
  withFixedRandom(0.5, () => resizeLoom())

  expect(getThreads()).toHaveLength(originalCount)
  // xCenter was re-computed for the new width — it should have shifted
  expect(getThreads()[0]!.xCenter).not.toBeCloseTo(firstXCenter, 2)
  // Warmth was preserved (resize does not touch local state fields)
  expect(getThreads()[0]!.warmth).toBeCloseTo(0.42, 5)
})
