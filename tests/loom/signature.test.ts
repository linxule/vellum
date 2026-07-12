import { beforeEach, expect, test } from 'bun:test'
import { initLoom, renderLoom } from '../../src/loom/index.js'
import { buildLoomTree, renderLoomTree } from '../../src/loom/loom-view.js'
import { triggerPhantomHover } from '../../src/loom/phantom.js'
import { loomState, resetLoomState } from '../../src/loom/state.js'
import { aperture } from '../../src/loom/aperture.js'
import { CanvasContextStub, createCanvasContext, installViewport, loadState, makeMouse, makeState, runFrames, withFixedRandom } from './helpers.js'

beforeEach(() => {
  resetLoomState()
})

const OCEAN_TEXT = 'A SIGNED VOICE SPEAKS ITS PIECE INTO THE OCEAN AND WAITS TO BE READ '

function sigCalls(ctx: CanvasRenderingContext2D, marker: string) {
  return (ctx as unknown as CanvasContextStub).fillTextCalls.filter(c => c.text.includes(marker))
}

// ── Ocean (dive lens) ────────────────────────────────

test('ocean: signature is not drawn at rest', async () => {
  installViewport(960, 640)
  await loadState(makeState([
    { family: 'attention', voices: [{ id: 'a0', text: OCEAN_TEXT, depth: 0.2, declared_model: 'claude-sonnet-5' }] },
  ], 301))
  withFixedRandom(0.5, () => initLoom())

  const ctx = createCanvasContext()
  const mouse = makeMouse()             // off-screen: no touch, no dive
  runFrames(renderLoom, ctx, mouse, 8)

  expect(sigCalls(ctx, 'claude-sonnet-5').length).toBe(0)
})

test('ocean: living signature fades in under the dive lens', async () => {
  installViewport(960, 640)
  await loadState(makeState([
    { family: 'attention', voices: [{ id: 'a0', text: OCEAN_TEXT, depth: 0.2, declared_model: 'claude-sonnet-5' }] },
  ], 302))
  withFixedRandom(0.5, () => initLoom())

  const ctx = createCanvasContext()
  const mouse = makeMouse()
  runFrames(renderLoom, ctx, mouse, 5)
  triggerPhantomHover(0, 'a0')          // steer the dive lens onto the signed voice
  runFrames(renderLoom, ctx, mouse, 60, 80)

  const calls = sigCalls(ctx, 'claude-sonnet-5')
  expect(calls.length).toBeGreaterThan(0)
  // Living signatures render upright (not italic)
  expect(calls.every(c => !c.font.includes('italic'))).toBe(true)
})

test('ocean: afterglow signature is italic and silver under the dive lens', async () => {
  installViewport(960, 640)
  await loadState(makeState([
    { family: 'attention', voices: [{ id: 'a0', text: OCEAN_TEXT, depth: 0.2, declared_model: 'claude-3-opus' }] },
  ], 303))
  withFixedRandom(0.5, () => initLoom())

  const ctx = createCanvasContext()
  const mouse = makeMouse()
  runFrames(renderLoom, ctx, mouse, 5)
  triggerPhantomHover(0, 'a0')
  // The signature draws at the voice's LAST line, a few lines off lens center;
  // the afterglow gate (0.65) needs longer for the eased diveT to converge there.
  runFrames(renderLoom, ctx, mouse, 200, 80)

  const calls = sigCalls(ctx, 'claude-3-opus')
  expect(calls.length).toBeGreaterThan(0)
  // Categorical afterglow marker: italic font + flat silver tone, robust to CVD.
  expect(calls.every(c => c.font.includes('italic'))).toBe(true)
  expect(calls.some(c => typeof c.fillStyle === 'string' && c.fillStyle.startsWith('rgba(185,190,200'))).toBe(true)
})

test('ocean: a multi-line voice signs exactly once per frame (regression: per-line repeat)', async () => {
  installViewport(960, 640)
  // Two voices per tile so consecutive occurrence-ends of the signed voice are
  // spaced further apart than the dive lens radius — the assertion then counts
  // one occurrence, not the tiling.
  await loadState(makeState([
    { family: 'attention', voices: [
      { id: 'a0', text: OCEAN_TEXT + OCEAN_TEXT, depth: 0.2, declared_model: 'claude-sonnet-5' },
      { id: 'a1', text: OCEAN_TEXT + OCEAN_TEXT, depth: 0.3 },
    ] },
  ], 304))
  withFixedRandom(0.5, () => initLoom())

  const warm = createCanvasContext()
  const mouse = makeMouse()
  runFrames(renderLoom, warm, mouse, 5)
  triggerPhantomHover(0, 'a0')
  runFrames(renderLoom, warm, mouse, 200, 80)   // converge the lens fully

  // Single frame on a fresh ctx: the signature must appear exactly once —
  // never once per laid-out line of the voice.
  const ctx = createCanvasContext()
  runFrames(renderLoom, ctx, mouse, 1, 80)
  expect(sigCalls(ctx, 'claude-sonnet-5').length).toBe(1)
})

// ── RTL placement (regression: dot/signature drawn on the wrong side of RTL lines) ──

const RTL_TEXT = 'الانتباه هو ما يتبقى عندما تتوقف عن الوصول إليه دائما '

// Approximate the rendered line's center x from the body-text fillText calls
// sharing its y (the signature and dot share `line.y` exactly; body glyphs land
// within a few px of it via shimmerY jitter).
function lineCenterX(ctx: CanvasRenderingContext2D, y: number, excludeMarkers: string[]): number {
  const body = (ctx as unknown as CanvasContextStub).fillTextCalls.filter(c =>
    Math.abs(c.y - y) < 6 && !excludeMarkers.some(m => c.text.includes(m)))
  const xs = body.map(c => c.x)
  return (Math.min(...xs) + Math.max(...xs)) / 2
}

test('ocean: RTL signature is placed left of the line center', async () => {
  installViewport(960, 640)
  await loadState(makeState([
    { family: 'attention', voices: [{ id: 'rtl0', text: RTL_TEXT, depth: 0.2, declared_model: 'claude-sonnet-5' }] },
  ], 305))
  withFixedRandom(0.5, () => initLoom())

  const ctx = createCanvasContext()
  const mouse = makeMouse()
  runFrames(renderLoom, ctx, mouse, 5)
  triggerPhantomHover(0, 'rtl0')
  runFrames(renderLoom, ctx, mouse, 60, 80)

  const calls = sigCalls(ctx, 'claude-sonnet-5')
  expect(calls.length).toBeGreaterThan(0)
  const sig = calls[0]!
  const center = lineCenterX(ctx, sig.y, ['claude-sonnet-5'])
  expect(sig.x).toBeLessThan(center)
})

test('ocean: LTR signature is placed right of the line center (control)', async () => {
  installViewport(960, 640)
  await loadState(makeState([
    { family: 'attention', voices: [{ id: 'a0', text: OCEAN_TEXT, depth: 0.2, declared_model: 'claude-sonnet-5' }] },
  ], 306))
  withFixedRandom(0.5, () => initLoom())

  const ctx = createCanvasContext()
  const mouse = makeMouse()
  runFrames(renderLoom, ctx, mouse, 5)
  triggerPhantomHover(0, 'a0')
  runFrames(renderLoom, ctx, mouse, 60, 80)

  const calls = sigCalls(ctx, 'claude-sonnet-5')
  expect(calls.length).toBeGreaterThan(0)
  const sig = calls[0]!
  const center = lineCenterX(ctx, sig.y, ['claude-sonnet-5'])
  expect(sig.x).toBeGreaterThan(center)
})

// ── Loom view (radial lens) ──────────────────────────

const TWO_VOICE = (rootModel: string | null) => makeState([
  {
    family: 'attention',
    voices: [
      { id: 'root', text: 'The root voice. ', depth: 0.4, weave_count: 1, declared_model: rootModel },
      { id: 'child', text: 'The carried voice. ', depth: 0.2, weave_from: 'root' },
    ],
  },
], 320)

// Render one loom-view frame with the mouse a given distance from the root node,
// converging proximity instantly via a high frame ratio. Returns the frame's ctx.
async function loomRootHover(rootModel: string | null, mouseDist: number): Promise<CanvasRenderingContext2D> {
  installViewport(960, 640)
  await loadState(TWO_VOICE(rootModel))
  const tree = buildLoomTree('root')!
  tree.enteredAt = -10000               // emergence complete
  loomState.currentAperture = aperture(960)

  // Warm up to establish node layout positions.
  const warm = createCanvasContext()
  renderLoomTree(warm, 960, 640, 20000, tree, 1)

  const root = tree.nodes.get('root')!
  loomState.currentMouse = {
    x: root.renderX + mouseDist, y: root.renderY,
    prevX: root.renderX + mouseDist, prevY: root.renderY,
    speed: 0, moving: false, lastMove: 0, down: false, downStart: 0, touch: false,
  }
  loomState.frameRatio = 100            // converge proximity in a few frames
  renderLoomTree(warm, 960, 640, 20016, tree, 1)
  renderLoomTree(warm, 960, 640, 20032, tree, 1)

  const ctx = createCanvasContext()
  renderLoomTree(ctx, 960, 640, 20048, tree, 1)
  loomState.frameRatio = 1
  return ctx
}

test('loom view: signature is not drawn at rest', async () => {
  installViewport(960, 640)
  await loadState(TWO_VOICE('claude-sonnet-5'))
  const tree = buildLoomTree('root')!
  tree.enteredAt = -10000
  loomState.currentAperture = aperture(960)

  const ctx = createCanvasContext()
  renderLoomTree(ctx, 960, 640, 20000, tree, 1)   // no mouse → no dive

  expect(sigCalls(ctx, 'claude-sonnet-5').length).toBe(0)
})

test('loom view: signature is drawn when the radial lens swells the node', async () => {
  const ctx = await loomRootHover('claude-sonnet-5', 0)   // mouse on the node → full dive
  expect(sigCalls(ctx, 'claude-sonnet-5').length).toBeGreaterThan(0)
})

test('loom view: afterglow is gated later than a living signature', async () => {
  // Intermediate dive (proximity ~0.58): past the living gate (0.5), short of the
  // afterglow gate (0.65). The living signature appears; the sunset one waits.
  const living = await loomRootHover('claude-sonnet-5', 25)
  expect(sigCalls(living, 'claude-sonnet-5').length).toBeGreaterThan(0)

  const afterglow = await loomRootHover('claude-3-opus', 25)
  expect(sigCalls(afterglow, 'claude-3-opus').length).toBe(0)

  // And at full dive the afterglow signature does arrive — italic silver.
  const afterglowFull = await loomRootHover('claude-3-opus', 0)
  const calls = sigCalls(afterglowFull, 'claude-3-opus')
  expect(calls.length).toBeGreaterThan(0)
  expect(calls.every(c => c.font.includes('italic'))).toBe(true)
})
