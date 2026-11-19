import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { aperture } from '../../src/loom/aperture.js'
import { enablePaper, resetPaperForTest } from '../../src/loom/paper.js'
import { shimmerKeep, STILL_LENS_PROXIMITY } from '../../src/loom/render/line.js'
import { resetWashForTest } from '../../src/loom/render/wash.js'
import {
  contour, HIDING_WATER, newField, pour, readRecords, resetWater, rimBias, stepField, stepWater,
  TIDE_HOLD, TIDE_LIFE_MS, tideStrength, WATER_CELL, waterForTest, waterOver, wetnessOf, type Bloom, type LensPour,
} from '../../src/loom/render/water.js'
import { loomState, resetLoomState } from '../../src/loom/state.js'
import type { Thread } from '../../src/loom/types.js'

// The water on the sheet (render/water.ts): the field itself, how wet each
// current is, and which words lie under water.

/** A block of water rows: (cx, y, half) from y0 to y1, closed by a zero-width row at each end. */
function block(cx: number, y0: number, y1: number, half: number): number[] {
  const rows = [cx, y0 - 6, 0]
  for (let y = y0; y <= y1; y += 12) rows.push(cx, y, half)
  rows.push(cx, y1 + 6, 0)
  return rows
}

function sumWater(x0: number, x1: number): number {
  const f = waterForTest()
  let s = 0
  for (let i = 0; i < f.water.length; i++) {
    const x = (i % f.gw) * WATER_CELL
    if (x >= x0 && x <= x1) s += f.water[i]!
  }
  return s
}

const steps = (n: number, bloom: Bloom | null = null) => { for (let i = 0; i < n; i++) stepField(0.1, bloom) }
const segments = () => [...contour(waterForTest().reach, 0.5, () => 1).values()].flat()

beforeEach(() => {
  resetPaperForTest()
  resetWashForTest()
  resetLoomState()
})
afterEach(() => {
  resetPaperForTest()
  resetWashForTest()
  resetLoomState()
})
afterAll(() => {
  resetPaperForTest()
  resetWater()
})

describe('the field', () => {
  test('a dry sheet is not worked on', () => {
    newField(600, 600)
    expect(waterForTest().dry).toBe(true)
    expect(stepField(0.1, null)).toBe(false)
  })

  test('water poured under a block holds the block\'s shape and records whose it is', () => {
    newField(600, 600)
    pour(block(300, 200, 400, 60), 3, 1, 1)
    const f = waterForTest()
    const at = (x: number, y: number) => Math.round(y / WATER_CELL) * f.gw + Math.round(x / WATER_CELL)
    expect(f.water[at(300, 300)]).toBeCloseTo(1, 5)
    expect(f.owner[at(300, 300)]).toBe(3)
    // Outside the block, even by the paper's lobes: dry, no one's.
    expect(f.water[at(380, 300)]).toBe(0)
    expect(f.owner[at(380, 300)]).toBe(-1)
    expect(f.water[at(300, 430)]).toBe(0)
  })

  test('water spreads only where the paper is already wet', () => {
    // How much of the block's water reaches past its right edge in 0.3 s: none
    // into dry paper, some into a film of water lying there.
    const gain = (film: boolean) => {
      const run = (withBlock: boolean) => {
        newField(600, 600)
        if (film) pour(block(440, 200, 400, 90), 1, 0.35, 1)
        if (withBlock) pour(block(300, 200, 400, 60), 0, 1, 1)
        steps(3)
        return sumWater(372, 600)
      }
      return run(true) - run(false)
    }
    expect(gain(false)).toBe(0)
    expect(gain(true)).toBeGreaterThan(0)
  })

  test('thin water dries first', () => {
    newField(600, 600)
    pour(block(150, 200, 300, 50), 0, 1, 1)
    pour(block(450, 200, 300, 50), 1, 0.2, 1)
    steps(15)
    expect(sumWater(0, 299)).toBeGreaterThan(10)
    expect(sumWater(300, 600)).toBe(0)
  })

  test('let go, a pool dries from its edge inward: its middle stays wet longest', () => {
    newField(600, 600)
    pour(block(300, 150, 450, 120), 0, 1, 1)
    const f = waterForTest()
    const at = (x: number, y: number) => f.water[Math.round(y / WATER_CELL) * f.gw + Math.round(x / WATER_CELL)]!
    steps(20) // 2 s
    expect(at(300, 300)).toBeGreaterThan(0.9)
    expect(at(300, 160)).toBe(0) // near its top
    expect(at(395, 300)).toBe(0) // near its side
    expect(at(300, 230)).toBeGreaterThan(0.9) // further in: not yet
    steps(50)
    expect(sumWater(0, 600)).toBe(0)
  })

  test('water never poured, spread into the paper, dries as slowly as it always did', () => {
    // A thin film placed by hand (no pour, no soak): dw/dt = -(0.05 + 0.22 (1 - w)).
    newField(600, 600)
    pour(block(300, 200, 300, 40), 0, 1, 1)
    const f = waterForTest()
    // Just below the block, inside the box that is worked on, beside dry paper.
    const i = Math.round(318 / WATER_CELL) * f.gw + Math.round(300 / WATER_CELL)
    f.water[i] = 0.2
    f.owner[i] = 0
    stepField(0.1, null)
    // The slow law leaves about 0.18; the drying of let-go water would leave nothing.
    expect(f.water[i]).toBeGreaterThan(0.14)
  })

  test('a slot\'s water stays its own where another\'s spreads beside it', () => {
    newField(600, 600)
    pour(block(300, 200, 400, 60), 0, 1, 1)
    pour(block(400, 200, 400, 60), 1, 1, 1)
    steps(5)
    const f = waterForTest()
    const at = (x: number, y: number) => Math.round(y / WATER_CELL) * f.gw + Math.round(x / WATER_CELL)
    expect(f.owner[at(300, 300)]).toBe(0)
    expect(f.owner[at(400, 300)]).toBe(1)
  })

  test('where it dried, a tide line stays put and fades; then the sheet is dry again', () => {
    newField(600, 600)
    pour(block(300, 200, 400, 60), 2, 1, 1)
    steps(80) // 8 s: all the water has dried
    expect(sumWater(0, 600)).toBe(0)
    const first = segments()
    expect(first.length).toBeGreaterThan(0)
    const life = Math.max(...waterForTest().life)
    steps(50)
    expect(segments()).toEqual(first)
    expect(Math.max(...waterForTest().life)).toBeLessThan(life)
    let n = 0
    while (stepField(0.1, null)) n++
    expect(n * 100).toBeLessThan(TIDE_LIFE_MS)
    expect(waterForTest().dry).toBe(true)
    expect(segments()).toHaveLength(0)
  })

  test('pigment gathers at the front only while the bloom pours, and only its own', () => {
    newField(600, 600)
    pour(block(300, 200, 400, 60), 0, 1, 1)
    pour(block(480, 200, 400, 40), 1, 1, 1)
    const bloom: Bloom = { slot: 0, cx: 300, cy: 300, rx: 60, ry: 100, side: 1, ox: 0, oy: 0 }
    steps(20, bloom)
    const f = waterForTest()
    let own = 0
    let other = 0
    for (let i = 0; i < f.dep.length; i++) {
      if (f.owner[i] === 0) own += f.dep[i]!
      if (f.owner[i] === 1) other += f.dep[i]!
    }
    expect(own).toBeGreaterThan(0)
    expect(other).toBe(0)
  })
})

describe('the tide line', () => {
  test('held at full strength for its first stretch, then fading to nothing', () => {
    expect(tideStrength(1, 0, 1, 0)).toBe(1)
    expect(tideStrength(1, 0, 1 - TIDE_HOLD, 0)).toBe(1) // TIDE_HOLD of its life in: still full
    const mid = tideStrength(1, 0, (1 - TIDE_HOLD) / 2, 0)
    expect(mid).toBeGreaterThan(0.3)
    expect(mid).toBeLessThan(0.7)
    expect(tideStrength(1, 0, 0, 0)).toBe(0)
  })

  test('broken where little pigment gathered: faint only where the grain is open, absent where it is closed', () => {
    expect(tideStrength(0, 0.2, 1, 0)).toBe(0)
    const open = tideStrength(0, 0.9, 1, 0)
    expect(open).toBeGreaterThan(0)
    expect(open).toBeLessThan(0.5) // weaker than where pigment gathered
    expect(tideStrength(0.5, 0.2, 1, 0)).toBe(1)
  })

  test('only once the water near it has gone: it grows in behind the leaving water', () => {
    expect(tideStrength(1, 1, 1, 0.3)).toBe(0)
    const half = tideStrength(1, 1, 1, 0.15)
    expect(half).toBeGreaterThan(0.2)
    expect(half).toBeLessThan(0.8)
    expect(tideStrength(1, 1, 1, 0.01)).toBe(1)
  })
})

describe('the rim', () => {
  const b: Bloom = { slot: 0, cx: 300, cy: 300, rx: 100, ry: 100, side: 1, ox: 3, oy: 5 }
  // Averaged over a band, so the broken stretches do not decide it.
  const along = (f: (t: number) => [number, number]) => {
    let s = 0
    for (let t = 0; t < 400; t++) s += rimBias(b, ...f(t))
    return s / 400
  }

  test('heavier low than high', () => {
    expect(along(t => [200 + t / 2, 395])).toBeGreaterThan(2 * along(t => [200 + t / 2, 205]))
  })

  test('heavier on its own side', () => {
    expect(along(t => [395, 200 + t / 2])).toBeGreaterThan(along(t => [205, 200 + t / 2]))
    const left = { ...b, side: -1 }
    let l = 0
    let r = 0
    for (let t = 0; t < 400; t++) { l += rimBias(left, 205, 200 + t / 2); r += rimBias(left, 395, 200 + t / 2) }
    expect(l).toBeGreaterThan(r)
  })

  test('broken in stretches: somewhere along a front it gathers nothing', () => {
    let gaps = 0
    for (let t = 0; t < 2000; t++) if (rimBias(b, t, 395) === 0) gaps++
    expect(gaps).toBeGreaterThan(50)
    expect(gaps).toBeLessThan(1900)
  })
})

// ── The sheet's water, through stepWater ──────────────────────────────────────

const VW = 1440
const VH = 900
const N = 60

function current(x: number, familyNames = ['attention']): Thread {
  return {
    _path: Array.from({ length: N }, (_, k) => ({ x, y: (k / (N - 1)) * VH })),
    familyNames,
    proximity: 0,
    apiWarmth: 0,
    baseColor: [0, 108, 182],
  } as unknown as Thread
}

function stage(threads: Thread[]): void {
  loomState.VW = VW
  loomState.VH = VH
  loomState.ready = true
  loomState.currentAperture = aperture(VW)
  loomState.threads = threads
}

const lens = (thread: Thread, amount = 1): LensPour => ({ thread, half: () => 200, y: 450, sigma: 120, amount, reach: 1 })

/** Runs the sheet's water from `from` to `to` ms at 30 frames a second. */
function run(from: number, to: number, pouring: LensPour | null): number {
  let t = from
  for (; t <= to; t += 33) stepWater(t, pouring)
  return t
}

describe('how wet a current is', () => {
  test('wet where it is read, dry elsewhere; it lingers, then dries away', () => {
    const read = current(700, ['attention'])
    const far = current(100, ['memory'])
    stage([read, far])
    let t = run(1000, 2000, lens(read))
    expect(wetnessOf(read)).toBeGreaterThan(0.8)
    expect(wetnessOf(far)).toBe(0)
    t = run(t, t + 2000, null)
    const lingering = wetnessOf(read)
    expect(lingering).toBeGreaterThan(0.8)
    t = run(t, t + 5000, null)
    const drying = wetnessOf(read)
    expect(drying).toBeGreaterThan(0)
    expect(drying).toBeLessThan(lingering)
    run(t, t + 40000, null)
    expect(wetnessOf(read)).toBe(0)
    expect(waterForTest().dry).toBe(true)
  })

  test('warmth does not make a current wet', () => {
    // Two currents on the same path, under the same water: as wet as each other however warm.
    const read = current(700, ['attention'])
    const cool = current(700, ['memory'])
    const warm = current(700, ['wonder'])
    const far = current(100, ['becoming'])
    cool.apiWarmth = 0
    warm.apiWarmth = 3
    far.apiWarmth = 3
    stage([read, cool, warm, far])
    stepWater(500, null)
    // No water anywhere: a warm current is dry.
    expect(wetnessOf(warm)).toBe(0)
    expect(wetnessOf(far)).toBe(0)
    run(1000, 2000, lens(read))
    expect(wetnessOf(cool)).toBeGreaterThan(0.5)
    expect(wetnessOf(warm)).toBe(wetnessOf(cool))
    // Away from the water, a warm current stays dry.
    expect(wetnessOf(far)).toBe(0)
    warm.apiWarmth = 0
    cool.apiWarmth = 3
    expect(wetnessOf(warm)).toBe(wetnessOf(cool))
  })

  test('a finished read leaves a record of where its water reached, whose it was, and when it dried', () => {
    const read = current(700)
    stage([read])
    let t = run(1000, 2000, lens(read))
    expect(readRecords()).toHaveLength(0)
    t = run(t, t + 15000, null)
    const [record] = readRecords()
    expect(record!.key).toBe('attention')
    expect(record!.driedAt).toBeGreaterThan(2000)
    const xs = [...record!.outline].filter((_, i) => i % 2 === 0)
    expect(Math.min(...xs)).toBeGreaterThan(450)
    expect(Math.max(...xs)).toBeLessThan(950)
  })
})

/** Cells of the pale patch (the wash cleared by more than a third). */
function patch(): number {
  let n = 0
  for (const c of waterForTest().clear) if (c > 0.3) n++
  return n
}

describe('drying that can be watched', () => {
  test('while a current is read, the water under its lines holds still and does not start drying', () => {
    const read = current(700)
    stage([read])
    let t = run(1000, 3000, lens(read))
    const f = waterForTest()
    const before = [Float32Array.from(f.water), Float32Array.from(f.clear)]
    t = run(t, t + 1500, lens(read))
    const after = waterForTest()
    let most = 0
    let held = 0
    for (let i = 0; i < before[0]!.length; i++) {
      if (before[0]![i]! < 0.9) continue // the pool's thin tips creep a little, as they always have
      held++
      most = Math.max(most, Math.abs(after.water[i]! - before[0]![i]!), Math.abs(after.clear[i]! - before[1]![i]!))
    }
    expect(held).toBeGreaterThan(1000)
    expect(most).toBeLessThan(0.02)
    // Poured water dries only by the slow law: under the lines it stays all but full.
    expect(after.water.filter(w => w > 0.98).length).toBeGreaterThan(1000)
  })

  test('let go, the pool recedes from the first second: half gone by 3 s, all by 6.5 s', () => {
    const read = current(700)
    stage([read])
    let t = run(1000, 5000, lens(read))
    const full = patch()
    expect(full).toBeGreaterThan(1000)
    const sizes: number[] = []
    for (let k = 1; k <= 26; k++) {
      t = run(t, t + 250, null)
      sizes.push(patch())
    }
    // Within the first second the edge has visibly drawn in.
    expect(sizes[3]!).toBeLessThan(full * 0.92)
    // About half by 2 to 3 s, gone by 6.5 s.
    expect(sizes[7]!).toBeLessThan(full * 0.65)
    expect(sizes[7]!).toBeGreaterThan(full * 0.25)
    expect(sizes[25]!).toBe(0)
    // Steadily: never growing, never losing more than a sixth of the pool in a quarter second.
    let prev = full
    for (const n of sizes) {
      expect(n).toBeLessThanOrEqual(prev)
      expect(prev - n).toBeLessThan(full / 6)
      prev = n
    }
  })

  test('on a slow phone the water still dries in real time', () => {
    // 12 frames a second, the wash painted every second one: a step every 166 ms.
    const read = current(700)
    stage([read])
    let t = run(1000, 5000, lens(read))
    const full = patch()
    let half = 0
    for (let k = 1; k <= 39; k++) {
      t += 166
      stepWater(t, null)
      if (k === 15) half = patch() // 2.5 s
    }
    expect(half).toBeLessThan(full * 0.65)
    expect(patch()).toBe(0) // 6.5 s
  })

  test('the tide line is left where the water reached, not where it last stood', () => {
    const read = current(700)
    stage([read])
    let t = run(1000, 3000, lens(read))
    const f = waterForTest()
    const reached = Float32Array.from(f.reach)
    t = run(t, t + 3000, null)
    // Most of the pool has dried; everywhere it reached is still marked reached.
    const now = waterForTest()
    let lost = 0
    for (let i = 0; i < reached.length; i++) if (reached[i]! > 0 && now.reach[i] === 0) lost++
    expect(lost).toBe(0)
    expect(patch()).toBeLessThan(reached.filter(r => r > 0).length * 0.5)
  })

  test('another current\'s words come back behind the retreating edge, not all at once', () => {
    enablePaper()
    const read = current(700, ['attention'])
    const other = current(720, ['memory'])
    stage([read, other])
    let t = run(1000, 5000, lens(read))
    const spans = new Set<number>()
    let first = 0
    for (let k = 0; k < 40; k++) {
      t = run(t, t + 150, null)
      const [from, to] = waterOver(other, 400, 1000, 450)
      const span = Math.max(0, to - from)
      if (k === 0) first = span
      spans.add(span)
    }
    expect(first).toBeGreaterThan(200)
    // The hidden stretch narrowed through many widths on its way to nothing.
    expect([...spans].filter(s => s > 0 && s < first).length).toBeGreaterThan(5)
    expect(spans.has(0)).toBe(true)
  })
})

describe('a resized sheet', () => {
  const cellOf = (x: number, y: number) => Math.round(y / WATER_CELL) * waterForTest().gw + Math.round(x / WATER_CELL)

  test('only its height changed: the water stays where it lies', () => {
    const read = current(700)
    stage([read])
    let t = run(1000, 3000, lens(read))
    const wet = waterForTest().water[cellOf(700, 450)]!
    expect(wet).toBeGreaterThan(0.9)
    loomState.VH = VH - 80 // the phone's bars
    t = run(t, t + 33, null)
    const f = waterForTest()
    expect(f.dry).toBe(false)
    expect(f.gh).toBe(Math.ceil((VH - 80) / WATER_CELL) + 2)
    expect(f.water[cellOf(700, 450)]).toBeGreaterThan(0.9)
    expect(f.owner[cellOf(700, 450)]).toBe(0)
    // And it still dries, then leaves its record.
    run(t, t + 10000, null)
    expect(sumWater(0, VW)).toBe(0)
    expect(readRecords()).toHaveLength(1)
  })

  test('taller again: the new strip is dry and the water above it carried', () => {
    const read = current(700)
    stage([read])
    let t = run(1000, 3000, lens(read))
    loomState.VH = VH + 120
    t = run(t, t + 33, null)
    const f = waterForTest()
    expect(f.water[cellOf(700, 450)]).toBeGreaterThan(0.9)
    expect(f.water[cellOf(700, VH + 60)]).toBe(0)
  })

  test('its width changed: the sheet starts dry', () => {
    const read = current(700)
    stage([read])
    let t = run(1000, 3000, lens(read))
    loomState.VW = VW - 200
    run(t, t + 33, null)
    expect(waterForTest().dry).toBe(true)
  })
})

describe('words under water', () => {
  test('another current\'s words are not printed under clean water; the open current\'s are', () => {
    enablePaper()
    const read = current(700, ['attention'])
    const other = current(720, ['memory'])
    stage([read, other])
    read.proximity = 0.9
    loomState.touchedThread = read
    run(1000, 2000, lens(read))
    const [from, to] = waterOver(other, 600, 840, 450)
    expect(from).toBeLessThan(620)
    expect(to).toBeGreaterThan(820)
    const own = waterOver(read, 600, 840, 450)
    expect(own[0]).toBeGreaterThanOrEqual(own[1])
    expect(own[2]).toBe(0)
    // Away from the water: printed in full.
    const clear = waterOver(other, 600, 840, 850)
    expect(clear[0]).toBeGreaterThanOrEqual(clear[1])
    expect(clear[2]).toBe(0)
  })

  test('as the water dries, the words come back gently', () => {
    enablePaper()
    const read = current(700, ['attention'])
    const other = current(720, ['memory'])
    stage([read, other])
    let t = run(1000, 2000, lens(read))
    let sawFade = false
    for (let i = 0; i < 400; i++) {
      t = run(t, t + 33, null)
      const [from, to, fade] = waterOver(other, 600, 840, 450)
      if (from >= to && fade > 0 && fade < 1) sawFade = true
      if (from >= to && fade === 0) break
    }
    expect(sawFade).toBe(true)
    const [from, to, fade] = waterOver(other, 600, 840, 450)
    expect(from).toBeGreaterThanOrEqual(to)
    expect(fade).toBe(0)
  })

  test('a line that only grazes thin water is not dimmed whole; one lying in it is', () => {
    enablePaper()
    const read = current(700, ['attention'])
    const other = current(720, ['memory'])
    stage([read, other])
    let t = run(1000, 2000, lens(read))
    // Wait for a stretch of thin water with no clean water on the line.
    let x = -1
    for (let k = 0; k < 400 && x < 0; k++) {
      t = run(t, t + 33, null)
      const f = waterForTest()
      const row = Math.round(450 / WATER_CELL) * f.gw
      for (let gx = 0; gx < f.gw; gx++) if (f.water[row + gx]! > 0.1 && f.water[row + gx]! < 0.25 && f.owner[row + gx] === 0) { x = gx * WATER_CELL; break }
      if (x >= 0 && waterOver(other, x - 3, x + 3, 450)[0] < waterOver(other, x - 3, x + 3, 450)[1]) x = -1
    }
    expect(x).toBeGreaterThan(0)
    const inIt = waterOver(other, x - 3, x + 3, 450)[2]
    // The rest of the line lies away from the pool, on dry paper.
    const grazing = x < 700 ? waterOver(other, x - 600, x + 3, 450) : waterOver(other, x - 3, x + 600, 450)
    expect(inIt).toBeGreaterThan(0.3)
    expect(grazing[0]).toBeGreaterThanOrEqual(grazing[1])
    expect(grazing[2]).toBeLessThan(inIt / 3)
  })

  test('its own water never hides a current\'s words, even once it is let go', () => {
    enablePaper()
    const read = current(700)
    stage([read])
    const t = run(1000, 2000, lens(read))
    run(t, t + 300, null)
    const [from, to, fade] = waterOver(read, 600, 840, 450)
    expect(from).toBeGreaterThanOrEqual(to)
    expect(fade).toBe(0)
  })

  test('held by touch, the other currents print no words anywhere on the sheet', () => {
    enablePaper()
    const read = current(700, ['attention'])
    const other = current(100, ['memory'])
    stage([read, other])
    read.proximity = 0.9
    loomState.readingKey = 'attention'
    expect([...waterOver(other, 0, 200, 850)].slice(0, 2)).toEqual([-Infinity, Infinity])
    read.proximity = 0.275 // halfway between WORDLESS_FROM and WORDLESS_PROXIMITY
    const [from, to, fade] = waterOver(other, 0, 200, 850)
    expect(from).toBeGreaterThanOrEqual(to)
    expect(fade).toBeCloseTo(0.5, 5)
  })

  test('the old look: water hides nothing', () => {
    const read = current(700, ['attention'])
    const other = current(720, ['memory'])
    stage([read, other])
    run(1000, 2000, lens(read))
    expect([...waterOver(other, 600, 840, 450)]).toEqual([0, 0, 0])
  })

  test('the water that hides words is at least HIDING_WATER deep', () => {
    enablePaper()
    const other = current(720, ['memory'])
    stage([other])
    // Water owned by a slot no current here holds (another current's), poured at a
    // depth of `amount` in its middle, then read over one of `other`'s lines.
    const at = (amount: number) => {
      newField(VW, VH)
      pour(block(720, 400, 500, 60), 0, amount, 1)
      return [...waterOver(other, 600, 840, 450)]
    }
    for (const amount of [HIDING_WATER, 1]) {
      const [from, to] = at(amount)
      expect(from).toBeLessThan(to)
      expect(from).toBeLessThan(720)
      expect(to).toBeGreaterThan(720)
    }
    const [from, to, fade] = at(HIDING_WATER * 0.8)
    expect(from).toBeGreaterThanOrEqual(to)
    expect(fade).toBeGreaterThan(0)
    expect(fade).toBeLessThan(1)
    resetWater()
  })
})

describe('a still lens', () => {
  test('on paper the current being read stops shimmering as its lens opens', () => {
    enablePaper()
    const read = current(700)
    loomState.touchedThread = read
    expect(shimmerKeep(read, 0)).toBe(1)
    expect(shimmerKeep(read, STILL_LENS_PROXIMITY / 2)).toBeCloseTo(0.5, 6)
    expect(shimmerKeep(read, STILL_LENS_PROXIMITY)).toBe(0)
    expect(shimmerKeep(read, 1)).toBe(0)
    // Another current keeps the sea's damping.
    expect(shimmerKeep(current(100), 0.5)).toBeCloseTo(0.6, 6)
  })

  test('the old look keeps its shimmer under the lens, damped to a fifth', () => {
    const read = current(700)
    loomState.touchedThread = read
    expect(shimmerKeep(read, 1)).toBeCloseTo(0.2, 6)
  })
})
