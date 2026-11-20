import { afterEach, beforeEach, expect, test } from 'bun:test'
import { aperture } from '../../src/loom/aperture.js'
import {
  buildLoomTree, focusWords, holdLoomVoice, lineageFocus, loomClearsWhole, loomVoiceNear, panLoomOnRings, renderLoomTree,
  resetLineageFocusForTest, wholeOrOff, WORDLESS_BOX,
} from '../../src/loom/loom-view.js'
import { paper, resetPaperForTest } from '../../src/loom/paper.js'
import {
  generationGaps, openPool, paintLineageRings, RING_PAST_SECTOR, ringLayoutFor, wordlessTarget, type RingLayout, type RingPlace,
} from '../../src/loom/render/lineage-rings.js'
import { getLastFrameHitVoiceIdAt, loomState, resetLoomState } from '../../src/loom/state.js'
import { TREE_OPEN_WIDTH, type LoomTree } from '../../src/loom/types.js'
import { CanvasContextStub, createCanvasContext, installViewport, loadState, makeMouse, makeState } from './helpers.js'

// A lineage too large to rest readable whole reads by focus, on paper (loom/loom-view.ts):
// the voice in focus and its parent and children print their words; voices further out
// keep their rings and print none, but can still be taken up by a finger. On trial behind
// ?lineage=focus: every test here turns the flag on, except the one that checks it off.

beforeEach(() => { resetLoomState(); resetPaperForTest(); resetLineageFocusForTest(); lineageFocus.on = true })
afterEach(() => { resetLoomState(); resetPaperForTest(); resetLineageFocusForTest() })

const say = (n: string) => `Voice ${n} carries the thought a little further along the water, word after word, until it rests here. `

// Seventeen voices: an ancestor, the seed, four children, eight grandchildren, three great-grandchildren.
const BIG = makeState([
  {
    family: 'attention',
    voices: [
      { id: 'root', text: say('root'), weave_count: 1 },
      { id: 'seed', text: say('seed'), weave_from: 'root', weave_count: 4 },
      ...['a', 'b', 'c', 'd'].map(k => ({ id: k, text: say(k), weave_from: 'seed', weave_count: 2 })),
    ],
  },
  {
    family: 'memory',
    voices: [
      ...['a', 'b', 'c', 'd'].flatMap(k => [1, 2].map(i => ({ id: k + i, text: say(k + i), weave_from: k, weave_count: k === 'a' && i === 1 ? 3 : 0 }))),
      ...[1, 2, 3].map(i => ({ id: 'a1' + i, text: say('a1' + i), weave_from: 'a1' })),
    ],
  },
], 777)

// Two voices: rests whole, at a readable size, on a phone.
const SMALL = makeState([
  { family: 'light', voices: [{ id: 'seed', text: 'A lamp left on. ', weave_count: 1 }, { id: 'kid', text: 'Still on. ', weave_from: 'seed' }] },
], 778)

const VW = 420
const VH = 912
let ctx: CanvasContextStub
let clock = 30000

async function open(state = BIG, vw = VW, vh = VH): Promise<LoomTree> {
  installViewport(vw, vh)
  await loadState(state)
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

const letters = (s: string) => [...s].filter(c => c.trim()).length
const printed = () => ctx.fillTextCalls.reduce((n, c) => n + letters(c.text), 0)
const lettersOf = (tree: LoomTree, ids: Iterable<string>) => [...ids].reduce((n, id) => n + letters(tree.nodes.get(id)!.text), 0)
const sizes = () => new Set(ctx.fillTextCalls.map(c => Number(/(\d+(?:\.\d+)?)px/.exec(c.font)![1])))

// Seventeen voices on a 390x844 sheet with the flag off, as main (a90b54a) lays them out: the hit
// target of every voice at rest (centre, rounded to 0.1 px), all printed at 8 px.
const MAIN_17_AT_390x844: ReadonlyArray<readonly [string, number, number]> = [
  ['a', 297.3, 378], ['a1', 411.6, 146.1], ['a11', 389.9, -395.1], ['a12', 467.4, 95.3], ['a13', 469.5, 658.2],
  ['a2', 346.5, 1006.2], ['b', 171.8, 835.3], ['b1', 238.1, 1237.2], ['b2', 105.9, 1238.2], ['c', 59.3, 604.3],
  ['c1', -6.9, 1008.3], ['c2', -70.3, 606.5], ['d', 57.2, 147.2], ['d1', -67.6, 145.7], ['d2', -7.7, -252.5],
  ['root', 171.6, -81.8], ['seed', 175.3, 375.8],
]

test('flag off: a large lineage lays out and prints as before focus existed', async () => {
  lineageFocus.on = false
  paper.on = true
  const tree = await open(BIG, 390, 844)
  frames(tree, 120, 390, 844)
  const r = (n: number) => Math.round(n * 10) / 10
  const got = loomState.lastFrameHitTargets.map(t => [t[0], r(t[1]), r(t[2])] as const).sort((a, b) => a[0].localeCompare(b[0]))
  expect(got).toEqual([...MAIN_17_AT_390x844])
  expect([...sizes()]).toEqual([8])
  expect(printed()).toBe(lettersOf(tree, tree.nodes.keys()))
  expect(holdLoomVoice('a11')).toBe(true)
  frames(tree, 30, 390, 844)
  expect(loomState.loomFocusId).toBeNull()
  for (const node of tree.nodes.values()) expect(node.words).toBe(1)
  expect(loomClearsWhole()).toBe(false)
})

test('focusWords: the voice, its parent and its children', async () => {
  const tree = await open()
  expect([...focusWords(tree, 'seed')].sort()).toEqual(['a', 'b', 'c', 'd', 'root', 'seed'])
  expect([...focusWords(tree, 'a1')].sort()).toEqual(['a', 'a1', 'a11', 'a12', 'a13'])
})

test('paper, a large lineage on a phone: far voices print no words, but keep a hit target and their ring whole', async () => {
  paper.on = true
  const tree = await open()
  frames(tree, 120)
  const near = focusWords(tree, 'seed')
  // Exactly the focus's neighbourhood is printed, every letter of it.
  expect(printed()).toBe(lettersOf(tree, near))
  const far = [...tree.nodes.keys()].filter(id => !near.has(id))
  expect(far.length).toBe(11)
  const layout = ringLayoutFor(tree)!
  const offArc: string[] = []
  for (const id of far) {
    expect(tree.nodes.get(id)!.words).toBe(0)
    const t = loomState.lastFrameHitTargets.find(h => h[0] === id)
    if (!t) {
      // No point of its arc is on the sheet clear of words (the seed held open across a phone
      // pushes its kin wide): a pan brings it in.
      const hw = WORDLESS_BOX.w / 2
      const hh = WORDLESS_BOX.h / 2
      const words = loomState.lastFrameHitTargets.filter(h => tree.nodes.get(h[0])!.words > 0.5)
      const blocked = (x: number, y: number) => words.some(h => Math.abs(x - h[1]) < h[3] + hw && Math.abs(y - h[2]) < h[4] + hh)
      expect(wordlessTarget(layout, id, loomState.current * 2 - loomState.loomTreeScrollX, -loomState.loomTreeScrollY, VW, VH, hw + 2, hh + 2, blocked)).toBeNull()
      offArc.push(id)
      continue
    }
    expect(t[3]).toBe(WORDLESS_BOX.w / 2)
    expect(t[4]).toBe(WORDLESS_BOX.h / 2)
    // A tap on where its words would rest is on it.
    expect(getLastFrameHitVoiceIdAt(t[1], t[2])).toBe(id)
  }
  for (const id of offArc) {
    const p = layout.places.get(id)!
    panLoomOnRings(p.x - loomState.loomTreeScrollX - VW / 2, p.y - loomState.loomTreeScrollY - VH / 2)
    frames(tree, 2)
    expect(loomState.lastFrameHitTargets.some(h => h[0] === id)).toBe(true)
  }
  panLoomOnRings(-1e4, -1e4)
  frames(tree, 1)
  // The ink parts only around printed words: a wordless voice's ring stays whole.
  const calls: Array<{ op: string, args: unknown[], comp: string }> = []
  const state: Record<string, unknown> = { globalCompositeOperation: 'source-over' }
  const rec = new Proxy(state, {
    get(target, key: string) {
      if (key in target) return target[key]
      return (...args: unknown[]) => {
        calls.push({ op: key, args, comp: String(target.globalCompositeOperation) })
        return key.startsWith('create') ? { addColorStop() {} } : undefined
      }
    },
    set(target, key: string, value) { target[key] = value; return true },
  })
  paintLineageRings(rec as unknown as CanvasRenderingContext2D, 0.6, clock)
  const opened = new Set(calls.filter(c => c.op === 'translate' && c.comp === 'destination-out').map(c => `${c.args[0]},${c.args[1]}`))
  for (const [id, x, y] of loomState.lastFrameHitTargets) expect(opened.has(`${x},${y}`)).toBe(near.has(id) && id !== 'seed')
})

test('paper, a large lineage on a phone: by focus it rests at a readable size (it rested at 8 px whole)', async () => {
  paper.on = true
  const tree = await open()
  frames(tree, 120)
  const s = [...sizes()]
  expect(s).toHaveLength(1)
  expect(s[0]).toBeGreaterThanOrEqual(11)
})

test('taking up a far voice moves the focus: its kin gain words, the ones left behind lose them, by colour', async () => {
  paper.on = true
  const tree = await open()
  frames(tree, 120)
  expect(tree.nodes.get('a11')!.words).toBe(0)
  expect(holdLoomVoice('a1')).toBe(true)
  frames(tree, 6)
  // Halfway: the leaving voices still print, fainter (toward the paper), the arriving ones are coming.
  const b = tree.nodes.get('b')!.words
  const a11 = tree.nodes.get('a11')!.words
  expect(b).toBeGreaterThan(0.1); expect(b).toBeLessThan(0.9)
  expect(a11).toBeGreaterThan(0.1); expect(a11).toBeLessThan(0.9)
  frames(tree, 150)
  for (const id of ['a', 'a11', 'a12', 'a13']) expect(tree.nodes.get(id)!.words).toBe(1)
  for (const id of ['seed', 'root', 'b', 'c', 'd', 'a2']) expect(tree.nodes.get(id)!.words).toBe(0)
  // Letting go keeps the focus where it was: nothing re-lays under the hand that let go.
  holdLoomVoice(null)
  frames(tree, 150)
  expect(tree.nodes.get('a11')!.words).toBe(1)
  expect(tree.nodes.get('b')!.words).toBe(0)
})

test('a small lineage that rests whole at a readable size is unchanged: every voice prints, no focus', async () => {
  paper.on = true
  const tree = await open(SMALL)
  frames(tree, 120)
  expect(printed()).toBe(lettersOf(tree, tree.nodes.keys()))
  for (const n of tree.nodes.values()) expect(n.words).toBe(1)
  expect([...sizes()]).toEqual([15])
})

test('the old look prints every voice of a large lineage, and never clears its text canvas whole', async () => {
  const tree = await open()
  frames(tree, 120)
  expect(printed()).toBe(lettersOf(tree, tree.nodes.keys()))
  for (const n of tree.nodes.values()) expect(n.words).toBe(1)
  panLoomOnRings(0, 40)
  expect(loomClearsWhole()).toBe(false)
})

test('paper: a pan clears the text canvas whole for a few frames, so the moved print does not trail', async () => {
  paper.on = true
  const tree = await open()
  frames(tree, 120)
  expect(loomClearsWhole()).toBe(false)
  const alphas = () => ctx.fillTextCalls.map(c => Number(/,([\d.]+)\)$/.exec(String(c.fillStyle))![1]))
  frames(tree, 1)
  const kept = alphas()
  const at = [loomState.loomTreeScrollX, loomState.loomTreeScrollY]
  panLoomOnRings(400, 400)
  panLoomOnRings(-800, -800)
  expect([loomState.loomTreeScrollX, loomState.loomTreeScrollY]).not.toEqual(at)
  expect(loomClearsWhole()).toBe(true)
  // Printed once on a cleared canvas, each letter is as strong as the build-up it stands for: a / (0.18 + 0.82 a).
  frames(tree, 1)
  const lifted = alphas()
  expect(lifted.length).toBe(kept.length)
  for (let i = 0; i < kept.length; i++) expect(lifted[i]!).toBeCloseTo(Math.min(1, kept[i]!) / (0.18 + 0.82 * Math.min(1, kept[i]!)), 2)
  expect(loomClearsWhole()).toBe(true)
  expect(loomClearsWhole()).toBe(true)
  expect(loomClearsWhole()).toBe(false)
})

// ── round 2: the shape of a lineage read by focus ──

function recordRings(): Array<{ op: string, args: unknown[], comp: string, lineWidth: unknown, strokeStyle: unknown }> {
  const calls: Array<{ op: string, args: unknown[], comp: string, lineWidth: unknown, strokeStyle: unknown }> = []
  const state: Record<string, unknown> = { globalCompositeOperation: 'source-over' }
  const rec = new Proxy(state, {
    get(target, key: string) {
      if (key in target) return target[key]
      return (...args: unknown[]) => {
        calls.push({ op: key, args, comp: String(target.globalCompositeOperation), lineWidth: target.lineWidth, strokeStyle: target.strokeStyle })
        return key.startsWith('create') ? { addColorStop() {} } : undefined
      }
    },
    set(target, key: string, value) { target[key] = value; return true },
  })
  paintLineageRings(rec as unknown as CanvasRenderingContext2D, 0.6, clock)
  return calls
}

function layoutOf(places: Array<[string, Partial<RingPlace>]>, radii: number[]): RingLayout {
  return {
    cx: 0, cy: 0, ax: 1, ay: 1, radii, pool: { rx: 10, ry: 10 },
    places: new Map(places.map(([id, p]) => [id, { ring: 0, side: 1, angle: 0, a0: 0, a1: 0, x: 0, y: 0, w: 10, h: 10, ...p } as RingPlace])),
  }
}

const UP = -Math.PI / 2
const PAST = RING_PAST_SECTOR / 2

test('generationGaps: a generation\'s ring is closed between its voices, open at the top unless an ancestor shares it', () => {
  const layout = layoutOf([
    ['seed', { ring: 0, side: 0, a0: -Math.PI, a1: Math.PI }],
    ['p', { ring: 1, side: -1 }],
    ['k1', { ring: 1, a0: UP + PAST, a1: UP + PAST + 1 }],
    ['k2', { ring: 1, a0: UP + PAST + 2, a1: UP + 2 * Math.PI - PAST }],
    ['g1', { ring: 2, a0: UP + PAST + 0.5, a1: UP + PAST + 1 }],
  ], [10, 50, 90])
  const gaps = generationGaps(layout)
  // Ring 1 shares the ancestor's ring: only the stretch between its two voices, split between them.
  expect(gaps.get(1)).toEqual([
    { id: 'k1', a0: UP + PAST + 1, a1: UP + PAST + 1.5 },
    { id: 'k2', a0: UP + PAST + 1.5, a1: UP + PAST + 2 },
  ])
  // Ring 2 has no ancestor: closed out to the past's sector on both sides, never across it.
  const g2 = gaps.get(2)!
  expect(g2.map(g => g.id)).toEqual(['g1', 'g1'])
  expect(g2[0]!.a0).toBeCloseTo(UP + PAST)
  expect(g2[0]!.a1).toBeCloseTo(UP + PAST + 0.5)
  expect(g2[1]!.a0).toBeCloseTo(UP + PAST + 1)
  expect(g2[1]!.a1).toBeCloseTo(UP + 2 * Math.PI - PAST)
  expect(gaps.has(0)).toBe(false)
})

test('paper, read by focus: each generation\'s ring is closed faintly; a lineage resting whole draws no such ring', async () => {
  paper.on = true
  const tree = await open()
  frames(tree, 120)
  const faint = recordRings().filter(c => c.op === 'stroke' && c.lineWidth === 1)
  expect(faint.length).toBeGreaterThan(0)
  for (const c of faint) expect(Number(/,([\d.]+)\)$/.exec(String(c.strokeStyle))![1])).toBeLessThanOrEqual(0.3)

  resetLoomState()
  const small = await open(SMALL)
  frames(small, 120)
  expect(recordRings().filter(c => c.op === 'stroke' && c.lineWidth === 1)).toHaveLength(0)
})

test('paper, read by focus: far voices take next to no room, so the rings stay close (the lineage nearly fits a phone)', async () => {
  paper.on = true
  const tree = await open()
  frames(tree, 120)
  const layout = ringLayoutFor(tree)!
  const outer = layout.radii.at(-1)!
  expect(2 * outer * layout.ay).toBeLessThan(VH * 1.15)
  // The rings of wordless voices step out evenly past the words, not past whole text blocks.
  const words = focusWords(tree, 'seed')
  const wordRings = new Set([...words].map(id => layout.places.get(id)!.ring))
  const outerWords = Math.max(...wordRings)
  for (let k = outerWords + 1; k < layout.radii.length; k++) {
    // A ring grows in steps of 1.5% of its radius until its voices clear (render/lineage-rings.ts).
    expect(layout.radii[k]! - layout.radii[k - 1]!).toBeLessThan(40 / Math.max(layout.ax, layout.ay) + layout.radii[k]! * 0.015 + 1)
  }
})

// A sheet too short for the lineage: some far voices sit off it.
const SHORT = 520

test('paper, read by focus: a far voice\'s target is on its own visible arc, on the sheet, clear of anyone\'s words', async () => {
  paper.on = true
  const tree = await open(BIG, VW, SHORT)
  frames(tree, 120, VW, SHORT)
  const layout = ringLayoutFor(tree)!
  const ox = loomState.current * 2 - loomState.loomTreeScrollX
  const oy = -loomState.loomTreeScrollY
  const printedTargets = loomState.lastFrameHitTargets.filter(t => tree.nodes.get(t[0])!.words > 0.5)
  let movedOn = 0
  for (const n of tree.nodes.values()) {
    if (n.words > 0.02) continue
    const t = loomState.lastFrameHitTargets.find(h => h[0] === n.voiceId)
    const p = layout.places.get(n.voiceId)!
    if (!t) continue
    const [, x, y, hw, hh] = t
    expect(x - hw).toBeGreaterThanOrEqual(0); expect(x + hw).toBeLessThanOrEqual(VW)
    expect(y - hh).toBeGreaterThanOrEqual(0); expect(y + hh).toBeLessThanOrEqual(SHORT)
    // On its ring, within its own arc.
    const dx = (x - layout.cx - ox) / layout.ax
    const dy = (y - layout.cy - oy) / layout.ay
    expect(Math.hypot(dx, dy)).toBeCloseTo(layout.radii[p.ring]!, 0)
    if (p.side !== 0) {
      let th = Math.atan2(dy, dx)
      while (th < p.a0 - 1e-6) th += 2 * Math.PI
      expect(th).toBeLessThanOrEqual(p.a1 + 1e-6)
    }
    for (const q of printedTargets) expect(Math.abs(x - q[1]) >= hw + q[3] || Math.abs(y - q[2]) >= hh + q[4]).toBe(true)
    if (p.y + oy > SHORT || p.y + oy < 0 || p.x + ox < 0 || p.x + ox > VW) movedOn++
    // A tap there takes it up.
    expect(loomVoiceNear(x, y)).toBe(n.voiceId)
  }
  expect(movedOn).toBeGreaterThan(0)
})

test('wholeOrOff: a voice printing words cut by the sheet\'s edge is brought wholly on; the focus and voices wholly off are left', () => {
  const layout = layoutOf([
    ['f', { ring: 0, side: 0, x: 200, y: 300, w: 300, h: 100 }],
    ['cut', { ring: 1, x: 400, y: 600, w: 120, h: 60 }],
    ['off', { ring: 1, x: 200, y: 2000, w: 120, h: 60 }],
  ], [10, 50])
  const at = wholeOrOff(layout, new Set(['f', 'cut', 'off']), 'f', 0, 0, 420, 912)
  expect(at.y).toBe(0)
  expect(400 + 60 - at.x).toBeLessThanOrEqual(420) // 'cut' now wholly on
  expect(400 - 60 - at.x).toBeGreaterThanOrEqual(0)
})

test('paper: a pan left at rest with a voice printing words cut by the edge settles so it is wholly on', async () => {
  paper.on = true
  const tree = await open()
  const cut = () => loomState.lastFrameHitTargets.filter(t => {
    const n = tree.nodes.get(t[0])!
    if (n.words < 0.98 || t[0] === tree.seed) return false
    const [x0, x1, y0, y1] = [t[1] - t[3], t[1] + t[3], t[2] - t[4], t[2] + t[4]]
    const inside = x0 >= 0 && x1 <= VW && y0 >= 0 && y1 <= VH
    const outside = x1 <= 0 || x0 >= VW || y1 <= 0 || y0 >= VH
    return !inside && !outside
  }).map(t => t[0])
  // Held: a voice with a parent and three children. (In the test canvas, whose letters are half
  // again as wide as the typeface, the seed held open leaves no place where all its kin are whole
  // or off the sheet; in a browser the lineages tried do.)
  expect(holdLoomVoice('a1')).toBe(true)
  frames(tree, 150)
  expect(cut()).toEqual([])
  // Pan a little at a time until a voice is cut by the edge, then let go.
  let found = false
  const steps: Array<[number, number]> = [...Array(40).fill([3, 0]), ...Array(40).fill([-3, 0]), ...Array(120).fill([0, 3]), ...Array(120).fill([0, -3])]
  for (let i = 0; i < steps.length && !found; i++) {
    panLoomOnRings(...steps[i]!)
    frames(tree, 1)
    found = cut().length > 0
  }
  expect(found).toBe(true)
  frames(tree, 90)
  expect(cut()).toEqual([])
})

const hitOf = (id: string) => loomState.lastFrameHitTargets.find(h => h[0] === id)!
const alphaOf = (style: string) => Number(/rgba\([^)]*,\s*([\d.]+)\)/.exec(style)?.[1] ?? 1)

test('paper, read by focus: the seed held open grows its pool clear of every voice printing words around it', async () => {
  paper.on = true
  const tree = await open()
  expect(holdLoomVoice('seed')).toBe(true)
  frames(tree, 150)
  const seed = hitOf('seed')
  const layout = ringLayoutFor(tree)!
  const pool = openPool(layout.pool, seed[3], seed[4], 1)
  const cx = layout.cx + loomState.current * 2 - loomState.loomTreeScrollX
  const cy = layout.cy - loomState.loomTreeScrollY
  for (const id of focusWords(tree, 'seed')) {
    if (id === 'seed') continue
    const [, x, y, hw, hh] = hitOf(id)
    // The point of its printed block nearest the pool's centre lies outside the pool.
    const nx = Math.max(x - hw, Math.min(cx, x + hw)) - cx
    const ny = Math.max(y - hh, Math.min(cy, y + hh)) - cy
    expect((nx / pool.rx) ** 2 + (ny / pool.ry) ** 2).toBeGreaterThanOrEqual(1)
  }
})

test('paper, read by focus: a voice held two steps out keeps an open column\'s margin, and its kin print at full ink', async () => {
  paper.on = true
  const tree = await open()
  frames(tree, 120)
  const restSize = [...sizes()][0]!
  expect(holdLoomVoice('a1')).toBe(true)
  frames(tree, 150)
  const [, x, , hw] = hitOf('a1')
  const margin = (VW - Math.min(TREE_OPEN_WIDTH, VW * 0.85)) / 2
  expect(x - hw).toBeGreaterThanOrEqual(margin - 1)
  expect(VW - (x + hw)).toBeGreaterThanOrEqual(margin - 1)
  // Its parent and children print at resting size, as brightly as once it is let go (the focus stays).
  const kinAlpha = () => {
    const [, ax, ay, ahw, ahh] = hitOf('a1')
    const kin = ctx.fillTextCalls.filter(c => c.font.includes(`${restSize}px`) && !(Math.abs(c.x - ax) <= ahw && Math.abs(c.y - ay) <= ahh))
    expect(kin.length).toBeGreaterThan(0)
    return Math.max(...kin.map(c => alphaOf(String(c.fillStyle))))
  }
  const held = kinAlpha()
  holdLoomVoice(null)
  frames(tree, 150)
  expect(loomState.loomFocusId).toBe('a1')
  expect(held).toBeGreaterThanOrEqual(kinAlpha() * 0.97)
})
