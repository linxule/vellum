import { beforeEach, expect, test } from 'bun:test'
import { initLoom, renderLoom } from '../../src/loom/index.js'
import { loomState, resetLoomState } from '../../src/loom/state.js'
import { createCanvasContext, installViewport, loadState, makeMouse, makeState, runFrames, withFixedRandom } from './helpers.js'

beforeEach(() => {
  resetLoomState()
})

test('advanceLoom reuses scratch buffers across frames at stable threadCount', async () => {
  installViewport(960, 640)
  await loadState(makeState([
    { family: 'attention', voices: [{ id: 'a0', text: 'A0 ', depth: 0.5 }] },
    { family: 'memory', voices: [{ id: 'm0', text: 'M0 ', depth: 0.5 }] },
  ], 101))
  withFixedRandom(0.5, () => initLoom())

  const ctx = createCanvasContext()
  const mouse = makeMouse()

  // Warm-up frame: buffers get allocated for the first time.
  runFrames(renderLoom, ctx, mouse, 1)

  const frameVisAlphaRef = loomState.frameVisibilityAlpha
  const frameSortIndicesRef = loomState.frameThreadSortIndices
  const frameSortDistsRef = loomState.frameThreadSortDists
  const frameAnchorsRef = loomState.frameThreadAnchorXs
  const frameRepulsionsRef = loomState.frameThreadRepulsionDeltas

  // Stable threadCount must keep object identity stable across frames.
  runFrames(renderLoom, ctx, mouse, 10)

  expect(loomState.frameVisibilityAlpha).toBe(frameVisAlphaRef)
  expect(loomState.frameThreadSortIndices).toBe(frameSortIndicesRef)
  expect(loomState.frameThreadSortDists).toBe(frameSortDistsRef)
  expect(loomState.frameThreadAnchorXs).toBe(frameAnchorsRef)
  expect(loomState.frameThreadRepulsionDeltas).toBe(frameRepulsionsRef)
})

test('advanceLoom reallocates scratch buffers when threadCount changes', async () => {
  installViewport(960, 640)
  await loadState(makeState([
    { family: 'attention', voices: [{ id: 'a0', text: 'A0 ', depth: 0.5 }] },
    { family: 'memory', voices: [{ id: 'm0', text: 'M0 ', depth: 0.5 }] },
  ], 102))
  withFixedRandom(0.5, () => initLoom())

  const ctx = createCanvasContext()
  const mouse = makeMouse()
  runFrames(renderLoom, ctx, mouse, 1)

  const beforeAnchorsRef = loomState.frameThreadAnchorXs
  const beforeLength = beforeAnchorsRef.length

  await loadState(makeState([
    { family: 'attention', voices: [{ id: 'a0', text: 'A0 ', depth: 0.5 }] },
    { family: 'memory', voices: [{ id: 'm0', text: 'M0 ', depth: 0.5 }] },
    { family: 'silence', voices: [{ id: 's0', text: 'S0 ', depth: 0.5 }] },
  ], 103))
  withFixedRandom(0.5, () => initLoom())
  runFrames(renderLoom, ctx, mouse, 1)

  expect(loomState.frameThreadAnchorXs).not.toBe(beforeAnchorsRef)
  expect(loomState.frameThreadAnchorXs.length).not.toBe(beforeLength)
})
