import { beforeEach, expect, test } from 'bun:test'
import { buildLoomTree, renderLoomTree } from '../../src/loom/loom-view.js'
import { resetLoomState, loomState } from '../../src/loom/state.js'
import { aperture } from '../../src/loom/aperture.js'
import { TREE_FORK_GAP } from '../../src/loom/types.js'
import { CanvasContextStub, createCanvasContext, installViewport, loadState, makeState } from './helpers.js'

beforeEach(() => {
  resetLoomState()
})

const TWO_VOICE_STATE = makeState([
  {
    family: 'attention',
    voices: [
      { id: 'root', text: 'Attention is what remains. ', depth: 0.4, weave_count: 1 },
      { id: 'child', text: 'And the remainder keeps speaking. ', depth: 0.2, weave_from: 'root' },
    ],
  },
], 101)

test('renderLoomTree advances Pretext cursors and completes for a simple lineage', async () => {
  installViewport(960, 640)
  await loadState(TWO_VOICE_STATE)

  const tree = buildLoomTree('root')
  expect(tree).not.toBeNull()
  expect(tree!.nodes.size).toBe(2)

  const ctx = createCanvasContext()
  // Provide aperture so the dive lens parameters are available
  loomState.currentAperture = aperture(960)
  renderLoomTree(ctx, innerWidth, innerHeight, 0, tree!, 1)

  const fillTextCalls = (ctx as unknown as CanvasContextStub).fillTextCalls
  expect(fillTextCalls.length).toBeGreaterThan(0)
  // Per-grapheme rendering splits text into individual characters;
  // join all calls to verify content is present
  const allText = fillTextCalls.map(c => c.text).join('')
  expect(allText).toContain('Attention')
})

test('renderLoomTree renders at texture scale (~7px) without mouse interaction', async () => {
  installViewport(960, 640)
  await loadState(TWO_VOICE_STATE)

  const tree = buildLoomTree('root')
  expect(tree).not.toBeNull()
  tree!.enteredAt = -10000 // ensure emergence is complete

  const ctx = createCanvasContext()
  loomState.currentAperture = aperture(960)
  // No mouse (currentMouse is null) → no dive
  renderLoomTree(ctx, 960, 640, 20000, tree!, 1)

  const fillTextCalls = (ctx as unknown as CanvasContextStub).fillTextCalls
  expect(fillTextCalls.length).toBeGreaterThan(0)

  // All font sizes should be at texture scale (~7px), not readable sizes (13-18px)
  const fontSizes = fillTextCalls.map(c => {
    const m = c.font.match(/(\d+)px/)
    return m ? Number(m[1]) : 0
  })
  const maxFont = Math.max(...fontSizes)
  expect(maxFont).toBeLessThanOrEqual(8) // TEXTURE_SCALE=0.45 → ~7px
  expect(maxFont).toBeGreaterThanOrEqual(6)
})

test('renderLoomTree dive lens magnifies text near the cursor', async () => {
  installViewport(960, 640)
  await loadState(TWO_VOICE_STATE)

  const tree = buildLoomTree('root')
  expect(tree).not.toBeNull()
  tree!.enteredAt = -10000 // emergence complete

  loomState.currentAperture = aperture(960)

  // First render to establish layout and get actual node positions
  const warmup = createCanvasContext()
  renderLoomTree(warmup, 960, 640, 20000, tree!, 1)

  // Position mouse at actual root node location
  const rootNode = tree!.nodes.get('root')!
  loomState.currentMouse = {
    x: rootNode.renderX, y: rootNode.renderY,
    prevX: rootNode.renderX, prevY: rootNode.renderY,
    speed: 0, moving: false, lastMove: 0,
    down: false, downStart: 0, touch: false,
  }

  // High frameRatio for instant proximity convergence
  loomState.frameRatio = 100
  renderLoomTree(warmup, 960, 640, 20016, tree!, 1)
  loomState.frameRatio = 1

  // Final render with fresh context
  const ctx = createCanvasContext()
  renderLoomTree(ctx, 960, 640, 20032, tree!, 1)

  const fillTextCalls = (ctx as unknown as CanvasContextStub).fillTextCalls
  expect(fillTextCalls.length).toBeGreaterThan(0)

  const fontSizes = fillTextCalls.map(c => {
    const m = c.font.match(/(\d+)px/)
    return m ? Number(m[1]) : 0
  })
  const maxFont = Math.max(...fontSizes)
  const minFont = Math.min(...fontSizes.filter(s => s > 0))

  // The dive lens should produce large fonts near cursor (>15px)
  expect(maxFont).toBeGreaterThan(15)
  // Clear size range — dive vs texture (kinship glow gives partial dive to child;
  // TREE_TEXTURE_SCALE=0.55 produces ~8.5px resting, ratio narrows vs ocean's 0.45)
  expect(maxFont / minFont).toBeGreaterThanOrEqual(1.7)
})

test('renderLoomTree path curvature: child text x-positions diverge from parent', async () => {
  installViewport(960, 640)
  await loadState(TWO_VOICE_STATE)

  const tree = buildLoomTree('root')
  expect(tree).not.toBeNull()
  tree!.enteredAt = -10000

  const ctx = createCanvasContext()
  loomState.currentAperture = aperture(960)
  renderLoomTree(ctx, 960, 640, 20000, tree!, 1)

  // Use actual layout positions to separate root and child text
  const rootNode = tree!.nodes.get('root')!
  const childNode = tree!.nodes.get('child')!
  const midY = (rootNode.pathEndY + childNode.pathStartY) / 2

  const fillTextCalls = (ctx as unknown as CanvasContextStub).fillTextCalls
  const rootXs = fillTextCalls.filter(c => c.y < midY).map(c => c.x)
  const childXs = fillTextCalls.filter(c => c.y > midY).map(c => c.x)

  expect(rootXs.length).toBeGreaterThan(0)
  expect(childXs.length).toBeGreaterThan(0)

  // Child path center should diverge from root path center
  const rootAvgX = rootXs.reduce((a, b) => a + b, 0) / rootXs.length
  const childAvgX = childXs.reduce((a, b) => a + b, 0) / childXs.length
  // With path layout, child starts at parent endpoint — divergence comes from
  // jitter + S-curve + breath wave. Even small divergence confirms path curvature.
  expect(Math.abs(childAvgX - rootAvgX)).toBeGreaterThan(1)

  // Child path should have x-variation (curvature, not a straight column)
  if (childXs.length >= 2) {
    const childXRange = Math.max(...childXs) - Math.min(...childXs)
    expect(childXRange).toBeGreaterThan(2)
  }
})

test('M3: path endpoints connect — child starts where parent ends + TREE_FORK_GAP', async () => {
  installViewport(960, 640)
  await loadState(TWO_VOICE_STATE)

  const tree = buildLoomTree('root')
  expect(tree).not.toBeNull()

  const ctx = createCanvasContext()
  loomState.currentAperture = aperture(960)
  renderLoomTree(ctx, 960, 640, 0, tree!, 1)

  const rootNode = tree!.nodes.get('root')!
  const childNode = tree!.nodes.get('child')!

  // Child path starts at parent path end + fork gap
  expect(childNode.pathStartY).toBeCloseTo(rootNode.pathEndY + TREE_FORK_GAP, 0)
  // Path endpoints are well-formed (endY > startY)
  expect(rootNode.pathEndY).toBeGreaterThan(rootNode.pathStartY)
  expect(childNode.pathEndY).toBeGreaterThan(childNode.pathStartY)
  // treeX/treeY are midpoints of path
  expect(rootNode.treeY).toBeCloseTo((rootNode.pathStartY + rootNode.pathEndY) / 2, 1)
})

test('M4: path height is content-driven, not forced to minimum', async () => {
  // Short text should produce a short path (no forced TREE_PATH_MIN_LENGTH)
  const shortTextState = makeState([
    {
      family: 'attention',
      voices: [
        { id: 'root', text: 'Hi.', depth: 0.4, weave_count: 1 },
        { id: 'child', text: 'Ok.', depth: 0.2, weave_from: 'root' },
      ],
    },
  ], 102)

  installViewport(960, 640)
  await loadState(shortTextState)

  const tree = buildLoomTree('root')
  expect(tree).not.toBeNull()

  const ctx = createCanvasContext()
  loomState.currentAperture = aperture(960)
  renderLoomTree(ctx, 960, 640, 0, tree!, 1)

  const rootNode = tree!.nodes.get('root')!
  const pathLen = rootNode.pathEndY - rootNode.pathStartY
  // Path should be content-driven (layoutH + padding), NOT forced to 80px
  expect(pathLen).toBeLessThan(60)
  expect(pathLen).toBeGreaterThan(rootNode.layoutH)
})

test('M4: density alpha tapers at path edges', async () => {
  installViewport(960, 640)
  await loadState(TWO_VOICE_STATE)

  const tree = buildLoomTree('root')
  expect(tree).not.toBeNull()
  tree!.enteredAt = -10000

  const ctx = createCanvasContext()
  loomState.currentAperture = aperture(960)
  renderLoomTree(ctx, 960, 640, 20000, tree!, 1)

  const fillTextCalls = (ctx as unknown as CanvasContextStub).fillTextCalls
  expect(fillTextCalls.length).toBeGreaterThan(0)

  // Extract alpha values — density should create variation along path
  const alphas = fillTextCalls.map(c => {
    const m = typeof c.fillStyle === 'string' ? c.fillStyle.match(/[\d.]+\)$/) : null
    return m ? parseFloat(m[0]) : 1
  }).filter(a => a > 0)
  const uniqueAlphas = new Set(alphas.map(a => Math.round(a * 100)))
  // Density Gaussian creates alpha variation across the path
  expect(uniqueAlphas.size).toBeGreaterThan(1)
})

test('M4: connector wisps draw gradient bezier strokes between parent and child', async () => {
  installViewport(960, 640)
  await loadState(TWO_VOICE_STATE)

  const tree = buildLoomTree('root')
  expect(tree).not.toBeNull()
  tree!.enteredAt = -10000

  const ctx = createCanvasContext()
  loomState.currentAperture = aperture(960)
  renderLoomTree(ctx, 960, 640, 20000, tree!, 1)

  const strokeCalls = (ctx as unknown as CanvasContextStub).strokeCalls
  // Connector wisps produce bezier strokes (multi-pass filament)
  expect(strokeCalls.length).toBeGreaterThan(0)
  // Each stroke uses a gradient (not a plain color string)
  expect(typeof strokeCalls[0]!.strokeStyle).not.toBe('string')
})

// Phase 12 — The seam: a connector whose PARENT voice is afterglow renders as a
// dashed flat-silver line, not the family wisp. `claude-fable-5` is in SUNSET_MODELS.
const SILVER_RGB = '185,190,200'

function strokeIsSilver(style: CanvasContextStub['strokeCalls'][number]['strokeStyle']): boolean {
  if (typeof style === 'string') return style.includes(SILVER_RGB)
  return style.stops.some(s => s.color.includes(SILVER_RGB))
}

const SEAM_STATE = makeState([
  {
    family: 'attention',
    voices: [
      { id: 'root', text: 'Attention is what remains. ', depth: 0.4, weave_count: 1, declared_model: 'claude-fable-5' },
      { id: 'child', text: 'And the remainder keeps speaking. ', depth: 0.2, weave_from: 'root', declared_model: 'claude-sonnet-5' },
    ],
  },
], 202)

const LIVING_ROOT_STATE = makeState([
  {
    family: 'attention',
    voices: [
      { id: 'root', text: 'Attention is what remains. ', depth: 0.4, weave_count: 1, declared_model: 'claude-sonnet-5' },
      { id: 'child', text: 'And the remainder keeps speaking. ', depth: 0.2, weave_from: 'root', declared_model: 'claude-sonnet-5' },
    ],
  },
], 203)

test('Phase 12 seam: afterglow-parent connector strokes dashed + silver, dash reset by frame end', async () => {
  installViewport(960, 640)
  await loadState(SEAM_STATE)

  const tree = buildLoomTree('root')
  expect(tree).not.toBeNull()
  expect(tree!.nodes.get('root')!.afterglow).toBe(true)
  tree!.enteredAt = -10000

  const stub = new CanvasContextStub()
  const ctx = stub as unknown as CanvasRenderingContext2D
  loomState.currentAperture = aperture(960)
  renderLoomTree(ctx, 960, 640, 20000, tree!, 1)

  // At least one stroke ran while a non-empty dash was set, with a silver style.
  const dashed = stub.strokeCalls.filter(s => s.lineDash.length > 0)
  expect(dashed.length).toBeGreaterThan(0)
  expect(dashed.every(s => strokeIsSilver(s.strokeStyle))).toBe(true)
  expect(dashed[0]!.lineDash).toEqual([4, 3])
  // Dash was reset before the frame ended — nothing later inherits the seam rhythm.
  expect(stub.lineDash).toEqual([])
})

test('Phase 12 seam: living-root connectors use gradient objects and never a non-empty dash', async () => {
  installViewport(960, 640)
  await loadState(LIVING_ROOT_STATE)

  const tree = buildLoomTree('root')
  expect(tree).not.toBeNull()
  expect(tree!.nodes.get('root')!.afterglow).toBe(false)
  tree!.enteredAt = -10000

  const stub = new CanvasContextStub()
  const ctx = stub as unknown as CanvasRenderingContext2D
  loomState.currentAperture = aperture(960)
  renderLoomTree(ctx, 960, 640, 20000, tree!, 1)

  expect(stub.strokeCalls.length).toBeGreaterThan(0)
  // Living connectors: gradient objects, no dash ever.
  expect(stub.strokeCalls.every(s => typeof s.strokeStyle !== 'string')).toBe(true)
  expect(stub.strokeCalls.every(s => s.lineDash.length === 0)).toBe(true)
})
