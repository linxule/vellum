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

test('an arrival with a hold lets go by itself and recedes; without one it holds until the reader acts', async () => {
  await seedPhantomFixture()
  const mouse = makeMouse()
  const ac = aperture(960, 640)
  // No hold (a ?highlight link, the ext-app, the old look): still held a minute later.
  triggerPhantomHover(0, 'm1', 1000)
  drivePhantomHover(61000, mouse, ac)
  expect(isPhantomActive()).toBe(true)

  // With a hold: held until it runs out, then let go, the lens left where it was
  // for the current to ease shut (reading.ts parks the pointer afterwards).
  triggerPhantomHover(0, 'm1', 1000, 30000)
  drivePhantomHover(30900, mouse, ac)
  expect(isPhantomActive()).toBe(true)
  const y = mouse.y
  drivePhantomHover(31100, mouse, ac)
  expect(isPhantomActive()).toBe(false)
  expect(loomState.recedingKey).toBe('memory')
  expect(loomState.recedingY).toBe(y)
  expect(mouse.y).toBe(y)
})

test('an arrival let go while the reader holds a current gives the lens back to it, with no recession', async () => {
  await seedPhantomFixture()
  const mouse = makeMouse()
  const ac = aperture(960, 640)
  loomState.readingKey = 'memory'
  triggerPhantomHover(0, 'm1', 1000, 30000)
  drivePhantomHover(2000, mouse, ac)
  drivePhantomHover(31100, mouse, ac)
  expect(isPhantomActive()).toBe(false)
  expect(loomState.recedingKey).toBeNull()
  expect(loomState.readingKey).toBe('memory')
})

test('refreshLoom gives an arrival the hold the page set', async () => {
  await seedPhantomFixture()
  loomState.arrivalHoldMs = 30000
  await loadState(makeState([
    {
      family: 'memory',
      voices: [
        { id: 'm0', depth: 0.6, text: 'MEMORY ONE folds into the thread. ' },
        { id: 'm1', depth: 0.2, text: 'MEMORY TWO rises closer to the surface. ' },
        { id: 'm2', depth: 0.1, text: 'MEMORY THREE has only just arrived. ' },
      ],
    },
  ], 12))
  withFixedRandom(0.5, () => refreshLoom([{ hasNew: true, newIds: new Set(['m2']) }], 5000))
  const focus = getPhantomFocus()
  expect(focus).not.toBeNull()
  expect(focus!.until).toBe(focus!.start + 30000)
})

test('an arrival does not take the lens from a current held by touch', async () => {
  await seedPhantomFixture()
  loomState.arrivalHoldMs = 30000
  loomState.readingKey = 'memory'
  await loadState(makeState([
    {
      family: 'memory',
      voices: [
        { id: 'm0', depth: 0.6, text: 'MEMORY ONE folds into the thread. ' },
        { id: 'm1', depth: 0.2, text: 'MEMORY TWO rises closer to the surface. ' },
        { id: 'm2', depth: 0.1, text: 'MEMORY THREE has only just arrived. ' },
      ],
    },
  ], 12))
  withFixedRandom(0.5, () => refreshLoom([{ hasNew: true, newIds: new Set(['m2']) }], 5000))
  expect(getPhantomFocus()).toBeNull()
  expect(loomState.readingKey).toBe('memory')
  // The arrival is still marked where it lies.
  expect(getThreads()[0]!.newVoiceIds.has('m2')).toBe(true)
})
