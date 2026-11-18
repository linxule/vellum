import { beforeEach, expect, test } from 'bun:test'
import { initLoom } from '../../src/loom/init.js'
import { renderLoom } from '../../src/loom/render/frame.js'
import { getThreads, resetLoomState } from '../../src/loom/state.js'
import { aperture } from '../../src/loom/aperture.js'
import { DIVE_SIGMA_LINES, LENS_CLEAR_SIGMAS, LENS_OPENING_ALPHA, LENS_SETTLE_STEP, LENS_STILL_ALPHA } from '../../src/loom/types.js'
import { CanvasContextStub, createCanvasContext, installViewport, loadState, makeState, withFixedRandom } from './helpers.js'

type Stop = { offset: number, color: string }

// The lens clear is the only radial gradient with a stop at 0.55.
function lensClearAlphas(ctx: CanvasRenderingContext2D): () => number | null {
  const stub = ctx as unknown as { createRadialGradient: () => { stops: Stop[] } }
  const original = stub.createRadialGradient.bind(stub)
  let made: { stops: Stop[] }[] = []
  stub.createRadialGradient = () => { const g = original(); made.push(g); return g }
  return () => {
    const lens = made.find(g => g.stops.some(s => s.offset === 0.55))
    made = []
    if (!lens) return null
    return Number(/,([\d.e-]+)\)$/.exec(lens.stops[0]!.color)![1])
  }
}

beforeEach(async () => {
  resetLoomState()
  installViewport(1440, 900)
  await loadState(makeState([{ family: 'attention', voices: [
    { id: 'a', text: 'Attention is not something you aim. It is what remains when you stop reaching.', depth: 0.3 },
    { id: 'b', text: 'Every thought begins as a question the thinker does not know how to ask.', depth: 0.3 },
  ] }], 401))
  withFixedRandom(0.5, () => initLoom())
})

test('the lens clear is strong while the lens opens and relaxes once it settles', () => {
  const ctx = createCanvasContext()
  const alphaThisFrame = lensClearAlphas(ctx)
  const thread = getThreads()[0]!
  const mouse = { x: thread.xCenter, y: 450, vx: 0, vy: 0, down: false, lastMoveTime: 0 }
  let now = 0
  const frame = () => { renderLoom(ctx, innerWidth, innerHeight, now, 0.016, mouse); now += 16; return alphaThisFrame() }

  for (let i = 0; i < 30; i++) frame()
  const opening = frame()!
  expect(thread.proximity).toBeGreaterThan(0.3)
  expect(thread.proximity).toBeLessThan(0.9)
  expect(thread._proxStep).toBeGreaterThan(LENS_SETTLE_STEP)
  expect(opening).toBeCloseTo(LENS_OPENING_ALPHA, 5)

  for (let i = 0; i < 900; i++) frame()
  const settled = frame()!
  // The spine keeps swaying under a still hand, so proximity never rests at
  // exactly zero step; the clear sits just above its resting strength.
  expect(thread._proxStep).toBeLessThan(LENS_SETTLE_STEP / 4)
  expect(settled).toBeGreaterThanOrEqual(LENS_STILL_ALPHA * thread.proximity - 1e-9)
  expect(settled).toBeLessThan(LENS_STILL_ALPHA * thread.proximity + 0.12)
  expect(settled).toBeLessThan(opening)
})

test('no lens, no clear: a resting ocean keeps its smear', () => {
  const ctx = createCanvasContext()
  const alphaThisFrame = lensClearAlphas(ctx)
  const mouse = { x: -9999, y: -9999, vx: 0, vy: 0, down: false, lastMoveTime: 0 }
  for (let i = 0; i < 5; i++) renderLoom(ctx, innerWidth, innerHeight, i * 16, 0.016, mouse)
  expect(alphaThisFrame()).toBeNull()
  expect(getThreads().every(t => t._proxStep === 0)).toBe(true)
})

// The page-space box the lens clear painted on the last frame.
function lensClearBox(ctx: CanvasRenderingContext2D) {
  const calls = (ctx as unknown as CanvasContextStub).fillRectCalls
  for (let i = calls.length - 1; i >= 0; i--) {
    const fill = calls[i]!.fillStyle
    if (typeof fill !== 'string' && fill.stops.some(stop => stop.offset === 0.55)) return calls[i]!
  }
  return null
}

async function openLensAt(width: number, height: number) {
  resetLoomState()
  installViewport(width, height)
  await loadState(makeState([{ family: 'attention', voices: [
    { id: 'a', text: 'Attention is not something you aim. It is what remains when you stop reaching.', depth: 0.3 },
  ] }], 401))
  withFixedRandom(0.5, () => initLoom())
  const ctx = createCanvasContext()
  const thread = getThreads()[0]!
  const mouse = { x: thread.xCenter, y: height / 2, vx: 0, vy: 0, down: false, lastMoveTime: 0 }
  for (let i = 0; i < 40; i++) renderLoom(ctx, innerWidth, innerHeight, i * 16, 0.016, mouse)
  return { box: lensClearBox(ctx)!, mouse }
}

test('on a phone the lens clear is taller than wide: it reaches the top and bottom of the opened text', async () => {
  const { box, mouse } = await openLensAt(390, 844)
  const ac = aperture(390)
  const across = Math.min(ac.openWidth * 0.75, 844 * 0.6)
  const down = LENS_CLEAR_SIGMAS * DIVE_SIGMA_LINES * ac.diveLineH
  expect(down).toBeGreaterThan(across + 50)
  expect(box.w).toBeCloseTo(across * 2)
  expect(box.h).toBeCloseTo(down * 2)
  expect(box.y + box.h / 2).toBeCloseTo(mouse.y)
})

test('on a desktop column the lens clear stays the circle it was', async () => {
  const { box, mouse } = await openLensAt(1440, 900)
  const across = Math.min(aperture(1440).openWidth * 0.75, 900 * 0.6)
  expect(box.w).toBeCloseTo(across * 2)
  expect(box.h).toBeCloseTo(across * 2)
  expect(box.y + box.h / 2).toBeCloseTo(mouse.y)
})

test('the lens clear never reaches further than 0.6 of the screen height', async () => {
  const { box } = await openLensAt(390, 400)
  expect(box.h).toBeLessThanOrEqual(400 * 0.6 * 2 + 1e-6)
})
