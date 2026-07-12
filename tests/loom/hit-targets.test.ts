import { beforeEach, expect, test } from 'bun:test'
import { initLoom, renderLoom } from '../../src/loom/index.js'
import { triggerPhantomHover } from '../../src/loom/phantom.js'
import { getLastFrameHitVoiceIdAt, loomState, resetLoomState } from '../../src/loom/state.js'
import { createCanvasContext, installViewport, loadState, makeMouse, makeState, runFrames, withFixedRandom } from './helpers.js'

beforeEach(() => {
  resetLoomState()
})

const OCEAN_TEXT = 'A SIGNED VOICE SPEAKS ITS PIECE INTO THE OCEAN AND WAITS TO BE READ '

// ── Filter unit test (deterministic, hand-built targets) ──

test('getLastFrameHitVoiceIdAt: woven target resolves by default, unwoven only with includeUnwoven', () => {
  loomState.lastFrameHitTargets = [
    ['woven', 100, 100, 20, 10, 100, 100, 0, true],
    ['unwoven', 300, 100, 20, 10, 300, 100, 0, false],
  ]
  // Default (woven-only) — the click/double-tap behavior is unchanged.
  expect(getLastFrameHitVoiceIdAt(100, 100)).toBe('woven')
  expect(getLastFrameHitVoiceIdAt(300, 100)).toBe(null)
  // includeUnwoven — the F13 hold path resolves either kind.
  expect(getLastFrameHitVoiceIdAt(100, 100, true)).toBe('woven')
  expect(getLastFrameHitVoiceIdAt(300, 100, true)).toBe('unwoven')
})

// ── Rendered integration (proves the thread.ts push emits the flag) ──

function renderVoiceUnderLens(voiceId: string, weave_count: number, version: number) {
  installViewport(960, 640)
  return loadState(makeState([
    { family: 'attention', voices: [{ id: voiceId, text: OCEAN_TEXT, depth: 0.2, weave_count }] },
  ], version)).then(() => {
    withFixedRandom(0.5, () => initLoom())
    const ctx = createCanvasContext()
    const mouse = makeMouse()
    runFrames(renderLoom, ctx, mouse, 5)
    triggerPhantomHover(0, voiceId)
    runFrames(renderLoom, ctx, mouse, 60, 80)
    return loomState.lastFrameHitTargets.find(t => t[0] === voiceId)
  })
}

test('ocean hit target: an unwoven voice under the lens resolves only with includeUnwoven', async () => {
  const target = await renderVoiceUnderLens('u0', 0, 401)
  expect(target).toBeDefined()
  expect(target![8]).toBe(false)
  const [, ax, ay] = target!
  expect(getLastFrameHitVoiceIdAt(ax, ay, true)).toBe('u0')
  expect(getLastFrameHitVoiceIdAt(ax, ay)).toBe(null)
})

test('ocean hit target: a woven voice under the lens still resolves with the default call', async () => {
  const target = await renderVoiceUnderLens('w0', 1, 402)
  expect(target).toBeDefined()
  expect(target![8]).toBe(true)
  const [, ax, ay] = target!
  expect(getLastFrameHitVoiceIdAt(ax, ay)).toBe('w0')
  expect(getLastFrameHitVoiceIdAt(ax, ay, true)).toBe('w0')
})
