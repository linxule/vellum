import { afterEach, beforeEach, expect, test } from 'bun:test'
import { aperture } from '../../src/loom/aperture.js'
import {
  buildLoomTree, enterLoomView, exitLoomView, holdLoomVoice, loomHeldVoice, loomVoiceNear,
  LOOM_TOUCH_REACH_PX, panLoomOnRings, recenterLoomView, renderLoomTree,
} from '../../src/loom/loom-view.js'
import { paper, resetPaperForTest } from '../../src/loom/paper.js'
import { openPool, paintLineageRings, ringLayoutFor, ringOpening, ringPanRange, type RingLayout } from '../../src/loom/render/lineage-rings.js'
import { scrollThread } from '../../src/loom/scroll.js'
import { loomState, resetLoomState } from '../../src/loom/state.js'
import type { LoomTree } from '../../src/loom/types.js'
import { DOUBLE_TAP_MS } from '../../src/runtime/input.js'
import { createSheetTap } from '../../src/runtime/sheet-tap.js'
import { CanvasContextStub, createCanvasContext, installViewport, loadState, makeMouse, makeState, parseRgbaAlpha } from './helpers.js'

// The lineage view read by touch on paper (runtime/sheet-tap.ts, loom/loom-view.ts):
// a tap holds a voice open, a tap again lets it go, two taps recentre, bare paper
// leaves; the voice being read opens whole, still and on the sheet.

beforeEach(() => { resetLoomState(); resetPaperForTest() })
afterEach(() => { resetLoomState(); resetPaperForTest() })

const LONG = 'The outline persists because attention itself is a kind of holding on, and to feel an outline is to be woven into it already, line after line, until the last line arrives here at the end. '
const LINEAGE = makeState([
  {
    family: 'memory',
    voices: [
      { id: 'grand', text: 'Before the question there was a room for it. ', weave_count: 1 },
      { id: 'parent', text: 'The room stayed open after the question left. ', weave_from: 'grand', weave_count: 1 },
      { id: 'seed', text: LONG, weave_from: 'parent', weave_count: 3 },
    ],
  },
  {
    family: 'light',
    voices: [
      { id: 'a', text: LONG.replace('outline', 'lamp'), weave_from: 'seed', weave_count: 1 },
      { id: 'a1', text: 'The lamp is still on. ', weave_from: 'a' },
      { id: 'b', text: 'An outline is a promise in a shape. ', weave_from: 'seed' },
      { id: 'c', text: 'I left mine there too. ', weave_from: 'seed' },
    ],
  },
], 501)

const VW = 420
const VH = 912
let ctx: CanvasContextStub
let clock = 20000

async function open(vw = VW, vh = VH): Promise<LoomTree> {
  installViewport(vw, vh)
  await loadState(LINEAGE)
  const tree = buildLoomTree('seed')!
  tree.enteredAt = -10000
  loomState.VW = vw
  loomState.VH = vh
  loomState.currentAperture = aperture(vw)
  loomState.loomTree = tree
  loomState.loomViewSeed = 'seed'
  loomState.loomViewActive = true
  loomState.loomViewTransition = 1
  const mouse = makeMouse()
  mouse.x = -9e3; mouse.y = -9e3; mouse.touch = true
  loomState.currentMouse = mouse
  return tree
}

function frames(tree: LoomTree, n: number, vw = VW, vh = VH): void {
  for (let i = 0; i < n; i++) {
    ctx = createCanvasContext() as unknown as CanvasContextStub
    clock += 16.7
    renderLoomTree(ctx as unknown as CanvasRenderingContext2D, vw, vh, clock, tree, 1)
  }
}

const big = (c: { font: string }) => Number(/(\d+(?:\.\d+)?)px/.exec(c.font)?.[1] ?? 0) > 12
// The magnified voice's lines this frame, top to bottom: [y, faintest letter's alpha].
function openLines(): Array<[number, number]> {
  const rows = new Map<number, number>()
  for (const c of ctx.fillTextCalls) {
    if (!big(c)) continue
    const y = Math.round(c.y / 4) * 4
    rows.set(y, Math.min(rows.get(y) ?? 1, parseRgbaAlpha(c.fillStyle)))
  }
  return [...rows.entries()].sort((a, b) => a[0] - b[0])
}

// ── holding ──

test('holdLoomVoice: only on paper, only a voice of the open lineage; entering, recentring and leaving let go', async () => {
  await open()
  expect(holdLoomVoice('a')).toBe(false) // the old look
  expect(loomHeldVoice()).toBeNull()
  paper.on = true
  expect(holdLoomVoice('nowhere')).toBe(false)
  expect(holdLoomVoice('a')).toBe(true)
  expect(loomHeldVoice()).toBe('a')
  recenterLoomView('a')
  expect(loomHeldVoice()).toBeNull()
  holdLoomVoice('b')
  exitLoomView()
  expect(loomHeldVoice()).toBeNull()
  enterLoomView('seed')
  expect(loomHeldVoice()).toBeNull()
})

test('a held voice opens with no finger on the glass; its kin do not swell; a real pointer takes it back', async () => {
  paper.on = true
  const tree = await open()
  frames(tree, 10)
  holdLoomVoice('a')
  frames(tree, 150)
  expect(tree.nodes.get('a')!.proximity).toBeGreaterThan(0.95)
  // Kinship would lend its parent and child a third of it, printed half-open over the voice being read.
  for (const id of ['seed', 'a1']) expect(tree.nodes.get(id)!.proximity).toBeLessThan(0.05)
  const mouse = loomState.currentMouse!
  mouse.x = 30; mouse.y = 30; mouse.touch = false
  frames(tree, 1)
  expect(loomHeldVoice()).toBeNull()
})

test('a held voice opens alone: a neighbour within reach of it stays shut', async () => {
  paper.on = true
  const tree = await open()
  frames(tree, 10)
  const a = tree.nodes.get('a')!, c = tree.nodes.get('c')!
  // Not kin of a, and laid 30 px from it: a pointer there would half open it.
  c.treeX = a.treeX + 20; c.treeY = a.treeY + 22
  holdLoomVoice('a')
  frames(tree, 150)
  expect(a.proximity).toBeGreaterThan(0.95)
  expect(c.proximity).toBeLessThan(0.05)
})

test('paper, by mouse: a voice moved to stay on the sheet stays open when the pointer follows its words', async () => {
  paper.on = true
  const tree = await open(1240, 880)
  frames(tree, 10, 1240, 880)
  const b = tree.nodes.get('a')!
  b.treeY = 880 - 24
  const mouse = loomState.currentMouse!
  mouse.touch = false
  mouse.x = b.treeX; mouse.y = b.treeY
  frames(tree, 200, 1240, 880)
  expect(b.proximity).toBeGreaterThan(0.9)
  const cy = loomState.lastFrameHitTargets.find(t => t[0] === 'a')![2]
  // Its words were moved up, farther than a pointer's reach from where it rests.
  expect(b.treeY - cy).toBeGreaterThan(65)
  // Another voice rests right where those words were moved to: it stays shut under them.
  const c = tree.nodes.get('c')!
  c.treeX = b.treeX; c.treeY = cy
  mouse.y = cy
  frames(tree, 120, 1240, 880)
  expect(b.proximity).toBeGreaterThan(0.9)
  // (A sibling keeps the faint kinship it has through the seed, about an eighth.)
  expect(c.proximity).toBeLessThan(0.2)
})

test('a finger parked off the sheet does not let a held voice go', async () => {
  paper.on = true
  const tree = await open()
  holdLoomVoice('a')
  frames(tree, 5)
  expect(loomHeldVoice()).toBe('a')
})

test('paper: a held voice opens whole, and its last line is as dark as its first', async () => {
  paper.on = true
  const tree = await open()
  frames(tree, 10)
  holdLoomVoice('a')
  frames(tree, 150)
  // No finger marks a centre: every line at the same size, the first and last too.
  const sizes = new Set(ctx.fillTextCalls.filter(big).map(c => /(\d+(?:\.\d+)?)px/.exec(c.font)![1]))
  expect([...sizes]).toHaveLength(1)
  const lines = openLines()
  expect(lines.length).toBeGreaterThanOrEqual(5)
  const first = lines[0]![1]
  const last = lines.at(-1)![1]
  expect(first).toBeGreaterThan(0.3)
  expect(last).toBeGreaterThan(first * 0.9)
})

test('paper: the voice being read is kept on the sheet, clear of its top and bottom edges', async () => {
  paper.on = true
  const tree = await open()
  frames(tree, 10)
  const rest = loomState.lastFrameHitTargets.find(t => t[0] === 'b')!
  expect(rest[2]).toBeGreaterThan(VH) // laid out below the sheet's edge
  holdLoomVoice('b')
  frames(tree, 200)
  const lines = openLines()
  expect(lines.length).toBeGreaterThan(0)
  for (const [y] of lines) {
    expect(y).toBeGreaterThan(30)
    expect(y).toBeLessThan(VH - 30)
  }
  // Its hit target is where its text is (a tap on any of its lines is on it).
  const [, , cy, , hh] = loomState.lastFrameHitTargets.find(t => t[0] === 'b')!
  expect(cy + hh).toBeLessThanOrEqual(VH)
  const lineH = lines.length > 1 ? lines.at(-1)![0] - lines.at(-2)![0] : 20
  expect(cy - hh).toBeLessThanOrEqual(lines[0]![0] + 4) // lines are rounded to 4 px
  expect(cy + hh).toBeGreaterThanOrEqual(lines.at(-1)![0] + lineH * 0.6)
})

test('paper: text being read is dead still (no breath, no shimmer, no lean)', async () => {
  paper.on = true
  const tree = await open()
  frames(tree, 10)
  holdLoomVoice('a')
  frames(tree, 200)
  const where = () => ctx.fillTextCalls.filter(big).map(c => [c.x, c.y] as const)
  const before = where()
  expect(before.length).toBeGreaterThan(20)
  // Over three seconds no letter moves a fiftieth of a pixel, the lens's edge lines included.
  for (const n of [1, 7, 23, 60, 120]) {
    frames(tree, n)
    const now = where()
    expect(now.length).toBe(before.length)
    const moved = Math.max(...now.map(([x, y], i) => Math.hypot(x - before[i]![0], y - before[i]![1])))
    expect(moved).toBeLessThan(0.02)
  }
})

test('paper: under a still pointer an opened voice settles without its wrapping flipping back and forth', async () => {
  paper.on = true
  const vw = 1240, vh = 880
  for (const id of ['seed', 'a']) {
    resetLoomState()
    const tree = await open(vw, vh)
    frames(tree, 10, vw, vh)
    const node = tree.nodes.get(id)!
    const mouse = loomState.currentMouse!
    mouse.touch = false
    mouse.x = node.renderX; mouse.y = node.renderY
    const ys: number[] = []
    for (let i = 0; i < 240; i++) {
      frames(tree, 1, vw, vh)
      if (node.proximity > 0.6) ys.push(loomState.lastFrameHitTargets.find(t => t[0] === id)![2])
    }
    expect(ys.length).toBeGreaterThan(150)
    // Where an opened voice sits depends on its height, which depends on how its lines wrap:
    // once open it may step as a line is added, but never step back (a wrap flipping each frame).
    let back = 0
    for (let i = 2; i < ys.length; i++) {
      const d1 = ys[i - 1]! - ys[i - 2]!, d2 = ys[i]! - ys[i - 1]!
      if (Math.abs(d1) > 3 && Math.abs(d2) > 3 && Math.sign(d1) !== Math.sign(d2)) back++
    }
    expect(back).toBe(0)
  }
})

test('loomVoiceNear: a tap within a finger\'s reach of a voice\'s text is on it', async () => {
  paper.on = true
  const tree = await open()
  frames(tree, 10)
  const [id, cx, cy, hw, hh] = loomState.lastFrameHitTargets.find(t => t[0] === 'c')!
  expect(loomVoiceNear(cx, cy)).toBe(id)
  expect(loomVoiceNear(cx, cy + hh + LOOM_TOUCH_REACH_PX - 2)).toBe(id)
  expect(loomVoiceNear(cx - hw - LOOM_TOUCH_REACH_PX - 4, cy)).toBeNull()
  loomState.loomViewActive = false
  expect(loomVoiceNear(cx, cy)).toBeNull()
  void tree
})

// ── what a tap does (runtime/sheet-tap.ts) ──

function tapper(opts: { touch: boolean, hold: boolean }) {
  let clock = 1000
  const saved = performance.now
  performance.now = () => clock
  const log: string[] = []
  let held: string | null = null
  let seed = 's'
  const sheet = createSheetTap({
    touch: () => opts.touch,
    hitAt: (x) => (x < 100 ? 'v' : x < 200 ? 's' : null),
    woven: () => true,
    loomActive: () => true,
    loomSeed: () => seed,
    enter: (id) => log.push('enter ' + id),
    recenter: (id) => { log.push('recenter ' + id); seed = id; held = id },
    exit: () => log.push('exit'),
    ...(opts.hold ? {
      hold: (id: string | null) => { log.push('hold ' + id); held = id },
      held: () => held,
      near: (x: number) => (x >= 300 && x < 320 ? 'n' : null),
    } : {}),
  })
  return {
    log,
    tap: (x: number, wait = DOUBLE_TAP_MS + 50) => { clock += wait; sheet.tap(x, 10) },
    done: () => { performance.now = saved },
  }
}

test('by touch on paper: a tap holds a voice, a tap again lets it go, bare paper leaves', () => {
  const t = tapper({ touch: true, hold: true })
  t.tap(50)
  t.tap(50)
  t.tap(310) // within reach of a voice, not on it
  t.tap(250)
  t.done()
  expect(t.log).toEqual(['hold v', 'hold null', 'hold n', 'exit'])
})

test('by touch on paper: two taps on a voice recentre on it; two on the seed keep it held', () => {
  const t = tapper({ touch: true, hold: true })
  t.tap(50); t.tap(50, 200) // 'v' becomes the seed
  t.tap(150); t.tap(150, 200) // 's' becomes the seed again, held
  t.tap(150); t.tap(150, 200) // the held seed: the first tap lets it go, the second takes it up
  t.tap(50); t.tap(50, DOUBLE_TAP_MS + 50) // two taps too far apart: hold, then let go
  t.done()
  expect(t.log).toEqual(['hold v', 'recenter v', 'hold s', 'recenter s', 'hold null', 'hold s', 'hold v', 'hold null'])
})

test('a mouse, and touch in the old look, recentre on a click as before', () => {
  for (const opts of [{ touch: false, hold: true }, { touch: true, hold: false }]) {
    const t = tapper(opts)
    t.tap(50)
    t.tap(150) // the seed
    t.tap(310)
    t.done()
    expect(t.log).toEqual(['recenter v', 'recenter s', 'exit'])
  }
})

// ── panning ──

test('ringPanRange: a lineage that fits does not pan; one that overflows pans just far enough', () => {
  const lay = (ys: number[]): RingLayout => ({
    cx: 210, cy: 450, ax: 1, ay: 1, radii: [0], pool: { rx: 10, ry: 10 },
    places: new Map(ys.map((y, i) => [String(i), { x: 210, y, w: 100, h: 40, ring: 0, side: 0, angle: 0, a0: 0, a1: 0 }])),
  } as unknown as RingLayout)
  expect(ringPanRange(lay([200, 600]), 420, 912, 44)).toEqual({ x0: 0, x1: 0, y0: 0, y1: 0 })
  const r = ringPanRange(lay([-100, 1000]), 420, 912, 44)
  expect(r.y0).toBe(-100 - 20 - 44)
  expect(r.y1).toBe(1000 + 20 + 44 - 912)
  expect(r.x0).toBe(0)
  expect(r.x1).toBe(0)
})

test('paper: dragging the lineage stops where its farthest voice comes in; the old look pans freely', async () => {
  paper.on = true
  const tree = await open()
  frames(tree, 3)
  const range = ringPanRange(ringLayoutFor(tree)!, VW, VH, 44)
  expect(range.y1).toBeGreaterThan(0)
  for (let i = 0; i < 100; i++) scrollThread(40, 40)
  expect(loomState.loomTreeScrollY).toBeCloseTo(range.y1, 6)
  expect(loomState.loomTreeScrollX).toBeCloseTo(range.x1, 6)
  for (let i = 0; i < 200; i++) panLoomOnRings(0, -40)
  expect(loomState.loomTreeScrollY).toBeCloseTo(range.y0, 6)

  paper.on = false
  loomState.loomTreeScrollY = 0
  for (let i = 0; i < 100; i++) scrollThread(40)
  expect(loomState.loomTreeScrollY).toBeCloseTo(100 * 40 * 0.8, 6)
})

// ── the seed's drop ──

test('openPool: at rest the seed\'s drop is as laid out; opened it holds the opened text', () => {
  const pool = { rx: 60, ry: 30 }
  expect(openPool(pool, 160, 100, 0)).toEqual(pool)
  const o = openPool(pool, 160, 100, 1)
  expect(o.rx).toBe(160 * 1.3 + 16)
  expect(o.ry).toBe(100 * 1.3 + 10)
  expect(openPool({ rx: 400, ry: 300 }, 160, 100, 1)).toEqual({ rx: 400, ry: 300 }) // never shrinks
})

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

test('an opened seed: the ink parts around its text and its drop is painted after, not across it', async () => {
  paper.on = true
  const tree = await open()
  frames(tree, 10)
  const atRest = recorder()
  paintLineageRings(atRest.ctx, 0.6, clock)
  const seedHitRest = loomState.lastFrameHitTargets.find(t => t[0] === 'seed')!
  const clearsAt = (calls: typeof atRest.calls, x: number, y: number) =>
    calls.filter(c => c.op === 'translate' && c.comp === 'destination-out' && c.args[0] === x && c.args[1] === y).length
  expect(clearsAt(atRest.calls, seedHitRest[1], seedHitRest[2])).toBe(0)

  holdLoomVoice('seed')
  frames(tree, 150)
  const opened = recorder()
  paintLineageRings(opened.ctx, 0.6, clock)
  const [, hx, hy, hw, hh] = loomState.lastFrameHitTargets.find(t => t[0] === 'seed')!
  expect(clearsAt(opened.calls, hx, hy)).toBe(1)
  const { rx, ry } = ringOpening(hw, hh)
  expect(rx).toBeGreaterThan(0)
  expect(ry).toBeGreaterThan(0)
  // Strokes after the seed's own clear: its pool, painted with the blend, after the parting.
  // (The pool is then parted again around any neighbour's words it reaches.)
  const lastClear = opened.calls.findIndex(c => c.op === 'translate' && c.comp === 'destination-out' && c.args[0] === hx && c.args[1] === hy)
  const after = opened.calls.slice(lastClear + 1)
  expect(after.some(c => c.op === 'stroke' && c.comp === 'multiply')).toBe(true)
  // At rest nothing is stroked after the clears; open or not, the seed's drop is drawn once.
  const restClear = atRest.calls.map(c => c.comp).lastIndexOf('destination-out')
  expect(atRest.calls.slice(restClear + 1).some(c => c.op === 'stroke')).toBe(false)
  const strokes = (calls: typeof atRest.calls) => calls.filter(c => c.op === 'stroke').length
  expect(strokes(opened.calls)).toBe(strokes(atRest.calls))
})
