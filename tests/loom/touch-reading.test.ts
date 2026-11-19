import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { initLoom, renderLoom } from '../../src/loom/index.js'
import { enablePaper, resetPaperForTest } from '../../src/loom/paper.js'
import { pathXAtY } from '../../src/loom/path.js'
import { closeReading, dragReading, flingReading, isReading, READING_LINE, readingThread, tapCurrent, WORDLESS_PROXIMITY } from '../../src/loom/reading.js'
import { resetWashForTest } from '../../src/loom/render/wash.js'
import { loomState, resetLoomState } from '../../src/loom/state.js'
import type { Thread } from '../../src/loom/types.js'
import { attachInputHandlers, DRAG_SLOP_PX, READING_IDLE_MS, type TouchReading } from '../../src/runtime/input.js'
import { CanvasContextStub, installViewport, loadState, makeMouse, makeState, runFrames, withFixedRandom } from './helpers.js'

// Reading by touch (loom/reading.ts, runtime/input.ts): a tap opens a current at
// a fixed reading line, a drag moves its text, and the lens never follows the finger.

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

beforeEach(async () => {
  resetLoomState()
  resetPaperForTest()
  resetWashForTest()
  await sheet()
})
afterEach(() => { resetPaperForTest(); resetLoomState() })
afterAll(() => { resetPaperForTest(); resetLoomState() })

describe('a tap chooses a current', () => {
  test('a tap low on a current opens it at the reading line, not under the finger', () => {
    const tapY = VH * 0.85
    expect(tapCurrent(xOf(attention, tapY), tapY)).toBe('opened')
    expect(readingThread()).toBe(attention)
    frames(90)
    expect(mouse.y).toBeCloseTo(VH * READING_LINE, 5)
    // The current sways from frame to frame; the lens rides it.
    expect(Math.abs(mouse.x - xOf(attention, VH * READING_LINE))).toBeLessThan(1)
    expect(loomState.touchedThread).toBe(attention)
    expect(attention.proximity).toBeGreaterThan(0.8)
    expect(memory.proximity).toBeLessThan(0.2)
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
    tap: (x, y) => { calls.push(`tap ${x},${y}`); open = !open; return open ? 'opened' : 'closed' },
    drag: (dy) => { calls.push(`drag ${dy}`) },
    fling: (v) => { calls.push(`fling ${Math.round(v)}`) },
    release: () => { calls.push('release'); open = false },
  })
  const touch = (type: string, x: number, y: number, target: FakeElement = canvas) =>
    handlers[type]!({ target, touches: type === 'touchend' ? [] : [{ clientX: x, clientY: y }] })
  function attach(r: TouchReading | undefined): void {
    attachInputHandlers({ mouse, scrollThread: (dy) => { scrolled.push(dy) }, aperture: () => ({ touchPersistence: 4 }), reading: r })
  }

  beforeEach(() => {
    handlers = {}; calls = []; open = false; clock = 50000; timers = []; scrolled = []
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

  test('a tap is a tap: the lens does not jump to the finger', () => {
    attach(reading())
    touch('touchstart', 120, 700)
    advance(80)
    touch('touchend', 120, 700)
    expect(calls).toEqual(['tap 120,700'])
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
    expect(calls).toEqual(['tap 200,500', 'drag -30'])
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
    expect(calls).toEqual(['tap 120,700'])
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
    expect(mouse.x).toBe(-9e3)
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
})
