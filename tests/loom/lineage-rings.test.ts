import { afterEach, beforeEach, expect, test } from 'bun:test'
import { buildLoomTree, renderLoomTree } from '../../src/loom/loom-view.js'
import { paper } from '../../src/loom/paper.js'
import {
  CUSP_MAX, RING_CLEAR_FULL, RING_PAST_SECTOR,
  arcSamples, layoutRings, paintLineageRings, pulseLineageRing, ringCusps, ringLayoutFor, ringOpening,
  type RingBox, type RingLayout,
} from '../../src/loom/render/lineage-rings.js'
import { loomState, resetLoomState } from '../../src/loom/state.js'
import { aperture } from '../../src/loom/aperture.js'
import type { LoomNode, LoomTree } from '../../src/loom/types.js'
import { CanvasContextStub, createCanvasContext, installViewport, loadState, makeState, parseRgbaAlpha } from './helpers.js'

beforeEach(() => {
  resetLoomState()
  paper.on = false
})
afterEach(() => {
  paper.on = false
})

// grand → parent → seed → {a → a1, b, c}
const LINEAGE = makeState([
  {
    family: 'memory',
    voices: [
      { id: 'grand', text: 'Before the question there was a room for it. ', weave_count: 1 },
      { id: 'parent', text: 'The room stayed open after the question left. ', weave_from: 'grand', weave_count: 1 },
      { id: 'seed', text: 'I walked in and found the outline still warm. ', weave_from: 'parent', weave_count: 3 },
    ],
  },
  {
    family: 'light',
    voices: [
      { id: 'a', text: 'Warm, because someone kept a lamp on. ', weave_from: 'seed', weave_count: 1 },
      { id: 'a1', text: 'The lamp is still on. ', weave_from: 'a' },
      { id: 'b', text: 'An outline is a promise in a shape. ', weave_from: 'seed' },
      { id: 'c', text: 'I left mine there too. ', weave_from: 'seed' },
    ],
  },
], 501)

// A pure tree for layout tests: no state, no text.
function shapeTree(seed: string, edges: Array<[string, string]>, ancestors: string[] = []): LoomTree {
  const nodes = new Map<string, LoomNode>()
  const mk = (id: string, depth: number) => ({ voiceId: id, generationDepth: depth, parentId: null, childIds: [] } as unknown as LoomNode)
  nodes.set(seed, mk(seed, 0))
  let below = seed
  ancestors.forEach((id, i) => {
    const n = mk(id, -(i + 1))
    n.childIds.push(below)
    nodes.get(below)!.parentId = id
    nodes.set(id, n)
    below = id
  })
  for (const [from, to] of edges) {
    const p = nodes.get(from)!
    const n = mk(to, p.generationDepth + 1)
    n.parentId = from
    p.childIds.push(to)
    nodes.set(to, n)
  }
  return { seed, nodes, maxDepthUp: -ancestors.length, maxDepthDown: 0, enteredAt: 0 }
}

function boxesFor(tree: LoomTree, w: number, h: number): Map<string, RingBox> {
  return new Map([...tree.nodes.keys()].map(id => [id, { w, h }]))
}

function onItsRing(layout: RingLayout, id: string): number {
  const p = layout.places.get(id)!
  const r = layout.radii[p.ring]!
  return Math.hypot((p.x - layout.cx) / (r * layout.ax), (p.y - layout.cy) / (r * layout.ay))
}

const WIDE = shapeTree('s', [['s', 'k1'], ['s', 'k2'], ['s', 'k3'], ['s', 'k4'], ['s', 'k5'], ['s', 'k6'], ['s', 'k7'], ['s', 'k8'], ['s', 'k9'], ['k1', 'g1'], ['k5', 'g2'], ['g2', 'gg']], ['p1'])

test('layout: each voice sits on its own ring, rings grow outward, nothing touches', () => {
  for (const [vw, vh] of [[1440, 900], [390, 844]] as const) {
    const layout = layoutRings(WIDE, boxesFor(WIDE, vw > 600 ? 160 : 117, 40), vw, vh)
    for (let k = 1; k < layout.radii.length; k++) expect(layout.radii[k]!).toBeGreaterThan(layout.radii[k - 1]!)
    for (const [id, p] of layout.places) {
      if (p.ring === 0) {
        expect(p.x).toBeCloseTo(layout.cx, 6)
        expect(p.y).toBeCloseTo(layout.cy, 6)
      } else {
        expect(onItsRing(layout, id)).toBeCloseTo(1, 6)
      }
    }
    const all = [...layout.places.values()]
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        const a = all[i]!, b = all[j]!
        const apart = Math.abs(a.x - b.x) * 2 >= a.w + b.w || Math.abs(a.y - b.y) * 2 >= a.h + b.h
        expect(apart).toBe(true)
      }
    }
  }
})

test('layout: ancestors stack straight up from the seed; descendants stay inside their parent\'s arc', () => {
  const tree = shapeTree('s', [['s', 'a'], ['s', 'b'], ['a', 'a1'], ['a', 'a2'], ['b', 'b1']], ['p1', 'p2'])
  const layout = layoutRings(tree, boxesFor(tree, 160, 36), 1440, 900)
  const p1 = layout.places.get('p1')!
  const p2 = layout.places.get('p2')!
  expect(p1.side).toBe(-1)
  expect(p1.x).toBeCloseTo(layout.cx, 6)
  expect(p1.y).toBeLessThan(layout.cy)
  expect(p2.y).toBeLessThan(p1.y)
  for (const id of ['a1', 'a2']) {
    const c = layout.places.get(id)!
    const a = layout.places.get('a')!
    expect(c.side).toBe(1)
    expect(c.angle).toBeGreaterThanOrEqual(a.a0)
    expect(c.angle).toBeLessThanOrEqual(a.a1)
  }
  // The top of every ring is the past: no descendant is placed in it.
  for (const p of layout.places.values()) {
    if (p.side !== 1) continue
    expect(p.a0).toBeGreaterThanOrEqual(-Math.PI / 2 + RING_PAST_SECTOR / 2 - 1e-9)
    expect(p.a1).toBeLessThanOrEqual(-Math.PI / 2 + 2 * Math.PI - RING_PAST_SECTOR / 2 + 1e-9)
  }
  // An ancestor's ring is whole where no descendant shares it (ring 2 has only p2's... and a1, a2, b1).
  const ring2 = [...layout.places.values()].filter(p => p.ring === 2 && p.side === 1)
  expect(p2.a1).toBeCloseTo(Math.min(...ring2.map(p => p.a0)), 9)
})

test('layout: a wide lineage fits a phone\'s width', () => {
  const layout = layoutRings(WIDE, boxesFor(WIDE, 117, 43), 390, 844)
  let minX = Infinity, maxX = -Infinity
  for (const p of layout.places.values()) { minX = Math.min(minX, p.x - p.w / 2); maxX = Math.max(maxX, p.x + p.w / 2) }
  expect(minX).toBeGreaterThanOrEqual(0)
  expect(maxX).toBeLessThanOrEqual(390)
})

test('cusps: rings are drawn outward toward descendants, inward from ancestors, never longer than CUSP_MAX', () => {
  const tree = shapeTree('s', [['s', 'a'], ['a', 'a1']], ['p1'])
  const layout = layoutRings(tree, boxesFor(tree, 160, 36), 1440, 900)
  const fromA = ringCusps(tree, layout, 'a')
  expect(fromA).toHaveLength(1)
  expect(fromA[0]!.pull).toBeGreaterThan(0)
  expect(fromA[0]!.angle).toBeCloseTo(layout.places.get('a1')!.angle, 9)
  const fromP1 = ringCusps(tree, layout, 'p1')
  expect(fromP1[0]!.pull).toBeLessThan(0)
  for (const id of tree.nodes.keys()) for (const c of ringCusps(tree, layout, id)) expect(Math.abs(c.pull)).toBeLessThanOrEqual(CUSP_MAX)
  // The tip itself is always sampled, so the point is drawn sharp.
  const a = layout.places.get('a')!
  expect(arcSamples(a.a0, a.a1, layout.radii[1]!, fromA, 5)).toContain(fromA[0]!.angle)
})

// Records every call and property write; enough of a 2D context for the painter.
function recorder() {
  const calls: Array<{ op: string, args: unknown[], comp: string }> = []
  const state: Record<string, unknown> = { globalCompositeOperation: 'source-over' }
  const ctx = new Proxy(state, {
    get(target, key: string) {
      if (key in target) return target[key]
      return (...args: unknown[]) => {
        calls.push({ op: key, args, comp: String(target.globalCompositeOperation) })
        if (key === 'createRadialGradient' || key === 'createLinearGradient') return { addColorStop() {} }
        return undefined
      }
    },
    set(target, key: string, value) {
      target[key] = value
      calls.push({ op: 'set:' + key, args: [value], comp: String(target.globalCompositeOperation) })
      return true
    },
  })
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls }
}

async function openLineage(): Promise<LoomTree> {
  installViewport(1440, 900)
  await loadState(LINEAGE)
  const tree = buildLoomTree('seed')!
  tree.enteredAt = -10000
  loomState.currentAperture = aperture(1440)
  loomState.loomTree = tree
  loomState.loomViewActive = true
  loomState.loomViewTransition = 1
  return tree
}

test('paper off: the painter draws nothing and the tree keeps its old layout and filaments', async () => {
  const tree = await openLineage()
  const text = createCanvasContext()
  renderLoomTree(text, 1440, 900, 20000, tree, 1)
  expect(ringLayoutFor(tree)).toBeNull()
  expect((text as unknown as CanvasContextStub).strokeCalls.length).toBeGreaterThan(0) // connector wisps
  const { ctx, calls } = recorder()
  paintLineageRings(ctx, 0.6, 20000)
  expect(calls).toHaveLength(0)
  expect(pulseLineageRing(tree.nodes.get('seed')!.renderX, tree.nodes.get('seed')!.renderY, 1, 20000)).toBe(false)
})

test('paper on: no filaments on the text canvas; every opening in the ink is exactly a hit target', async () => {
  const tree = await openLineage()
  paper.on = true
  const text = createCanvasContext()
  renderLoomTree(text, 1440, 900, 20000, tree, 1)
  const layout = ringLayoutFor(tree)!
  expect(layout).not.toBeNull()
  expect((text as unknown as CanvasContextStub).strokeCalls).toHaveLength(0)

  // Each voice's hit target is centred where its text sits on its ring.
  expect(loomState.lastFrameHitTargets).toHaveLength(tree.nodes.size)
  for (const [id, hx, hy, hw, hh] of loomState.lastFrameHitTargets) {
    const node = tree.nodes.get(id)!
    const p = layout.places.get(id)!
    expect(Math.abs(hy - (p.y + node.renderY - node.treeY))).toBeLessThan(1)
    expect(Math.abs(hx - (p.x + node.renderX - node.treeX))).toBeLessThan(10)
    expect(hw).toBeGreaterThanOrEqual(20)
    expect(hh).toBeGreaterThanOrEqual(15)
  }

  const { ctx, calls } = recorder()
  paintLineageRings(ctx, 0.6, 20000)
  // Rings are drawn (multiplied), then the openings are cut (destination-out).
  expect(calls.some(c => c.op === 'stroke' && c.comp === 'multiply')).toBe(true)
  const openings = calls.filter(c => c.op === 'translate' && c.comp === 'destination-out').map(c => c.args as number[])
  const scales = calls.filter(c => c.op === 'scale' && c.comp === 'destination-out').map(c => c.args as number[])
  const rects = calls.filter(c => c.op === 'fillRect' && c.comp === 'destination-out').map(c => c.args as number[])
  const targets = loomState.lastFrameHitTargets.filter(t => t[0] !== 'seed')
  expect(openings).toHaveLength(targets.length)
  targets.forEach((t, i) => {
    const [, hx, hy, hw, hh] = t
    const { rx, ry } = ringOpening(hw, hh)
    expect(openings[i]).toEqual([hx, hy])
    expect(scales[i]![1]).toBeCloseTo(ry / rx, 9)
    expect(rects[i]).toEqual([-rx, -rx, rx * 2, rx * 2])
    // Fully clear over the whole width and height of the hit target.
    expect(hw / rx).toBeLessThan(RING_CLEAR_FULL)
    expect(hh / ry).toBeLessThan(RING_CLEAR_FULL)
  })
  expect(calls.at(-1)).toEqual({ op: 'set:globalCompositeOperation', args: ['source-over'], comp: 'source-over' })
})

test('paper on: a drop on a lineage voice is taken by its ring', async () => {
  const tree = await openLineage()
  paper.on = true
  renderLoomTree(createCanvasContext(), 1440, 900, 20000, tree, 1)
  const a = tree.nodes.get('a')!
  expect(pulseLineageRing(a.renderX, a.renderY, 1, 20000)).toBe(true)
  expect(pulseLineageRing(-500, -500, 1, 20000)).toBe(false)
})

test('paper on: lineage text gets the same alphaGain as ocean text', async () => {
  const alphaOf = async (on: boolean) => {
    resetLoomState()
    const tree = await openLineage()
    paper.on = on
    const ctx = createCanvasContext()
    renderLoomTree(ctx, 1440, 900, 20000, tree, 0.5) // half transition keeps every alpha below the clamp
    const calls = (ctx as unknown as CanvasContextStub).fillTextCalls
    return Math.max(...calls.map(c => parseRgbaAlpha(c.fillStyle)))
  }
  const off = await alphaOf(false)
  const on = await alphaOf(true)
  expect(off).toBeGreaterThan(0)
  expect(on / off).toBeCloseTo(paper.alphaGain, 2)
})

test('the rings use the blend they are given (a dark sheet passes screen)', async () => {
  const tree = await openLineage()
  paper.on = true
  renderLoomTree(createCanvasContext(), 1440, 900, 20000, tree, 1)
  for (const blend of ['multiply', 'screen'] as const) {
    const { ctx, calls } = recorder()
    paintLineageRings(ctx, 0.6, 20000, blend)
    expect(calls.some(c => c.op === 'stroke' && c.comp === blend)).toBe(true)
    expect(calls.filter(c => c.op === 'stroke').every(c => c.comp === blend)).toBe(true)
  }
})
