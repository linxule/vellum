import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { aperture } from '../../src/loom/aperture.js'
import { paper, PAPER_RGB, enablePaper, resetPaperForTest, setNight } from '../../src/loom/paper.js'
import { pathXAtY } from '../../src/loom/path.js'
import { loomState, resetLoomState } from '../../src/loom/state.js'
import type { Thread } from '../../src/loom/types.js'
import {
  addRipple, beginCrossing, beginWashProfile, grainTile, hiddenSpan, markWashLine, paintWash,
  pointOnCurrent, randomCurrent, resetWashForTest, ringsOnLine,
} from '../../src/loom/render/wash.js'
import { setWaterCanvasForTest } from '../../src/loom/render/water.js'
import { paintedPaths, paintRecorder, rgbaAlpha } from './paint-recorder.js'

const VW = 1440
const VH = 900
const N = 60
const yAt = (k: number) => (k / (N - 1)) * VH

// A current with a path of its own: by default a straight column at x.
function current(x: number | ((k: number) => number), extra: Record<string, unknown> = {}): Thread {
  const fx = typeof x === 'number' ? () => x : x
  return {
    _path: Array.from({ length: N }, (_, k) => ({ x: fx(k), y: yAt(k) })),
    familyNames: ['attention'],
    scroll: 0,
    proximity: 0,
    apiWarmth: 0,
    baseColor: [0, 108, 182],
    pathSeed: 1.5,
    balancedWidth: 500,
    ...extra,
  } as unknown as Thread
}

function stage(threads: Thread[]): void {
  loomState.VW = VW
  loomState.VH = VH
  loomState.ready = true
  loomState.currentAperture = aperture(VW)
  loomState.threads = threads
  loomState.sortedThreadIndices = threads.map((_, i) => i)
  loomState.frameVisibilityAlpha = new Float32Array(threads.map(() => 1))
}

/** Marks every path point of a current as carrying a line of the given half-width. */
function profileOf(thread: Thread, half: number, now: number, only?: (k: number) => boolean): void {
  const p = beginWashProfile(thread, now)!
  for (let k = 0; k < N; k++) if (!only || only(k)) markWashLine(p, yAt(k), half, 1)
}

function paint(now: number) {
  const { ctx, calls } = paintRecorder()
  paintWash(ctx, 1, now)
  return { calls, paths: paintedPaths(calls) }
}

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
  resetWashForTest()
})

// ── Rings ─────────────────────────────────────────────────────────────────────

describe('rings', () => {
  // Where each fresh drop is drawn this frame (the drop itself is an arc for its first half second).
  const dropsAt = (calls: ReturnType<typeof paint>['calls']) => calls.filter(c => c.op === 'arc').map(c => [c.args[0] as number, c.args[1] as number])

  test('a drop on a current travels with its words, along the current\'s own path', () => {
    const slanted = current(k => 600 + k * 3)
    stage([slanted])
    const fallX = pathXAtY(slanted._path, 450) + 10
    addRipple('attention', fallX, 450, 1, 0)
    // Ten lines of text go by.
    slanted.scroll = 10.1 / 3
    const [[x, y]] = dropsAt(paint(100).calls) as [[number, number]]
    const moved = 10 * loomState.currentAperture!.textureLineH
    expect(y).toBeCloseTo(450 - moved, 6)
    expect(x).toBeCloseTo(pathXAtY(slanted._path, 450 - moved) + 10, 6)
  })

  test('a jump of the text (a wrap, or the wheel) leaves the ring where it is; it then rides on from there', () => {
    const c = current(700)
    stage([c])
    addRipple('attention', 700, 450, 1, 0)
    c.scroll = 4.1 / 3
    const [[, before]] = dropsAt(paint(50).calls) as [[number, number]]
    c.scroll = 400.1 / 3
    const [[, after]] = dropsAt(paint(100).calls) as [[number, number]]
    expect(after).toBeCloseTo(before, 6)
    c.scroll = 402.1 / 3
    const [[, rideOn]] = dropsAt(paint(150).calls) as [[number, number]]
    expect(rideOn).toBeCloseTo(before - 2 * loomState.currentAperture!.textureLineH, 6)
  })

  // BUG (reported, not fixed): when a ring's current is rebuilt (resizeLoom, a
  // night/day turn, a refresh that builds new Thread objects), placeRipples resets
  // it to where it FELL (rp.x, rp.y), not where it was last drawn, so a ring that
  // had travelled with its words snaps back. The jump branch just above keeps the
  // ring where it is (rp.x = rp.cx); this branch does not. src/loom/render/wash.ts:158.
  test('a ring whose current is rebuilt stays where it was last drawn', () => {
    const c = current(700)
    stage([c])
    addRipple('attention', 700, 450, 1, 0)
    c.scroll = 10.1 / 3
    const [[, travelled]] = dropsAt(paint(50).calls) as [[number, number]]
    expect(travelled).toBeLessThan(450)
    stage([current(700)]) // the same current, rebuilt
    const [[, after]] = dropsAt(paint(100).calls) as [[number, number]]
    expect(after).toBeCloseTo(travelled, 6)
  })

  test('a ring spreads and fades, and is gone after nine seconds', () => {
    stage([])
    addRipple('nowhere', 700, 450, 1, 0)
    let lastR = 0
    let lastA = Infinity
    for (const age of [0.2, 1, 3, 6, 8.9]) {
      const rings = paint(age * 1000).paths.filter(p => p.op === 'stroke')
      expect(rings).toHaveLength(1)
      const ring = rings[0]!
      const r = Math.max(...ring.points.map(([x, y]) => Math.hypot(x - 700, y - 450)))
      const a = rgbaAlpha(ring.style)
      expect(r).toBeGreaterThan(lastR)
      expect(a).toBeLessThan(lastA)
      expect(a).toBeGreaterThan(0)
      lastR = r
      lastA = a
    }
    expect(paint(9100).paths).toHaveLength(0)
  })

  test('the drop itself shows only for its first half second', () => {
    stage([])
    addRipple('nowhere', 700, 450, 1, 0)
    expect(paint(300).calls.filter(c => c.op === 'arc')).toHaveLength(1)
    expect(paint(600).calls.filter(c => c.op === 'arc')).toHaveLength(0)
  })

  test('a ring takes its current\'s ink', () => {
    enablePaper()
    stage([])
    addRipple('memory', 700, 450, 1, 0)
    const [ring] = paint(1000).paths
    expect(ring!.style).toStartWith('rgba(16,136,88,')
  })

  test('no more than ninety rings at once: a new drop pushes out the oldest', () => {
    stage([])
    for (let i = 0; i < 91; i++) addRipple('nowhere', 10 + i, 450, 1, 0)
    const drops = dropsAt(paint(100).calls).map(([x]) => x)
    expect(drops).toHaveLength(90)
    expect(drops).not.toContain(10)
    expect(drops).toContain(100)
  })
})

describe('what a ring does to a line', () => {
  // One ring at (700, 450), on no current.
  beforeEach(() => {
    stage([])
    addRipple('nowhere', 700, 450, 1, 0)
  })

  test('a line the ring\'s edge crosses takes ink; a line well away from it takes none', () => {
    const [crossed] = ringsOnLine(740, 800, 450, 1000)
    expect(crossed).toBeGreaterThan(0.4)
    expect(ringsOnLine(1000, 1100, 450, 1000)[0]).toBeLessThan(0.001)
    expect(ringsOnLine(600, 800, 100, 1000)).toEqual([0, 0])
  })

  test('a line deep inside a wide ring, away from its edge, takes almost none', () => {
    expect(ringsOnLine(690, 710, 450, 6000)[0]).toBeLessThan(0.001)
  })

  test('the ink it gives fades as the ring ages', () => {
    // The edge passes x≈751 at one second; follow it so the line stays on the edge.
    const early = ringsOnLine(740, 800, 450, 1000)[0]
    const r6 = 5 + 46 * Math.pow(6, 0.72)
    const late = ringsOnLine(700 + r6 - 10, 700 + r6 + 50, 450, 6000)[0]
    expect(late).toBeGreaterThan(0)
    expect(late).toBeLessThan(early)
  })

  test('a line is pushed a little away from the ring\'s centre, on either side', () => {
    const right = ringsOnLine(740, 800, 450, 1000)[1]
    const left = ringsOnLine(600, 660, 450, 1000)[1]
    expect(right).toBeGreaterThan(0)
    expect(left).toBeLessThan(0)
    expect(Math.abs(right)).toBeLessThanOrEqual(7)
    expect(Math.abs(left)).toBeLessThanOrEqual(7)
  })

  test('however strong the drops, a line\'s ink never passes 1', () => {
    for (let i = 0; i < 5; i++) addRipple('nowhere', 700, 450, 6, 0)
    expect(ringsOnLine(740, 800, 450, 1000)[0]).toBe(1)
  })

  test('a ring before its time, or after its life, does nothing', () => {
    expect(ringsOnLine(740, 800, 450, -500)).toEqual([0, 0])
    expect(ringsOnLine(740, 800, 450, 9500)).toEqual([0, 0])
  })

  // BUG (reported, not fixed): a ring on no current is drawn nearly round
  // (stretch 0.94, wash.ts:476) but ringsOnLine always stretches it along the
  // current by up to 1.45 (wash.ts:183). So a ring that fell where its family has
  // no current, or whose current was rebuilt, inks lines above and below where
  // its ring is drawn. At three seconds the drawn ring reaches about 0.94·r below
  // its centre; the line tested here is 1.45·r below, ~3 bands clear of the ink.
  test('a ring on no current inks a line only where the ring is drawn', () => {
    const r = 5 + 46 * Math.pow(3, 0.72)
    expect(ringsOnLine(690, 710, 450 + 1.45 * r, 3000)[0]).toBeLessThan(0.01)
  })
})

// ── The wash profile ──────────────────────────────────────────────────────────

describe('the wash profile', () => {
  test('none for a current without a path', () => {
    const stub = current(700)
    stub._path = stub._path.slice(0, 1)
    expect(beginWashProfile(stub)).toBeNull()
  })

  test('a point keeps the widest line and the strongest pigment drawn at it', () => {
    const c = current(700)
    const p = beginWashProfile(c, 5)!
    const y = yAt(20)
    markWashLine(p, y, 30, 0.4)
    markWashLine(p, y + 2, 50, 0.2)
    markWashLine(p, y - 1, 10, 1.3)
    expect(p.half[20]).toBe(50)
    expect(p.ink[20]).toBeCloseTo(1.3, 6)
    expect(p.at).toBe(5)
  })

  test('a line above or below the current\'s path leaves no mark', () => {
    const p = beginWashProfile(current(700))!
    markWashLine(p, -200, 40, 1)
    markWashLine(p, VH + 200, 40, 1)
    expect(p.half.every(v => v === 0)).toBe(true)
  })

  test('each frame starts the profile empty, in the same storage', () => {
    const c = current(700)
    const first = beginWashProfile(c, 0)!
    markWashLine(first, 450, 40, 1)
    const next = beginWashProfile(c, 16)!
    expect(next).toBe(first)
    expect(next.half.every(v => v === 0)).toBe(true)
    expect(next.ink.every(v => v === 0)).toBe(true)
    expect(next.at).toBe(16)
  })

  test('the profile follows a path whose length changed', () => {
    const c = current(700)
    beginWashProfile(c)
    c._path = c._path.slice(0, 30)
    expect(beginWashProfile(c)!.half.length).toBe(30)
  })
})

// ── Crossings ─────────────────────────────────────────────────────────────────

describe('crossings', () => {
  const NOW = 10000
  let under: Thread
  let over: Thread

  beforeEach(() => {
    under = current(700)
    over = current(700)
    stage([under, over])
    profileOf(over, 40, NOW)
  })

  test('a current painted later hides the stretch of a line it lies over, with a small gap', () => {
    beginCrossing(under)
    expect([...hiddenSpan(600, 800, 450, NOW)]).toEqual([655, 745])
  })

  test('a current painted earlier lies beneath and hides nothing', () => {
    loomState.sortedThreadIndices = [1, 0]
    beginCrossing(under)
    const [from, to] = hiddenSpan(600, 800, 450, NOW)
    expect(from).toBeGreaterThanOrEqual(to)
  })

  test('a current being read lies over by its order alone, like any other', () => {
    for (const proximity of [0.19, 0.2, 1]) {
      over.proximity = proximity
      beginCrossing(under)
      expect([...hiddenSpan(600, 800, 450, NOW)]).toEqual([655, 745])
    }
  })

  test('a current being read lies over too, wherever it sorts: the others part around its whole pool', () => {
    loomState.sortedThreadIndices = [1, 0]
    for (const proximity of [0.26, 1]) {
      over.proximity = proximity
      beginCrossing(under)
      expect([...hiddenSpan(600, 800, 450, NOW)]).toEqual([655, 745])
    }
    over.proximity = 0.2
    beginCrossing(under)
    const [from, to] = hiddenSpan(600, 800, 450, NOW)
    expect(from).toBeGreaterThanOrEqual(to)
  })

  test('a profile older than 400 ms is not trusted', () => {
    beginCrossing(under)
    expect([...hiddenSpan(600, 800, 450, NOW + 400)]).toEqual([655, 745])
    const [from, to] = hiddenSpan(600, 800, 450, NOW + 401)
    expect(from).toBeGreaterThanOrEqual(to)
  })

  test('a line that does not reach the current above is untouched', () => {
    beginCrossing(under)
    const [from, to] = hiddenSpan(745, 900, 450, NOW)
    expect(from).toBeGreaterThanOrEqual(to)
  })

  test('two currents over one line hide the whole stretch from the first to the last', () => {
    const third = current(800)
    stage([under, over, third])
    profileOf(over, 40, NOW)
    profileOf(third, 20, NOW)
    beginCrossing(under)
    expect([...hiddenSpan(500, 900, 450, NOW)]).toEqual([655, 825])
  })

  test('a current hides only where its own lines were drawn, read over two path points either side', () => {
    profileOf(over, 40, NOW, k => k === 30)
    beginCrossing(under)
    expect([...hiddenSpan(600, 800, yAt(32), NOW)]).toEqual([655, 745])
    const [from, to] = hiddenSpan(600, 800, yAt(33), NOW)
    expect(from).toBeGreaterThanOrEqual(to)
  })

  test('a column is read eased over its neighbours', () => {
    const p = beginWashProfile(over, NOW)!
    markWashLine(p, yAt(30), 40, 1)
    markWashLine(p, yAt(31), 80, 1)
    beginCrossing(under)
    // (40·3 + 80·2) / 5 = 56, plus the gap of 5.
    const [from, to] = hiddenSpan(600, 800, yAt(30), NOW)
    expect(from).toBeCloseTo(700 - 61, 4)
    expect(to).toBeCloseTo(700 + 61, 4)
  })

  test('the current itself is never counted as lying over itself', () => {
    stage([over])
    profileOf(over, 40, NOW)
    beginCrossing(over)
    const [from, to] = hiddenSpan(600, 800, 450, NOW)
    expect(from).toBeGreaterThanOrEqual(to)
  })
})

// ── Water on the wash ─────────────────────────────────────────────────────────

/** Mask canvases that hold their pixels and record nothing; the wash records the drawImage. */
function maskCanvases(): void {
  setWaterCanvasForTest((w, h) => ({
    width: w,
    height: h,
    getContext: () => ({
      createImageData: (iw: number, ih: number) => ({ data: new Uint8ClampedArray(iw * ih * 4), width: iw, height: ih }),
      putImageData() {},
    }) as unknown as CanvasRenderingContext2D,
  }))
}

describe('water on the wash', () => {
  const NOW = 1000
  let read: Thread
  let other: Thread

  beforeEach(() => {
    maskCanvases()
    enablePaper()
    read = current(700, { familyNames: ['attention'] })
    other = current(710, { familyNames: ['memory'] })
    stage([other, read])
  })
  afterEach(() => setWaterCanvasForTest(null))

  /** Opens the lens on `read` at the middle of the sheet, its lines 200 px either side. */
  function open(proximity = 0.9): void {
    read.proximity = proximity
    loomState.touchedThread = read
    loomState.currentMouse = { x: 700, y: 450 } as typeof loomState.currentMouse
  }
  function letGo(): void {
    read.proximity = 0
    loomState.touchedThread = null
    loomState.currentMouse = { x: -9999, y: -9999 } as typeof loomState.currentMouse
  }
  /** Paints frames from `from` to `to`, the text painter marking the read current's lines each frame. */
  function frames(from: number, to: number) {
    let last = paint(from)
    for (let t = from; t <= to; t += 33) {
      profileOf(read, 200, t)
      last = paint(t)
    }
    return last
  }
  const drawn = (calls: ReturnType<typeof paint>['calls']) => calls.filter(c => c.op === 'drawImage')

  test('a dry sheet paints no water', () => {
    expect(drawn(paint(NOW).calls)).toHaveLength(0)
  })

  test('under the lens the pigment is cleared after both currents are washed, then the pushed pigment is laid on', () => {
    open()
    const { calls } = frames(NOW, NOW + 600)
    const [clear, rim] = drawn(calls)
    expect(clear!.comp).toBe('destination-out')
    expect(rim!.comp).toBe('multiply')
    const at = calls.indexOf(clear!)
    // Three glazes each, both before the water.
    expect(calls.slice(0, at).filter(c => c.op === 'fill')).toHaveLength(6)
    expect(calls.slice(at).filter(c => c.op === 'fill')).toHaveLength(0)
    // Drawn where the lens is: the water's box takes in the reading line.
    const [, , , , , dx, dy, dw, dh] = clear!.args as number[]
    expect(dx).toBeLessThan(700)
    expect(dx + dw).toBeGreaterThan(700)
    expect(dy).toBeLessThan(450)
    expect(dy + dh).toBeGreaterThan(450)
    expect(calls.findLast(c => c.op === 'set:globalAlpha')!.args[0]).toBe(1)
  })

  test('on a night sheet the pushed pigment glows: screen, not multiply', () => {
    setNight(true)
    open()
    const [, rim] = drawn(frames(NOW, NOW + 300).calls)
    expect(rim!.comp).toBe('screen')
  })

  test('drops are drawn over the water, never cleared by it', () => {
    open()
    addRipple('attention', 700, 450, 1, NOW + 500)
    const { calls } = frames(NOW, NOW + 600)
    const water = calls.findIndex(c => c.op === 'drawImage')
    const drop = calls.findIndex(c => c.op === 'arc')
    expect(drop).toBeGreaterThan(water)
  })

  test('once it dries, a tide line stays: fine strokes in the current\'s ink', () => {
    // The band strokes its own edges and contours too: the tide line is what a read adds to those.
    const resting = paintedPaths(paint(NOW - 33).calls).filter(p => p.op === 'stroke').length
    open()
    frames(NOW, NOW + 600)
    letGo()
    for (let t = NOW + 633; t < NOW + 12000; t += 33) paint(t)
    const lines = paintedPaths(paint(NOW + 12000).calls).filter(p => p.op === 'stroke')
    expect(lines.length).toBeGreaterThan(resting)
    expect(lines.every(p => typeof p.style === 'string' && p.style.startsWith('rgba(0,108,182,'))).toBe(true)
    expect(Math.max(...lines.map(p => rgbaAlpha(p.style)))).toBeLessThanOrEqual(0.26)
  })

  test('the water fades with the ocean as the lineage view opens', () => {
    open()
    frames(NOW, NOW + 600)
    loomState.loomViewTransition = 0.5
    const { calls } = paint(NOW + 633)
    const clear = drawn(calls)[0]!
    const alphaBefore = calls.slice(0, calls.indexOf(clear)).findLast(c => c.op === 'set:globalAlpha')
    expect(alphaBefore!.args[0]).toBeCloseTo(0.5, 6)
    loomState.loomViewTransition = 1
    expect(drawn(paint(NOW + 666).calls)).toHaveLength(0)
  })
})

describe('painting the wash', () => {
  test('before the loom is ready the canvas is only cleared', () => {
    stage([current(700)])
    loomState.ready = false
    addRipple('attention', 700, 450, 1, 0)
    const { calls } = paint(100)
    expect(calls.filter(c => c.op === 'clearRect')).toHaveLength(1)
    expect(calls.some(c => c.op === 'fill' || c.op === 'stroke')).toBe(false)
  })

  test('glazes multiply on a day sheet and screen on a night sheet, and the blend is put back after', () => {
    enablePaper()
    for (const night of [false, true]) {
      setNight(night)
      stage([current(700)])
      const { calls } = paint(100)
      const blend = night ? 'screen' : 'multiply'
      const inked = calls.filter(c => c.op === 'fill' || c.op === 'stroke')
      expect(inked.length).toBeGreaterThan(0)
      expect(inked.every(c => c.comp === blend)).toBe(true)
      expect(calls.at(-1)).toMatchObject({ op: 'set:globalCompositeOperation', args: ['source-over'] })
    }
  })

  test('a current that is not showing is not washed', () => {
    stage([current(700)])
    loomState.frameVisibilityAlpha[0] = 0
    expect(paint(100).paths).toHaveLength(0)
  })
})

// ── Drops that fall without a hand ────────────────────────────────────────────

describe('points on currents', () => {
  test('a point on a family\'s current, at a height through the viewport', () => {
    const slanted = current(k => 300 + k * 5, { familyNames: ['memory', 'light'] })
    stage([current(900), slanted])
    const p = pointOnCurrent('light', 0.25)!
    expect(p.y).toBe(VH * 0.25)
    expect(p.x).toBeCloseTo(pathXAtY(slanted._path, VH * 0.25), 9)
    expect(pointOnCurrent('silence', 0.5)).toBeNull()
  })

  test('a current without a path has no point', () => {
    const c = current(700)
    c._path = c._path.slice(0, 1)
    stage([c])
    expect(pointOnCurrent('attention', 0.5)).toBeNull()
  })

  function withRandom<T>(values: () => number, fn: () => T): T {
    const real = Math.random
    Math.random = values
    try { return fn() } finally { Math.random = real }
  }

  test('a random current is one that is showing, at a height away from the edges', () => {
    const hidden = current(200, { familyNames: ['silence'], apiWarmth: 5 })
    const shown = current(900, { familyNames: ['memory'] })
    stage([hidden, shown])
    loomState.frameVisibilityAlpha[0] = 0.5
    for (let i = 0; i < 200; i++) {
      const pick = randomCurrent()!
      expect(pick.family).toBe('memory')
      expect(pick.point.y).toBeGreaterThanOrEqual(VH * 0.18)
      expect(pick.point.y).toBeLessThanOrEqual(VH * 0.82)
      expect(pick.point.x).toBe(900)
    }
    loomState.frameVisibilityAlpha[1] = 0.2
    expect(randomCurrent()).toBeNull()
  })

  test('warm currents are picked more often, cold ones still sometimes', () => {
    const cold = current(200, { familyNames: ['silence'], apiWarmth: 0 })
    const warm = current(900, { familyNames: ['memory'], apiWarmth: 3 }) // warmth past 1 counts as 1
    stage([cold, warm])
    const counts = { silence: 0, memory: 0 }
    const steps = 1000
    let call = 0
    withRandom(() => {
      // Three draws per pick: which current (an even sweep), which family, how high.
      const slot = call++
      return slot % 3 === 0 ? ((slot / 3) + 0.5) / steps : 0.5
    }, () => {
      for (let i = 0; i < steps; i++) counts[randomCurrent()!.family as 'silence' | 'memory']++
    })
    expect(counts.silence / steps).toBeCloseTo(0.35 / 1.7, 2)
    expect(counts.memory / steps).toBeCloseTo(1.35 / 1.7, 2)
  })

  test('nothing to pick from: no current', () => {
    stage([])
    expect(randomCurrent()).toBeNull()
  })
})

// ── Paper grain ───────────────────────────────────────────────────────────────

describe('the grain tile', () => {
  let realDocument: unknown
  let pixels: Uint8ClampedArray
  beforeEach(() => {
    realDocument = (globalThis as { document?: unknown }).document
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      writable: true,
      value: {
        createElement: () => ({
          width: 0,
          height: 0,
          getContext: () => ({
            createImageData: (w: number, h: number) => ({ data: (pixels = new Uint8ClampedArray(w * h * 4)) }),
            putImageData() {},
          }),
          toDataURL: () => 'data:image/png;base64,stub',
        }),
      },
    })
  })
  afterEach(() => {
    Object.defineProperty(globalThis, 'document', { configurable: true, writable: true, value: realDocument })
  })

  function tileWith(n: number): number[] {
    const real = Math.random
    Math.random = () => n
    try { expect(grainTile(4)).toBe('data:image/png;base64,stub') } finally { Math.random = real }
    return [...pixels.slice(0, 4)]
  }

  test('where the ink drops out, the paper of the current stock shows through', () => {
    enablePaper()
    const [r, g, b, a] = tileWith(0.05)
    expect([r, g, b]).toEqual([...PAPER_RGB])
    expect(a).toBeGreaterThanOrEqual(40)
    expect(a).toBeLessThanOrEqual(130)
    setNight(true)
    expect(tileWith(0.05).slice(0, 3)).toEqual([...PAPER_RGB])
  })

  test('the tooth is a dark fleck by day and a pale fibre by night, and faint', () => {
    enablePaper()
    const day = tileWith(0.95)
    setNight(true)
    const night = tileWith(0.95)
    expect(day[0]! + day[1]! + day[2]!).toBeLessThan(night[0]! + night[1]! + night[2]!)
    expect(day[3]!).toBeLessThanOrEqual(20)
    expect(night[3]!).toBeLessThanOrEqual(20)
  })

  test('most of the tile is left clear', () => {
    expect(tileWith(0.5)).toEqual([0, 0, 0, 0])
  })
})
