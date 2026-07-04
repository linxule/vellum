import { beforeEach, expect, test } from 'bun:test'
import { aperture } from '../../src/loom/aperture.js'
import { initLoom } from '../../src/loom/init.js'
import { triggerPhantomHover } from '../../src/loom/phantom.js'
import {
  getLoomSnapshot,
  getResonances,
  getThreads,
  getTouchedThread,
  loomState,
  resetLoomState,
} from '../../src/loom/state.js'
import { setHighlight } from '../../src/loom/highlight.js'
import { setResonance } from '../../src/loom/resonance.js'
import { installViewport, loadState, makeState, withFixedRandom } from './helpers.js'

beforeEach(() => {
  resetLoomState()
})

// resetLoomState must be a complete reset — anything a test mutates before
// calling reset must be scrubbed. If a field is added to loomState, this test
// will catch the omission.

test('resetLoomState returns every loomState field to its initial value', async () => {
  installViewport(960, 640)
  await loadState(makeState([
    { family: 'attention', voices: [{ id: 'a0', text: 'A0 ', depth: 0.5 }] },
    { family: 'memory', voices: [{ id: 'm0', text: 'M0 ', depth: 0.2 }] },
  ], 77))
  withFixedRandom(0.5, () => initLoom())

  // Mutate almost every field
  loomState.VW = 1234
  loomState.VH = 5678
  loomState.holdTime = 9.9
  loomState.immersion = 0.8
  loomState.current = 0.4
  loomState.frameRatio = 2.5
  loomState.currentAperture = aperture(960)
  loomState.currentMouse = { x: 1, y: 2, prevX: 0, prevY: 0, speed: 3, moving: true, lastMove: 100, down: false, downStart: 0, touch: false }
  loomState.frameVisibilityAlpha = new Float32Array([0.5, 0.75])
  loomState.frameThreadSortIndices = new Int32Array([1, 0])
  loomState.frameThreadSortDists = new Float32Array([0.25, 0.75])
  loomState.frameThreadAnchorXs = new Float32Array([100, 200])
  loomState.frameThreadRepulsionDeltas = new Float32Array([0.1, -0.1])
  loomState.gustForce = 0.3
  loomState.gustTarget = 0.6
  loomState.gustTimer = 99
  loomState.gustDepthForce = 0.2
  loomState.highlightFamily = 'memory'
  loomState.highlightVoiceIndex = 2
  loomState.touchedThread = loomState.threads[0] ?? null
  loomState.prevTouchedThread = loomState.threads[0] ?? null
  loomState.sortedThreadIndices = [1, 0]
  setResonance('a0', 1000)
  triggerPhantomHover(0, 'a0', 100)
  loomState.diagHook = () => {}
  loomState.loomViewActive = true
  loomState.loomViewSeed = 'a0'
  loomState.loomViewTransition = 0.5
  loomState.lastFrameHitVoiceId = 'a0'

  resetLoomState()

  expect(loomState.threads).toEqual([])
  expect(loomState.ready).toBe(false)
  expect(loomState.VW).toBe(0)
  expect(loomState.VH).toBe(0)
  expect(loomState.touchedThread).toBeNull()
  expect(loomState.prevTouchedThread).toBeNull()
  expect(loomState.holdTime).toBe(0)
  expect(loomState.immersion).toBe(0)
  expect(loomState.sortedThreadIndices).toEqual([])
  expect(loomState.current).toBe(0)
  expect(loomState.frameRatio).toBe(1)
  expect(loomState.currentAperture).toBeNull()
  expect(loomState.currentMouse).toBeNull()
  expect(loomState.frameVisibilityAlpha.length).toBe(0)
  expect(loomState.frameThreadSortIndices.length).toBe(0)
  expect(loomState.frameThreadSortDists.length).toBe(0)
  expect(loomState.frameThreadAnchorXs.length).toBe(0)
  expect(loomState.frameThreadRepulsionDeltas.length).toBe(0)
  expect(loomState.gustForce).toBe(0)
  expect(loomState.gustTarget).toBe(0)
  expect(loomState.gustTimer).toBe(15)
  expect(loomState.gustDepthForce).toBe(0)
  expect(loomState.highlightFamily).toBeNull()
  expect(loomState.highlightVoiceIndex).toBe(-1)
  expect(loomState.resonances).toEqual([])
  expect(loomState.phantomFocus).toBeNull()
  expect(loomState.phantomResolvedThreadIdx).toBe(-1)
  expect(loomState.phantomResolvedVoiceFlatIdx).toBe(-1)
  expect(loomState.diagHook).toBeNull()
  // Loom view fields
  expect(loomState.loomViewActive).toBe(false)
  expect(loomState.loomViewSeed).toBeNull()
  expect(loomState.loomViewTransition).toBe(0)
  expect(loomState.loomTree).toBeNull()
  expect(loomState.loomViewAutoExit).toBeNull()
  expect(loomState.lastFrameHitVoiceId).toBeNull()
})

test('resetLoomState orphans prior thread references (getThreads returns fresh empty array)', async () => {
  installViewport(960, 640)
  await loadState(makeState([
    { family: 'attention', voices: [{ id: 'a0', text: 'A0 ', depth: 0.5 }] },
  ], 78))
  withFixedRandom(0.5, () => initLoom())

  const oldThread = getThreads()[0]!
  oldThread._handDist = 42
  oldThread._path = [{ x: 100, y: 200 }, { x: 150, y: 210 }]

  resetLoomState()

  expect(getThreads()).toEqual([])
  expect(getTouchedThread()).toBeNull()
  // The orphaned reference still holds the mutation, but is not observable
  // through any state accessor — that is the reset contract.
  expect(oldThread._handDist).toBe(42)
})

test('getLoomSnapshot + getResonances + getTouchedThread all reflect a reset state', async () => {
  installViewport(960, 640)
  await loadState(makeState([
    { family: 'memory', voices: [{ id: 'm0', text: 'M0 ', depth: 0.3 }] },
  ], 79))
  withFixedRandom(0.5, () => initLoom())

  setHighlight('m0')
  setResonance('m0', 500)

  resetLoomState()

  const snap = getLoomSnapshot()
  expect(snap.ready).toBe(false)
  expect(snap.threads).toEqual([])
  expect(snap.phantomActive).toBe(false)
  expect(snap.resonanceCount).toBe(0)
  expect(getResonances()).toEqual([])
  expect(getTouchedThread()).toBeNull()
})
