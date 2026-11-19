import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { initLoom, renderLoom } from '../../src/loom/index.js'
import { enablePaper, resetPaperForTest } from '../../src/loom/paper.js'
import { pathXAtY } from '../../src/loom/path.js'
import { clampReadingY, closeReading, dragReading, driveReading, DRAG_LIFT_SIGMAS, flingReading, isReading, isReceding, READING_EDGE_SIGMAS, READING_FOOT, READING_LINE, readingThread, RECEDED_PROXIMITY, recedingThread, tapCurrent, TOUCH_OPEN_RATE, WORDLESS_PROXIMITY } from '../../src/loom/reading.js'
import { DIVE_SIGMA_LINES } from '../../src/loom/types.js'
import { resetWashForTest } from '../../src/loom/render/wash.js'
import { loomState, resetLoomState } from '../../src/loom/state.js'
import type { Thread } from '../../src/loom/types.js'
import { attachInputHandlers, DOUBLE_TAP_MS, DRAG_SLOP_PX, READING_IDLE_MS, type TouchReading } from '../../src/runtime/input.js'
import { createSheetTap } from '../../src/runtime/sheet-tap.js'
import { CanvasContextStub, installViewport, loadState, makeMouse, makeState, runFrames, withFixedRandom } from './helpers.js'

// Reading by touch (loom/reading.ts, runtime/input.ts): a tap opens a current where
// it fell (kept on the sheet), a drag moves its text and never moves the lens, and
// letting go recedes.

const VW = 390
const VH = 844
const A = 'so we go on and on as the sea goes by and no one is in a rush to get to the end of it '
const M = 'and yet it is a new day for us all to see what we can do and be and say now '

function straight(thread: Thread, x: number): void {
  const n = thread._path.length
  thread._path = Array.from({ length: n }, (_, k) => ({ x, y: (k / (n - 1)) * VH }))
}

let attention: Thread
let memory: Thread
let ctx: CanvasContextStub
let mouse: ReturnType<typeof makeMouse>
let now = 0

async function sheet(): Promise<void> {
  installViewport(VW, VH)
  await loadState(makeState([
    { family: 'attention', voices: [{ id: 'a0', text: A }, { id: 'a1', text: A }] },
    { family: 'memory', voices: [{ id: 'm0', text: M }, { id: 'm1', text: M }] },
  ], 9300))
  withFixedRandom(0.5, () => initLoom())
  ctx = new CanvasContextStub()
  mouse = makeMouse()
  now = runFrames(renderLoom, ctx as unknown as CanvasRenderingContext2D, mouse, 6)
  attention = loomState.threads.find(t => t.familyNames.includes('attention'))!
  memory = loomState.threads.find(t => t.familyNames.includes('memory'))!
}
function frames(n: number): void {
  now = runFrames(renderLoom, ctx as unknown as CanvasRenderingContext2D, mouse, n, now)
}
function xOf(thread: Thread, y: number): number { return pathXAtY(thread._path, y) }
function sigma(): number { return DIVE_SIGMA_LINES * loomState.currentAperture!.diveLineH }
/** The band a read is kept in: [top, bottom]. */
function band(): [number, number] {
  const m = Math.min(READING_LINE * VH, READING_EDGE_SIGMAS * sigma())
  return [m, VH - Math.max(m, READING_FOOT * VH)]
}

beforeEach(async () => {
  resetLoomState()
  resetPaperForTest()
  resetWashForTest()
  await sheet()
})
afterEach(() => { resetPaperForTest(); resetLoomState() })
afterAll(() => { resetPaperForTest(); resetLoomState() })

describe('a tap chooses a current', () => {
  test('a tap opens a current where it fell', () => {
    const [top, bottom] = band()
    const tapY = (top + bottom) / 2 + 17
    expect(tapCurrent(xOf(attention, tapY), tapY)).toBe('opened')
    expect(readingThread()).toBe(attention)
    frames(90)
    expect(mouse.y).toBeCloseTo(tapY, 5)
    // The current sways from frame to frame; the lens rides it.
    expect(Math.abs(mouse.x - xOf(attention, tapY))).toBeLessThan(1)
    expect(loomState.touchedThread).toBe(attention)
    expect(attention.proximity).toBeGreaterThan(0.8)
    expect(memory.proximity).toBeLessThan(0.2)
  })

  test('a tap near an edge opens where the open text still fits on the sheet', () => {
    const [top, bottom] = band()
    // On a phone-sized sheet the band is wide: the lens goes most places a thumb does.
    expect(top).toBeCloseTo(READING_EDGE_SIGMAS * sigma(), 6)
    expect(bottom).toBeCloseTo(VH * (1 - READING_FOOT), 6)
    expect(bottom - top).toBeGreaterThan(VH * 0.3)
    tapCurrent(xOf(attention, 20), 20)
    frames(2)
    expect(mouse.y).toBeCloseTo(top, 5)
    tapCurrent(xOf(memory, VH - 10), VH - 10)
    frames(2)
    expect(readingThread()).toBe(memory)
    expect(mouse.y).toBeCloseTo(bottom, 5)
  })

  test('on a short sheet (an inline ext-app) a read stays near the middle', () => {
    installViewport(700, 320)
    withFixedRandom(0.5, () => initLoom())
    frames(6)
    attention = loomState.threads.find(t => t.familyNames.includes('attention'))!
    expect(clampReadingY(0)).toBeCloseTo(320 * READING_LINE, 5)
    // The lens's reach is larger than the sheet allows: the top margin (40%) is also the bottom one.
    expect(clampReadingY(320)).toBeCloseTo(320 * (1 - READING_LINE), 5)
    tapCurrent(xOf(attention, 300), 300)
    frames(2)
    expect(mouse.y).toBeGreaterThanOrEqual(320 * 0.4 - 1e-6)
    expect(mouse.y).toBeLessThanOrEqual(320 * 0.6 + 1e-6)
  })

  test('a rotation or resize cannot strand the read off the sheet', () => {
    tapCurrent(xOf(attention, 500), 500)
    frames(2)
    loomState.readingY = VH * 3
    frames(1)
    expect(loomState.readingY).toBeCloseTo(band()[1], 5)
    expect(mouse.y).toBeCloseTo(band()[1], 5)
  })

  test('when the held current is gone (rebuilt under another grouping), the read lets go and the pointer is parked', () => {
    tapCurrent(xOf(attention, 400), 400)
    frames(2)
    expect(isReading()).toBe(true)
    loomState.readingKey = 'no-such-current'
    driveReading(mouse)
    expect(isReading()).toBe(false)
    expect(isReceding()).toBe(false)
    expect(mouse.x).toBe(-9e3)
    expect(mouse.y).toBe(-9e3)
  })

  test('a drag that opens a current reads it above the thumb', () => {
    const y = 600
    expect(tapCurrent(xOf(attention, y), y, false, true)).toBe('opened')
    frames(2)
    expect(mouse.y).toBeCloseTo(clampReadingY(y - DRAG_LIFT_SIGMAS * sigma()), 5)
    expect(mouse.y).toBeLessThan(y - sigma())
  })

  test('a current held by touch opens about twice as fast as under a mouse', () => {
    const y = 400
    tapCurrent(xOf(attention, y), y)
    frames(20)
    const byTouch = attention.proximity
    expect(byTouch).toBeGreaterThan(1 - Math.pow(1 - TOUCH_OPEN_RATE, 20) - 0.05)
    closeReading()
    resetLoomState()
    // The same current under a mouse, from rest.
    return sheet().then(() => {
      mouse.x = xOf(attention, y); mouse.y = y
      for (let i = 0; i < 20; i++) { mouse.x = xOf(attention, y); frames(1) }
      expect(attention.proximity).toBeLessThan(byTouch * 0.75)
    })
  })

  test('it stays open with no finger on the glass', () => {
    tapCurrent(xOf(memory, 300), 300)
    frames(600)
    expect(readingThread()).toBe(memory)
    expect(memory.proximity).toBeGreaterThan(0.8)
  })

  test('a tap on the open current lets it go; on a woven voice it is kept', () => {
    tapCurrent(xOf(attention, 300), 300)
    frames(90)
    const y = VH * READING_LINE
    expect(tapCurrent(xOf(attention, y) + 40, y, true)).toBe('kept')
    expect(isReading()).toBe(true)
    expect(tapCurrent(xOf(attention, y) + 40, y)).toBe('closed')
    expect(isReading()).toBe(false)
  })

  test('a tap on a line the open current printed lets it go, wherever the line was printed', () => {
    tapCurrent(xOf(attention, 400), 400)
    frames(90)
    // The painter records each printed line of the current under the lens.
    loomState.lastFrameHitTargets = [['a0', 300, 610, 60, 12, 0, 0, 0, false]]
    expect(Math.abs(xOf(attention, 610) - 300)).toBeGreaterThan(60)
    expect(tapCurrent(330, 612)).toBe('closed')
    expect(isReceding()).toBe(true)
  })

  test('a current at the edge of the sheet opens inward, and a tap on its words finds it', () => {
    straight(attention, VW - 12)
    tapCurrent(VW - 12, 300)
    frames(90)
    straight(attention, VW - 12)
    const y = VH * READING_LINE
    // Its lines are printed inside the sheet, well left of its own centre line.
    expect(tapCurrent(VW - 180, y, true)).toBe('kept')
    expect(tapCurrent(VW - 180, y)).toBe('closed')
  })

  test('a tap on another current moves to it; a tap on bare paper closes', () => {
    installViewport(1200, VH)
    withFixedRandom(0.5, () => initLoom())
    frames(6)
    attention = loomState.threads.find(t => t.familyNames.includes('attention'))!
    memory = loomState.threads.find(t => t.familyNames.includes('memory'))!
    const y = VH * 0.9
    tapCurrent(xOf(attention, y), y)
    frames(90)
    // Far below the reading line the open current is narrow again; the other is well clear of it.
    expect(Math.abs(xOf(memory, 30) - xOf(attention, 30))).toBeGreaterThan(200)
    expect(tapCurrent(xOf(memory, 30) + 6, 30)).toBe('opened')
    expect(readingThread()).toBe(memory)
    frames(90)
    const bare = (xOf(memory, 30) + xOf(attention, 30)) / 2
    expect(tapCurrent(bare, 30)).toBe('closed')
    expect(isReading()).toBe(false)
    // At rest a thumb beside a current opens it; far out on bare paper it opens nothing.
    expect(tapCurrent(bare, 30)).toBe('closed')
    expect(tapCurrent(xOf(memory, 30) + 40, 30)).toBe('opened')
    expect(readingThread()).toBe(memory)
  })

  test('a held current keeps the lens when another crosses the reading line beside it', () => {
    tapCurrent(xOf(attention, 300), 300)
    frames(30)
    straight(memory, xOf(attention, VH * READING_LINE) + 4)
    frames(60)
    expect(loomState.touchedThread).toBe(attention)
  })

  test('the lens stays on the read\'s height while an arrival steers it, and after', () => {
    tapCurrent(xOf(attention, 520), 520)
    frames(30)
    const y = loomState.readingY
    loomState.phantomFocus = {} as never
    const m = makeMouse()
    m.x = 1; m.y = 2
    driveReading(m)
    expect(m.y).toBe(2)
    loomState.phantomFocus = null
    driveReading(m)
    expect(m.y).toBeCloseTo(y, 5)
    expect(loomState.readingY).toBe(y)
  })

  test('letting go gives the pointer back', () => {
    tapCurrent(xOf(attention, 300), 300)
    frames(30)
    closeReading()
    mouse.x = 12; mouse.y = 34
    frames(2)
    expect(mouse.x).toBe(12)
    expect(mouse.y).toBe(34)
  })
})

describe('letting go recedes', () => {
  test('a tap on the open current eases it shut where it was read, then parks the lens', () => {
    tapCurrent(xOf(attention, 480), 480)
    frames(90)
    const y = mouse.y
    const open = attention.proximity
    expect(tapCurrent(xOf(attention, y), y)).toBe('closed')
    expect(isReading()).toBe(false)
    expect(isReceding()).toBe(true)
    expect(recedingThread()).toBe(attention)
    frames(10)
    // Still where it was read, closing at the usual rate (0.015 a frame), not in one frame.
    expect(mouse.y).toBeCloseTo(y, 5)
    expect(attention.proximity).toBeLessThan(open)
    expect(attention.proximity).toBeGreaterThan(open * Math.pow(1 - 0.015, 10) - 0.05)
    expect(loomState.touchedThread).toBe(attention)
    frames(400)
    expect(attention.proximity).toBeLessThan(RECEDED_PROXIMITY)
    expect(isReceding()).toBe(false)
    expect(mouse.x).toBe(-9e3)
    expect(mouse.y).toBe(-9e3)
  })

  test('a tap on bare paper recedes too', () => {
    tapCurrent(xOf(attention, 480), 480)
    frames(60)
    loomState.threads.forEach(t => straight(t, t === attention ? 100 : 300))
    expect(tapCurrent(200, 480)).toBe('closed')
    expect(isReceding()).toBe(true)
  })

  test('a new tap during the recession wins at once, at its own height', () => {
    tapCurrent(xOf(attention, 480), 480)
    frames(90)
    tapCurrent(xOf(attention, 480), 480)
    frames(20)
    expect(isReceding()).toBe(true)
    expect(tapCurrent(xOf(attention, 330), 330)).toBe('opened')
    expect(isReceding()).toBe(false)
    frames(1)
    expect(mouse.y).toBeCloseTo(330, 5)
    const p = attention.proximity
    frames(10)
    expect(attention.proximity).toBeGreaterThan(p)
  })

  test('a tap on the lines of a current still easing shut opens that one again, not a neighbour', () => {
    straight(attention, VW - 12)
    tapCurrent(VW - 12, 400)
    frames(90)
    straight(attention, VW - 12)
    tapCurrent(VW - 12, 400)
    frames(8)
    straight(attention, VW - 12)
    // Its lines are printed inward from the edge, over where the other current runs.
    straight(memory, VW - 180)
    expect(isReceding()).toBe(true)
    expect(tapCurrent(VW - 170, 500)).toBe('opened')
    expect(readingThread()).toBe(attention)
    expect(loomState.readingY).toBeCloseTo(500, 5)
  })

  test('a real pointer ends the recession at once', () => {
    tapCurrent(xOf(attention, 480), 480)
    frames(60)
    tapCurrent(xOf(attention, 480), 480)
    frames(2)
    closeReading()
    expect(isReceding()).toBe(false)
    mouse.x = 12; mouse.y = 34
    frames(2)
    expect(mouse.y).toBe(34)
  })

  test('on paper the others\' words come back as the read current closes, not all at once', () => {
    enablePaper()
    tapCurrent(xOf(attention, 400), 400)
    frames(120)
    tapCurrent(xOf(attention, mouse.y), mouse.y)
    frames(4)
    ctx.fillTextCalls = []
    frames(2)
    expect(attention.proximity).toBeGreaterThan(WORDLESS_PROXIMITY)
    expect(ctx.fillTextCalls.some(c => c.text.includes('yet'))).toBe(false)
    frames(300)
    ctx.fillTextCalls = []
    frames(2)
    expect(ctx.fillTextCalls.some(c => c.text.includes('yet'))).toBe(true)
  })
})

describe('the other currents while one is read', () => {
  test('on paper they print no words once the read current is open', () => {
    enablePaper()
    frames(4)
    ctx.fillTextCalls = []
    frames(2)
    // "yet" is only in memory's text.
    expect(ctx.fillTextCalls.some(c => c.text.includes('yet'))).toBe(true)
    tapCurrent(xOf(attention, 300), 300)
    frames(120)
    expect(attention.proximity).toBeGreaterThan(WORDLESS_PROXIMITY)
    ctx.fillTextCalls = []
    frames(3)
    expect(ctx.fillTextCalls.some(c => c.text.includes('yet'))).toBe(false)
    expect(ctx.fillTextCalls.some(c => c.text.includes('rush') || c.text.includes('sea'))).toBe(true)
    closeReading()
    mouse.x = -9e3; mouse.y = -9e3
    frames(120)
    ctx.fillTextCalls = []
    frames(2)
    expect(ctx.fillTextCalls.some(c => c.text.includes('yet'))).toBe(true)
  })

  test('on a small sheet a mouse quiets them too; on a large one it does not', () => {
    enablePaper()
    const hover = () => {
      mouse.x = xOf(attention, 300); mouse.y = 300
      frames(120)
      ctx.fillTextCalls = []
      frames(3)
      return ctx.fillTextCalls.some(c => c.text.includes('yet'))
    }
    expect(isReading()).toBe(false)
    expect(hover()).toBe(false)   // 390 wide: no room for the others' words
    installViewport(1200, 800)
    withFixedRandom(0.5, () => initLoom())
    frames(6)
    attention = loomState.threads.find(t => t.familyNames.includes('attention'))!
    expect(hover()).toBe(true)
    installViewport(1200, 320)   // wide but short, as an inline ext-app
    withFixedRandom(0.5, () => initLoom())
    frames(6)
    attention = loomState.threads.find(t => t.familyNames.includes('attention'))!
    mouse.x = xOf(attention, 160); mouse.y = 160
    frames(120)
    ctx.fillTextCalls = []
    frames(3)
    expect(ctx.fillTextCalls.some(c => c.text.includes('yet'))).toBe(false)
  })

  test('in the old look they keep their words', () => {
    tapCurrent(xOf(attention, 300), 300)
    frames(120)
    ctx.fillTextCalls = []
    frames(3)
    expect(ctx.fillTextCalls.some(c => c.text.includes('yet'))).toBe(true)
  })
})

describe('a drag moves the text', () => {
  test('one line of finger travel is one line of text, and the lens stays where it is', () => {
    tapCurrent(xOf(attention, 300), 300)
    frames(90)
    const lineH = loomState.currentAperture!.diveLineH
    attention.scroll = 4
    const lensY = mouse.y
    dragReading(-lineH * 3)   // finger up three lines: the text moves on three lines
    expect(attention.scroll).toBeCloseTo(5, 6)
    dragReading(lineH * 6)    // and back down six
    expect(attention.scroll).toBeCloseTo(3, 6)
    frames(2)
    expect(mouse.y).toBe(lensY)
  })

  test('dragging back past the first line comes round to the last', () => {
    tapCurrent(xOf(attention, 300), 300)
    frames(30)
    attention.scroll = 0
    dragReading(loomState.currentAperture!.diveLineH * 3)
    expect(attention.scroll).toBeCloseTo(attention.totalLines / 3 - 1, 6)
  })

  test('a lift mid-drag carries the text on, within the usual limit', () => {
    tapCurrent(xOf(attention, 300), 300)
    frames(30)
    flingReading(-20)
    expect(attention.userScroll).toBeGreaterThan(0)
    flingReading(-9000)
    expect(attention.userScroll).toBe(2)
  })

  test('with nothing open a drag does nothing', () => {
    const before = attention.scroll
    dragReading(-200)
    expect(attention.scroll).toBe(before)
  })
})

// ── The handlers ──────────────────────────────────────

type Handler = (e: any) => void
class FakeElement {
  constructor(private control: boolean) {}
  closest(_: string) { return this.control ? this : null }
}

describe('touch handlers', () => {
  const g = globalThis as any
  let handlers: Record<string, Handler>
  let calls: string[]
  let open = false
  let clock = 0
  let timers: Array<{ at: number, fn: () => void }>
  let scrolled: number[]
  const saved: Record<string, unknown> = {}
  const canvas = new FakeElement(false)
  const button = new FakeElement(true)

  const reading = (enabled = true): TouchReading => ({
    enabled: () => enabled,
    active: () => open,
    tap: (x, y, byDrag) => { calls.push(`tap ${x},${y}${byDrag ? ' drag' : ''}`); open = !open; return open ? 'opened' : 'closed' },
    dropped: (x, y) => { calls.push(`drop ${x},${y}`) },
    drag: (dy) => { calls.push(`drag ${dy}`) },
    fling: (v) => { calls.push(`fling ${Math.round(v)}`) },
    release: (recede) => { calls.push(recede ? 'recede' : 'release'); open = false },
  })
  const touch = (type: string, x: number, y: number, target: FakeElement = canvas) =>
    handlers[type]!({ type, target, touches: type === 'touchend' ? [] : [{ clientX: x, clientY: y }] })
  // The click a browser may (or, on iOS for a canvas, may not) make up after a tap.
  const click = (x: number, y: number, target: FakeElement = canvas) => handlers.click?.({ type: 'click', target, clientX: x, clientY: y })
  let onTap: ((x: number, y: number, e: Event) => void) | undefined
  let onDrag: (() => void) | undefined
  function attach(r: TouchReading | undefined): void {
    attachInputHandlers({ mouse, scrollThread: (dy) => { scrolled.push(dy) }, aperture: () => ({ touchPersistence: 4 }), reading: r, onTap, onDrag })
  }

  beforeEach(() => {
    handlers = {}; calls = []; open = false; clock = 50000; timers = []; scrolled = []; onTap = undefined; onDrag = undefined
    for (const k of ['document', 'Element', 'setTimeout', 'clearTimeout']) saved[k] = g[k]
    saved.now = performance.now
    performance.now = () => clock
    g.document = { addEventListener: (type: string, fn: Handler) => { handlers[type] = fn }, removeEventListener: () => {} }
    g.Element = FakeElement
    g.setTimeout = (fn: () => void, ms: number) => { const t = { at: clock + ms, fn }; timers.push(t); return t }
    g.clearTimeout = (t: unknown) => { timers = timers.filter(x => x !== t) }
    mouse = makeMouse()
  })
  afterEach(() => {
    for (const k of ['document', 'Element', 'setTimeout', 'clearTimeout']) g[k] = saved[k]
    performance.now = saved.now as typeof performance.now
  })
  const advance = (ms: number) => {
    clock += ms
    for (const t of timers.filter(x => x.at <= clock)) { timers = timers.filter(x => x !== t); t.fn() }
  }

  test('a tap is a tap: the lens does not jump to the finger, and a drop falls where it ended', () => {
    attach(reading())
    touch('touchstart', 120, 700)
    expect(calls).toEqual([])
    advance(80)
    touch('touchend', 120, 700)
    expect(calls).toEqual(['tap 120,700', 'drop 120,700'])
    expect(mouse.x).toBe(-9e3)
    expect(mouse.touch).toBe(true)
  })

  test('a drag scrolls and never taps; small jitter is still a tap', () => {
    attach(reading())
    open = true
    touch('touchstart', 120, 700)
    advance(16); touch('touchmove', 121, 700 - (DRAG_SLOP_PX - 3))
    expect(calls).toEqual([])
    advance(16); touch('touchmove', 121, 660)
    advance(16); touch('touchmove', 121, 640)
    advance(200)
    touch('touchend', 121, 640)
    expect(calls).toEqual(['drag -35', 'drag -20'])
    expect(scrolled).toEqual([])
    expect(mouse.x).toBe(-9e3)
  })

  test('a drag on a resting sheet picks up the current under where it began', () => {
    attach(reading())
    touch('touchstart', 200, 500)
    advance(16); touch('touchmove', 200, 470)
    // Opened by a drag (read above the thumb): no drop falls.
    expect(calls).toEqual(['tap 200,500 drag', 'drag -30'])
    advance(16); touch('touchend', 200, 470)
    expect(calls.some(c => c.startsWith('drop'))).toBe(false)
  })

  test('where a drag belongs to the page around the sheet, it opens nothing and moves nothing', () => {
    attach({ ...reading(), dragOpens: () => false })
    touch('touchstart', 200, 500)
    advance(16); touch('touchmove', 200, 470)
    advance(16); touch('touchmove', 200, 440)
    touch('touchend', 200, 440)
    expect(calls).toEqual([])
    // Once a current is open, drags are the sheet's.
    open = true
    touch('touchstart', 200, 500)
    advance(16); touch('touchmove', 200, 470)
    expect(calls).toEqual(['drag -30'])
  })

  test('a finger still moving when it lifts carries the text on; one that stopped does not', () => {
    attach(reading())
    open = true
    touch('touchstart', 100, 600)
    advance(16); touch('touchmove', 100, 560)
    advance(16); touch('touchmove', 100, 528)
    advance(10)
    touch('touchend', 100, 528)
    expect(calls.at(-1)).toBe('fling -33')
    calls = []
    touch('touchstart', 100, 600)
    advance(16); touch('touchmove', 100, 560)
    advance(400)
    touch('touchend', 100, 560)
    expect(calls).toEqual(['drag -40'])
  })

  test('a tap on a woven voice waits for a second; alone, it lets the current go', () => {
    let lineage = false
    attach({ ...reading(), enabled: () => !lineage, tap: (x, y) => { calls.push(`tap ${x},${y}`); return 'kept' } })
    open = true
    const tap = () => { touch('touchstart', 150, 300); advance(50); touch('touchend', 150, 300) }
    tap()
    advance(DOUBLE_TAP_MS - 100)
    expect(open).toBe(true)
    advance(200)
    expect(open).toBe(false)
    expect(mouse.x).toBe(-9e3)
    // Two taps: the second cancels the wait, and the lineage it opens is not closed under it.
    open = true; calls = []
    tap()
    advance(200)
    tap()
    lineage = true
    advance(DOUBLE_TAP_MS + 200)
    expect(open).toBe(true)
    expect(calls).toEqual(['tap 150,300', 'tap 150,300'])
  })

  test('a long press is neither a tap nor a drag', () => {
    attach(reading())
    touch('touchstart', 100, 600)
    advance(900)
    touch('touchend', 100, 600)
    expect(calls).toEqual([])
  })

  test('a touch on a control reaches only the control', () => {
    attach(reading())
    open = true
    touch('touchstart', 30, 820, button)
    advance(40); touch('touchmove', 30, 780, button)
    touch('touchend', 30, 780, button)
    expect(calls).toEqual([])
    expect(mouse.down).toBe(false)
    expect(mouse.x).toBe(-9e3)
  })

  test('the made-up mouse events that follow a tap do not move the lens or let the current go', () => {
    attach(reading())
    touch('touchstart', 120, 700); advance(60); touch('touchend', 120, 700)
    advance(30)
    handlers.mousemove!({ clientX: 120, clientY: 700 })
    handlers.mousedown!({})
    expect(mouse.x).toBe(-9e3)
    expect(mouse.touch).toBe(true)
    expect(calls).toEqual(['tap 120,700', 'drop 120,700'])
    // A real pointer, later, takes over.
    advance(2000)
    handlers.mousemove!({ clientX: 300, clientY: 200 })
    expect(calls.at(-1)).toBe('release')
    expect(mouse.x).toBe(300)
  })

  test('left alone, the open current is let go and the sheet rests', () => {
    attach(reading())
    touch('touchstart', 120, 700); advance(60); touch('touchend', 120, 700)
    mouse.x = 55; mouse.y = 66
    advance(READING_IDLE_MS - 1000)
    expect(open).toBe(true)
    advance(2000)
    expect(open).toBe(false)
    expect(calls.at(-1)).toBe('recede')
    expect(mouse.x).toBe(-9e3)
  })

  test('a tap that lets go leaves the lens to the receding current, which parks it when shut', () => {
    let receding = false
    attach({ ...reading(), receding: () => receding, tap: (x, y) => { calls.push(`tap ${x},${y}`); open = false; receding = true; return 'closed' } })
    open = true
    mouse.x = 55; mouse.y = 66
    touch('touchstart', 150, 300); advance(50); touch('touchend', 150, 300)
    expect(calls).toEqual(['tap 150,300'])
    expect(mouse.y).toBe(66)
    // A real pointer during the recession takes the lens back at once.
    advance(2000)
    handlers.mousemove!({ clientX: 300, clientY: 200 })
    expect(calls.at(-1)).toBe('release')
    expect(mouse.y).toBe(200)
  })

  test('in the lineage view, and without touch reading, the lens follows the finger as before', () => {
    attach(reading(false))
    touch('touchstart', 120, 700)
    expect(mouse.x).toBe(120)
    advance(16); touch('touchmove', 124, 660)
    expect(mouse.y).toBe(660)
    expect(scrolled).toEqual([32])
    touch('touchend', 124, 660)
    advance(4100)
    expect(mouse.x).toBe(-9e3)
    expect(calls).toEqual([])
  })

  describe('a tap reaches the page once, with or without the click', () => {
    // The entry points' wiring (src/main.ts, app/src/mcp-app.ts): onTap feeds createSheetTap.
    // `started` stands in for the sound's first start, which main.ts calls from a touch tap's
    // touchend (or a click when no touch tap came first) and then disarms.
    let page: string[]
    let entered: string[]
    let started: number
    let lineage: boolean
    const WOVEN = 'v_woven'
    function wire(): void {
      page = []; entered = []; started = 0; lineage = false
      let armed = true
      const sheet = createSheetTap({
        touch: () => mouse.touch,
        hitAt: (x) => (x > 100 && x < 200 ? WOVEN : null),
        woven: (id) => id === WOVEN,
        loomActive: () => lineage,
        loomSeed: () => (lineage ? WOVEN : null),
        enter: (id) => { entered.push(id); lineage = true },
        recenter: (id) => { entered.push('recenter ' + id) },
        exit: () => { entered.push('exit'); lineage = false },
      })
      onTap = (x, y, e) => {
        page.push(`${e.type} ${x},${y}`)
        if (armed) { armed = false; started++ }
        sheet.tap(x, y)
      }
      onDrag = () => { page.push('drag'); sheet.clearPending() }
    }
    const tap = (x: number, y: number, clicks: boolean) => {
      touch('touchstart', x, y); advance(60); touch('touchend', x, y)
      if (clicks) { advance(10); click(x, y) }
    }

    for (const clicks of [false, true]) {
      test(clicks ? 'clicks delivered: nothing happens twice' : 'no clicks delivered: sound starts and a double tap opens the lineage', () => {
        wire()
        attach({ ...reading(), tap: (x, y) => { calls.push(`tap ${x},${y}`); open = true; return 'kept' } })
        tap(150, 300, clicks)
        expect(page).toEqual(['touchend 150,300'])
        expect(started).toBe(1)
        expect(entered).toEqual([])
        advance(200)
        tap(150, 300, clicks)
        expect(page).toEqual(['touchend 150,300', 'touchend 150,300'])
        expect(entered).toEqual([WOVEN])
        expect(started).toBe(1)
        // In the lineage view a tap on bare paper leaves it, once.
        advance(DOUBLE_TAP_MS + 100)
        tap(300, 300, clicks)
        expect(entered).toEqual([WOVEN, 'exit'])
      })
    }

    test('two taps too far apart, or a drag between them, do not open the lineage', () => {
      wire()
      attach({ ...reading(), tap: () => 'kept' })
      tap(150, 300, false)
      advance(DOUBLE_TAP_MS + 50)
      tap(150, 300, false)
      expect(entered).toEqual([])
      advance(DOUBLE_TAP_MS + 50)
      tap(150, 300, false)
      touch('touchstart', 150, 300); advance(16); touch('touchmove', 150, 300 - DRAG_SLOP_PX - 10); touch('touchend', 150, 290)
      expect(page.at(-1)).toBe('drag')
      tap(150, 300, false)
      expect(entered).toEqual([])
    })

    test('a drag, a long press, a cancelled touch or a touch on a control is no tap; a later click is', () => {
      wire()
      attach(reading())
      touch('touchstart', 150, 300); advance(16); touch('touchmove', 150, 250); touch('touchend', 150, 250)
      touch('touchstart', 150, 300); advance(900); touch('touchend', 150, 300)
      touch('touchstart', 150, 300); advance(50); handlers.touchcancel!({ type: 'touchcancel', target: canvas, touches: [] })
      touch('touchstart', 30, 820, button); advance(40); touch('touchend', 30, 820, button)
      expect(page).toEqual(['drag'])
      // The control's own click still reaches the page (the entry points skip it by id).
      advance(10); click(30, 820, button)
      expect(page).toEqual(['drag', 'click 30,820'])
    })

    test('in the lineage view (the finger moves the lens), taps reach the page the same way', () => {
      wire()
      lineage = true
      attach(reading(false))
      touch('touchstart', 150, 300); advance(60); touch('touchend', 150, 300)
      advance(10); click(150, 300)
      touch('touchstart', 300, 300); advance(60); touch('touchend', 300, 300)
      expect(page).toEqual(['touchend 150,300', 'touchend 300,300'])
      expect(entered).toEqual(['exit'])
    })

    test('a mouse click is a tap; a mouse needs one click on a woven voice', () => {
      wire()
      attach(reading())
      advance(2000)
      handlers.mousedown!({})
      click(150, 300)
      expect(page).toEqual(['click 150,300'])
      expect(entered).toEqual([WOVEN])
    })
  })
})
