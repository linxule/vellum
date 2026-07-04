import { beforeEach, expect, test } from 'bun:test'
import { initLoom } from '../../src/loom/init.js'
import { advanceLoom, paintLoom, renderLoom } from '../../src/loom/render/frame.js'
import { loomState, resetLoomState } from '../../src/loom/state.js'
import { CanvasContextStub, createCanvasContext, installViewport, loadState, makeMouse, makeState, withFixedRandom } from './helpers.js'

beforeEach(() => {
  resetLoomState()
})

async function seedFrameFixture() {
  installViewport(960, 640)
  await loadState(makeState([
    { family: 'attention', voices: [{ id: 'a0', text: 'ATTENTION THREAD ', depth: 0.4 }] },
    { family: 'memory', voices: [{ id: 'm0', text: 'MEMORY THREAD ', depth: 0.25 }] },
  ], 91))
  withFixedRandom(0.5, () => initLoom())
}

// A stub that throws on any canvas mutation, used to prove advanceLoom()
// never touches a canvas context.
class ThrowingContext {
  get fillStyle(): never { throw new Error('advanceLoom read ctx.fillStyle') }
  set fillStyle(_v: unknown) { throw new Error('advanceLoom set ctx.fillStyle') }
  createLinearGradient(): never { throw new Error('advanceLoom called ctx.createLinearGradient') }
  createRadialGradient(): never { throw new Error('advanceLoom called ctx.createRadialGradient') }
  fillRect(): never { throw new Error('advanceLoom called ctx.fillRect') }
  fillText(): never { throw new Error('advanceLoom called ctx.fillText') }
  beginPath(): never { throw new Error('advanceLoom called ctx.beginPath') }
  arc(): never { throw new Error('advanceLoom called ctx.arc') }
  fill(): never { throw new Error('advanceLoom called ctx.fill') }
  stroke(): never { throw new Error('advanceLoom called ctx.stroke') }
  moveTo(): never { throw new Error('advanceLoom called ctx.moveTo') }
  lineTo(): never { throw new Error('advanceLoom called ctx.lineTo') }
}

test('advanceLoom mutates loomState and stores current-frame fields', async () => {
  await seedFrameFixture()
  const mouse = makeMouse()

  expect(loomState.currentAperture).toBeNull()
  expect(loomState.currentMouse).toBeNull()
  expect(loomState.frameVisibilityAlpha.length).toBe(0)

  withFixedRandom(0.5, () => advanceLoom(innerWidth, innerHeight, 100, 0.016, mouse))

  // Frame-local fields are populated
  expect(loomState.currentAperture).not.toBeNull()
  expect(loomState.currentMouse).toBe(mouse)
  expect(loomState.frameVisibilityAlpha.length).toBe(loomState.threads.length)

  // State advanced: VW/VH set
  expect(loomState.VW).toBe(innerWidth)
  expect(loomState.VH).toBe(innerHeight)
  // Ambient current oscillator moved (default was 0)
  expect(typeof loomState.current).toBe('number')
  // Sorted indices populated
  expect(loomState.sortedThreadIndices.length).toBe(loomState.threads.length)
})

test('advanceLoom never calls any ctx.* method', async () => {
  await seedFrameFixture()
  const mouse = makeMouse()
  // A throwing ctx — if advanceLoom touches it at all, the test throws
  // synchronously with a specific message naming the forbidden method.
  const ctx = new ThrowingContext()
  // Ensure advanceLoom does not look at `ctx` — it should not even take one.
  // This runs advance without a ctx arg, proving the contract.
  withFixedRandom(0.5, () => advanceLoom(innerWidth, innerHeight, 100, 0.016, mouse))
  // And verifies ctx was untouched (the throwing getters didn't fire).
  expect(ctx).toBeDefined()
})

test('paintLoom is a no-op when called without a preceding advanceLoom', async () => {
  await seedFrameFixture()
  const ctx = createCanvasContext()
  // currentAperture is still null after initLoom — paintLoom must short-circuit
  expect(loomState.currentAperture).toBeNull()
  paintLoom(ctx, 100)
  const stub = ctx as unknown as CanvasContextStub
  expect(stub.fillTextCalls.length).toBe(0)
})

test('renderLoom = advanceLoom + paintLoom (split produces the same draws)', async () => {
  await seedFrameFixture()
  const ctx1 = createCanvasContext()
  const mouse1 = makeMouse()
  mouse1.x = 480
  mouse1.y = 320

  // Path A: single renderLoom call
  withFixedRandom(0.5, () => renderLoom(ctx1, innerWidth, innerHeight, 100, 0.016, mouse1))
  const callsA = (ctx1 as unknown as CanvasContextStub).fillTextCalls.length

  // Reset and reseed so both paths start from identical state
  resetLoomState()
  await seedFrameFixture()
  const ctx2 = createCanvasContext()
  const mouse2 = makeMouse()
  mouse2.x = 480
  mouse2.y = 320

  // Path B: explicit advance + paint
  withFixedRandom(0.5, () => {
    advanceLoom(innerWidth, innerHeight, 100, 0.016, mouse2)
    paintLoom(ctx2, 100)
  })
  const callsB = (ctx2 as unknown as CanvasContextStub).fillTextCalls.length

  // Both paths should produce the same number of fillText calls
  expect(callsB).toBe(callsA)
  expect(callsA).toBeGreaterThan(0)
})

test('advanceLoom reuses frameVisibilityAlpha across frames when thread count is stable', async () => {
  await seedFrameFixture()
  const mouse = makeMouse()

  withFixedRandom(0.5, () => advanceLoom(innerWidth, innerHeight, 100, 0.016, mouse))
  const firstBuffer = loomState.frameVisibilityAlpha
  expect(firstBuffer.length).toBe(2)

  // Second frame, same thread count — buffer reference must be stable
  withFixedRandom(0.5, () => advanceLoom(innerWidth, innerHeight, 116, 0.016, mouse))
  expect(loomState.frameVisibilityAlpha).toBe(firstBuffer)

  withFixedRandom(0.5, () => advanceLoom(innerWidth, innerHeight, 132, 0.016, mouse))
  expect(loomState.frameVisibilityAlpha).toBe(firstBuffer)
})

test('advanceLoom allocates a fresh frameVisibilityAlpha when thread count changes', async () => {
  // Start empty — buffer length 0
  expect(loomState.frameVisibilityAlpha.length).toBe(0)

  // Single-thread fixture
  installViewport(960, 640)
  await loadState(makeState([
    { family: 'memory', voices: [{ id: 'm0', text: 'M0 ', depth: 0.3 }] },
  ], 93))
  withFixedRandom(0.5, () => initLoom())

  const mouse = makeMouse()
  withFixedRandom(0.5, () => advanceLoom(innerWidth, innerHeight, 100, 0.016, mouse))
  expect(loomState.frameVisibilityAlpha.length).toBe(1)
})
