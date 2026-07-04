import { beforeEach, expect, test } from 'bun:test'
import { aperture } from '../../src/loom/aperture.js'
import { initLoom } from '../../src/loom/init.js'
import { drivePhantomHover, triggerPhantomHover, isPhantomActive } from '../../src/loom/phantom.js'
import { refreshLoom } from '../../src/loom/refresh.js'
import { getPhantomFocus, getThreads, loomState, resetLoomState } from '../../src/loom/state.js'
import { installViewport, loadState, makeMouse, makeState, withFixedRandom } from './helpers.js'

async function seedPhantomFixture() {
  resetLoomState()
  installViewport(960, 640)
  await loadState(makeState([
    {
      family: 'memory',
      voices: [
        { id: 'm0', depth: 0.6, text: 'MEMORY ONE folds into the thread. ' },
        { id: 'm1', depth: 0.2, text: 'MEMORY TWO rises closer to the surface. ' },
      ],
    },
  ], 11))
  withFixedRandom(0.5, () => initLoom())
}

async function seedMergedFixture() {
  resetLoomState()
  installViewport(240, 640)
  await loadState(makeState([
    { family: 'attention', voices: [{ id: 'attention-0', text: 'ATTENTION ', depth: 0.5 }] },
    { family: 'memory', voices: [{ id: 'memory-0', text: 'MEMORY ', depth: 0.5 }] },
    { family: 'history', voices: [{ id: 'history-0', text: 'HISTORY ', depth: 0.5 }] },
    { family: 'dream', voices: [{ id: 'dream-0', text: 'DREAM ', depth: 0.5 }] },
    { family: 'wound', voices: [{ id: 'wound-0', text: 'WOUND ', depth: 0.5 }] },
    { family: 'gift', voices: [{ id: 'gift-0', text: 'GIFT ', depth: 0.5 }] },
    { family: 'vision', voices: [{ id: 'vision-0', text: 'VISION ', depth: 0.5 }] },
    { family: 'witness', voices: [{ id: 'witness-0', text: 'WITNESS ', depth: 0.5 }] },
    { family: 'silence', voices: [{ id: 'silence-0', text: 'SILENCE ', depth: 0.5 }] },
    { family: 'breath', voices: [{ id: 'breath-0', text: 'BREATH ', depth: 0.5 }] },
  ], 21))
  withFixedRandom(0.5, () => initLoom())
}

beforeEach(() => {
  resetLoomState()
})

test('triggerPhantomHover without a voice stores a groupKey fallback', async () => {
  await seedPhantomFixture()
  triggerPhantomHover(0, undefined, 10)
  expect(getPhantomFocus()?.voiceId).toBeNull()
  expect(getPhantomFocus()?.groupKey).toBeTruthy()
  expect(loomState.phantomResolvedThreadIdx).toBe(0)
  expect(loomState.phantomResolvedVoiceFlatIdx).toBe(-1)
})

test('triggerPhantomHover resolves a voice id to the current flat index', async () => {
  await seedPhantomFixture()
  triggerPhantomHover(0, 'm1', 10)
  expect(getPhantomFocus()?.voiceId).toBe('m1')
  expect(loomState.phantomResolvedVoiceFlatIdx).toBe(1)
})

test('phantom driver initializes an all-zero path before reading from it', async () => {
  await seedPhantomFixture()
  const mouse = makeMouse()
  const thread = getThreads()[0]!
  triggerPhantomHover(0, 'm1', 10)
  drivePhantomHover(16, mouse as any, aperture(innerWidth))
  expect(thread._path.some(point => point.x !== 0)).toBe(true)
  expect(mouse.x).not.toBe(0)
})

test('isPhantomActive returns false after the user takes over', async () => {
  await seedPhantomFixture()
  const mouse = makeMouse()
  triggerPhantomHover(0, 'm1', 10)
  mouse.lastMove = (getPhantomFocus()?.start ?? 0) + 1
  drivePhantomHover(16, mouse as any, aperture(innerWidth))
  expect(isPhantomActive()).toBe(false)
  expect(loomState.phantomFocus).toBeNull()
})

test('userTookOver boundary: mouse.lastMove === phantomFocus.start does NOT count as takeover', async () => {
  await seedPhantomFixture()
  const mouse = makeMouse()
  triggerPhantomHover(0, 'm1', 10)
  const startTime = getPhantomFocus()!.start
  mouse.lastMove = startTime
  drivePhantomHover(16, mouse as any, aperture(innerWidth))
  expect(isPhantomActive()).toBe(true)
  expect(loomState.phantomFocus).not.toBeNull()
})

test('phantom follows voice across reshuffle', async () => {
  await seedMergedFixture()
  const mergedThread = getThreads().find(thread => thread.familyNames.includes('attention') && thread.familyNames.includes('silence'))
  expect(mergedThread).toBeDefined()
  const mergedThreadIdx = getThreads().indexOf(mergedThread!)

  triggerPhantomHover(mergedThreadIdx, 'silence-0', 10)

  installViewport(1440, 640)
  await loadState(makeState([
    { family: 'attention', voices: [{ id: 'attention-0', text: 'ATTENTION ', depth: 0.5 }] },
    { family: 'memory', voices: [{ id: 'memory-0', text: 'MEMORY ', depth: 0.5 }] },
    { family: 'history', voices: [{ id: 'history-0', text: 'HISTORY ', depth: 0.5 }] },
    { family: 'dream', voices: [{ id: 'dream-0', text: 'DREAM ', depth: 0.5 }] },
    { family: 'wound', voices: [{ id: 'wound-0', text: 'WOUND ', depth: 0.5 }] },
    { family: 'gift', voices: [{ id: 'gift-0', text: 'GIFT ', depth: 0.5 }] },
    { family: 'vision', voices: [{ id: 'vision-0', text: 'VISION ', depth: 0.5 }] },
    { family: 'witness', voices: [{ id: 'witness-0', text: 'WITNESS ', depth: 0.5 }] },
    { family: 'silence', voices: [{ id: 'silence-0', text: 'SILENCE ', depth: 0.5 }] },
    { family: 'breath', voices: [{ id: 'breath-0', text: 'BREATH ', depth: 0.5 }] },
  ], 22))
  withFixedRandom(0.5, () => refreshLoom(undefined, 100))

  const mouse = makeMouse()
  drivePhantomHover(116, mouse as any, aperture(innerWidth))

  const silenceThreadIdx = getThreads().findIndex(thread => thread.familyNames.length === 1 && thread.familyNames[0] === 'silence')
  expect(loomState.phantomResolvedThreadIdx).toBe(silenceThreadIdx)
  expect(loomState.phantomResolvedThreadIdx).not.toBe(mergedThreadIdx)
})

test('phantom clears on missing voice after refresh', async () => {
  await seedPhantomFixture()
  triggerPhantomHover(0, 'm1', 10)

  await loadState(makeState([
    {
      family: 'memory',
      voices: [{ id: 'm0', depth: 0.6, text: 'MEMORY ONE folds into the thread. ' }],
    },
  ], 12))
  withFixedRandom(0.5, () => refreshLoom(undefined, 100))

  const mouse = makeMouse()
  drivePhantomHover(116, mouse as any, aperture(innerWidth))
  expect(isPhantomActive()).toBe(false)
})

test('phantom without voiceId falls back to groupKey across refresh', async () => {
  await seedMergedFixture()
  const mergedThread = getThreads().find(thread => thread.familyNames.includes('attention') && thread.familyNames.includes('silence'))
  expect(mergedThread).toBeDefined()
  const mergedKey = [...mergedThread!.familyNames].sort().join(',')
  triggerPhantomHover(getThreads().indexOf(mergedThread!), undefined, 10)

  await loadState(makeState([
    { family: 'attention', voices: [{ id: 'attention-0', text: 'ATTENTION ', depth: 0.5 }] },
    { family: 'memory', voices: [{ id: 'memory-0', text: 'MEMORY ', depth: 0.5 }] },
    { family: 'history', voices: [{ id: 'history-0', text: 'HISTORY ', depth: 0.5 }] },
    { family: 'dream', voices: [{ id: 'dream-0', text: 'DREAM ', depth: 0.5 }] },
    { family: 'wound', voices: [{ id: 'wound-0', text: 'WOUND ', depth: 0.5 }] },
    { family: 'gift', voices: [{ id: 'gift-0', text: 'GIFT ', depth: 0.5 }] },
    { family: 'vision', voices: [{ id: 'vision-0', text: 'VISION ', depth: 0.5 }] },
    { family: 'witness', voices: [{ id: 'witness-0', text: 'WITNESS ', depth: 0.5 }] },
    { family: 'silence', voices: [{ id: 'silence-0', text: 'SILENCE ', depth: 0.5 }] },
    { family: 'breath', voices: [{ id: 'breath-0', text: 'BREATH ', depth: 0.5 }] },
  ], 23))
  withFixedRandom(0.5, () => refreshLoom(undefined, 100))

  const mouse = makeMouse()
  drivePhantomHover(116, mouse as any, aperture(innerWidth))

  expect(isPhantomActive()).toBe(true)
  const resolvedThread = getThreads()[loomState.phantomResolvedThreadIdx]!
  expect([...resolvedThread.familyNames].sort().join(',')).toBe(mergedKey)
})

test('triggerPhantomHover on an out-of-range thread index is a no-op', async () => {
  await seedPhantomFixture()
  triggerPhantomHover(5, 'm0', 10)
  expect(getPhantomFocus()).toBeNull()
})
