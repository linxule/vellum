import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { StateResponse } from '../../src/content.js'
import { initLoom, renderLoom } from '../../src/loom/index.js'
import { aperture } from '../../src/loom/aperture.js'
import { paper, resetPaperForTest } from '../../src/loom/paper.js'
import { addRipple, beginWashProfile, markWashLine, resetWashForTest } from '../../src/loom/render/wash.js'
import { renderThread } from '../../src/loom/render/thread.js'
import { resetWater, stepWater } from '../../src/loom/render/water.js'
import { loomState, resetLoomState } from '../../src/loom/state.js'
import type { ApertureConfig, Thread } from '../../src/loom/types.js'
import { CanvasContextStub, installViewport, loadState, makeMouse, makeState, parseRgbaAlpha, runFrames, withFixedRandom } from './helpers.js'

// The text painter on paper: where a current that is painted later crosses
// over a resting line, the covered stretch is not printed (render/thread.ts).

const VW = 1440
const VH = 900
const NOW = 20000
const X = 700

// Short words, so no line is widened to keep a long word whole: every resting
// line is exactly as wide as the column.
const WORDS = 'so we go on and on as the sea goes by and no one is in a rush to get to the end of it '
const OTHER = 'and yet it is a new day for us all to see what we can do and be and say now '

/** Records the clip rectangles as well as the text. */
class PaperContext extends CanvasContextStub {
  ops: Array<{ op: string, args: number[], fillStyle: unknown }> = []
  rect(...args: number[]) { this.ops.push({ op: 'rect', args, fillStyle: this.fillStyle }) }
  clip() { this.ops.push({ op: 'clip', args: [], fillStyle: this.fillStyle }) }
  override save() { this.ops.push({ op: 'save', args: [], fillStyle: this.fillStyle }); super.save() }
  override restore() { this.ops.push({ op: 'restore', args: [], fillStyle: this.fillStyle }); super.restore() }
  of(op: string) { return this.ops.filter(o => o.op === op) }
  /** The heights of the lines that printed body text. */
  printedRows(): number[] {
    return [...new Set(this.fillTextCalls.filter(c => c.text.trim() !== '').map(c => Math.round(c.y * 10) / 10))]
  }
}

function straight(thread: Thread, x: number): void {
  const n = thread._path.length
  thread._path = Array.from({ length: n }, (_, k) => ({ x, y: (k / (n - 1)) * VH }))
}

let state: StateResponse
async function ocean(text = WORDS): Promise<[Thread, Thread]> {
  installViewport(VW, VH)
  state = makeState([
    { family: 'attention', voices: [{ id: 'a0', text }, { id: 'a1', text: OTHER }] },
    { family: 'memory', voices: [{ id: 'm0', text: OTHER }, { id: 'm1', text: WORDS }] },
  ], 9100 + text.length)
  await loadState(state)
  withFixedRandom(0.5, () => initLoom())
  runFrames(renderLoom, new PaperContext() as unknown as CanvasRenderingContext2D, makeMouse(), 2)
  const under = loomState.threads.find(t => t.familyNames.includes('attention'))!
  const over = loomState.threads.find(t => t.familyNames.includes('memory'))!
  for (const t of loomState.threads) t.proximity = 0
  loomState.touchedThread = null
  straight(under, X)
  // Painted in this order: the attention current first, the memory current over it.
  loomState.sortedThreadIndices = [loomState.threads.indexOf(under), loomState.threads.indexOf(over)]
  return [under, over]
}

/** The current lying over, as the text painter last saw it: a column of half-width `half` at x. */
function lyingOver(over: Thread, x: number, half: number, at = NOW): void {
  straight(over, x)
  const p = beginWashProfile(over, at)!
  for (const pt of over._path) markWashLine(p, pt.y, half, 1)
}

// A wide resting column, so a line can keep a piece either side: 600..800.
const wide = (): ApertureConfig => ({ ...aperture(VW), restingWidth: 200 })

function paintUnder(under: Thread, ac: ApertureConfig = wide()): PaperContext {
  const ctx = new PaperContext()
  renderThread(ctx as unknown as CanvasRenderingContext2D, under, NOW, makeMouse(), ac, 1)
  return ctx
}

beforeEach(() => {
  resetPaperForTest()
  resetWashForTest()
  resetLoomState()
})
afterEach(() => {
  resetPaperForTest()
  resetWashForTest()
})
afterAll(() => {
  resetPaperForTest()
  resetWashForTest()
  resetLoomState()
})

describe('crossings', () => {
  test('nothing lying over: every line prints in full, unclipped', async () => {
    const [under] = await ocean()
    paper.on = true
    const ctx = paintUnder(under)
    expect(ctx.printedRows().length).toBeGreaterThan(20)
    expect(ctx.of('clip')).toHaveLength(0)
  })

  test('a line wholly under a crossing current is not printed', async () => {
    const [under, over] = await ocean()
    paper.on = true
    lyingOver(over, X, 200)
    const ctx = paintUnder(under)
    expect(ctx.printedRows()).toHaveLength(0)
    expect(ctx.of('clip')).toHaveLength(0)
  })

  test('a line crossed in its middle keeps both its ends, each clipped to its own side', async () => {
    const [under, over] = await ocean()
    paper.on = true
    const full = paintUnder(under).printedRows()
    lyingOver(over, X, 10) // hidden: 685..715
    const ctx = paintUnder(under)
    expect(ctx.printedRows()).toEqual(full)
    const clips = ctx.of('clip')
    expect(clips.length).toBeGreaterThanOrEqual(full.length)
    const rects = ctx.of('rect')
    expect(rects).toHaveLength(clips.length * 2)
    for (let i = 0; i < rects.length; i += 2) {
      const [lx, , lw] = rects[i]!.args as [number, number, number, number]
      const [rx, , rw] = rects[i + 1]!.args as [number, number, number, number]
      // Left piece 600..685 (with 20 px of slack outside the line); right piece 715..800 (+20).
      expect(lx).toBeCloseTo(580, 6)
      expect(lx + lw).toBeCloseTo(685, 6)
      expect(rx).toBeCloseTo(715, 6)
      expect(rx + rw).toBeCloseTo(820, 6)
    }
    expect(ctx.of('save')).toHaveLength(ctx.of('restore').length)
  })

  test('a piece too short to read is dropped; if both are, the line is not printed at all', async () => {
    const [under, over] = await ocean()
    paper.on = true
    const full = paintUnder(under).printedRows()
    // Hidden 634..766: 34 px either side, the shortest piece kept.
    lyingOver(over, X, 61)
    const kept = paintUnder(under)
    expect(kept.printedRows()).toEqual(full)
    expect(kept.of('rect')).toHaveLength(kept.of('clip').length * 2)
    // Hidden 633.5..766.5: 33.5 px either side, both dropped.
    lyingOver(over, X, 61.5)
    expect(paintUnder(under).printedRows()).toHaveLength(0)
  })

  test('a crossing near one end keeps only the other end', async () => {
    const [under, over] = await ocean()
    paper.on = true
    const full = paintUnder(under).printedRows()
    lyingOver(over, 760, 10) // hidden 745..775: 145 px kept on the left, 25 px dropped on the right
    const ctx = paintUnder(under)
    expect(ctx.printedRows()).toEqual(full)
    const rects = ctx.of('rect')
    expect(rects).toHaveLength(ctx.of('clip').length)
    for (const r of rects) {
      expect(r.args[0]).toBeCloseTo(580, 6)
      expect(r.args[0]! + r.args[2]!).toBeCloseTo(745, 6)
    }
  })

  test('the clip is as tall as the gap to the next line, so a piece is never cut through its letters', async () => {
    const [under, over] = await ocean()
    paper.on = true
    lyingOver(over, X, 10)
    const ctx = paintUnder(under)
    const rows = ctx.printedRows()
    const rects = ctx.of('rect')
    // Rows are evenly spaced at rest; each clip box is centred on its row and one row (+4) tall.
    const row = rows[10]!
    const gap = rows[11]! - row
    const box = rects.find(r => Math.abs(r.args[1]! + r.args[3]! / 2 - row) < 0.2)!
    expect(box).toBeDefined()
    expect(box.args[3]!).toBeCloseTo(gap + 4, 0)
  })

  test('a current being read is never cut by one crossing it', async () => {
    const [under, over] = await ocean()
    paper.on = true
    lyingOver(over, X, 200)
    under.proximity = 0.15
    const ctx = paintUnder(under)
    expect(ctx.printedRows().length).toBeGreaterThan(0)
    expect(ctx.of('clip')).toHaveLength(0)
  })

  test('the current painted earlier is not cut by the one beneath it', async () => {
    const [under, over] = await ocean()
    paper.on = true
    lyingOver(over, X, 200)
    loomState.sortedThreadIndices = [...loomState.sortedThreadIndices].reverse()
    expect(paintUnder(under).printedRows().length).toBeGreaterThan(0)
  })

  test('the sea look: both currents print in full, one over the other', async () => {
    const [under, over] = await ocean()
    resetPaperForTest()
    lyingOver(over, X, 200)
    const ctx = paintUnder(under)
    expect(ctx.printedRows().length).toBeGreaterThan(20)
    expect(ctx.of('clip')).toHaveLength(0)
  })
})

describe('under another current\'s water', () => {
  /** Clean water from the read current `over`, its lines 120 px either side of x, poured for a second around y 450. */
  function wet(over: Thread, x: number): number {
    straight(over, x)
    let t = NOW
    for (; t < NOW + 1000; t += 33) stepWater(t, { thread: over, half: () => 120, y: 450, sigma: 120, amount: 1, reach: 1 })
    return t
  }
  const rowsNear = (rows: number[], y: number, d: number) => rows.filter(r => Math.abs(r - y) < d)

  test('its words are not printed where the water lies; above and below it they are', async () => {
    const [under, over] = await ocean()
    paper.on = true
    const full = paintUnder(under).printedRows()
    wet(over, X)
    const rows = paintUnder(under).printedRows()
    expect(rowsNear(full, 450, 40).length).toBeGreaterThan(0)
    expect(rowsNear(rows, 450, 40)).toHaveLength(0)
    expect(rowsNear(rows, 850, 40)).toEqual(rowsNear(full, 850, 40))
    resetWater()
  })

  test('as the water dries the words come back, dimmed first', async () => {
    const [under, over] = await ocean()
    paper.on = true
    const alphaNear = (ctx: PaperContext) => ctx.fillTextCalls.filter(c => Math.abs(c.y - 450) < 20 && c.text.trim() !== '').map(c => parseRgbaAlpha(c.fillStyle))
    const fullAlpha = Math.max(...alphaNear(paintUnder(under)))
    let t = wet(over, X)
    let dimmed = false
    for (let i = 0; i < 400 && !dimmed; i++) {
      stepWater(t += 33, null)
      const near = alphaNear(paintUnder(under))
      if (near.length > 0 && Math.max(...near) < fullAlpha * 0.9) dimmed = true
    }
    expect(dimmed).toBe(true)
    resetWater()
  })

  test('the lines being read are never pushed by a ring', async () => {
    const [under] = await ocean()
    paper.on = true
    under.proximity = 1
    loomState.touchedThread = under
    const mouse = { ...makeMouse(), x: X, y: 450 }
    const xsOf = () => {
      const ctx = new PaperContext()
      renderThread(ctx as unknown as CanvasRenderingContext2D, under, NOW, mouse, wide(), 1)
      return ctx.fillTextCalls.filter(c => Math.abs(c.y - 450) < 60).map(c => Math.round(c.x * 100) / 100)
    }
    const still = xsOf()
    expect(still.length).toBeGreaterThan(0)
    addRipple('attention', X + 30, 450, 1, NOW - 600)
    expect(xsOf()).toEqual(still)
    // The same ring does push a current at rest.
    under.proximity = 0
    loomState.touchedThread = null
    resetWashForTest()
    const resting = xsOf()
    addRipple('attention', X + 30, 450, 1, NOW - 600)
    expect(xsOf()).not.toEqual(resting)
  })
})

