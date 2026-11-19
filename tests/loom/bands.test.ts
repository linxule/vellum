// The bands of wash, dry and wet: thin and still when dry, wide and moving when
// wet, broken into dry-brush streaks when the text moves fast.
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { aperture } from '../../src/loom/aperture.js'
import { enablePaper, resetPaperForTest } from '../../src/loom/paper.js'
import { loomState, resetLoomState } from '../../src/loom/state.js'
import type { Thread } from '../../src/loom/types.js'
import { beginWashProfile, markWashLine, paintWash, resetWashForTest, setWetnessForTest } from '../../src/loom/render/wash.js'
import { paintedPaths, paintRecorder, type PaintCall } from './paint-recorder.js'

const VW = 1440
const VH = 900
const N = 60
const yAt = (k: number) => (k / (N - 1)) * VH
const HALF = 30

function current(x: number, extra: Record<string, unknown> = {}): Thread {
  return {
    _path: Array.from({ length: N }, (_, k) => ({ x, y: yAt(k) })),
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

/** Paints one wash frame, with each current's text the same column of lines as before. */
function paint(threads: Thread[], now: number) {
  for (const t of threads) {
    const p = beginWashProfile(t, now)!
    for (let k = 0; k < N; k++) markWashLine(p, yAt(k), HALF, 1)
  }
  const { ctx, calls } = paintRecorder()
  paintWash(ctx, 1, now)
  return { calls, paths: paintedPaths(calls) }
}

/** The glazes (filled with a gradient), outer first; and the outer glaze's width at path point k. */
const glazes = (paths: ReturnType<typeof paintedPaths>) => paths.filter(p => p.op === 'fill' && typeof p.style !== 'string')
function outerWidth(paths: ReturnType<typeof paintedPaths>, k = N >> 1): number {
  const pts = glazes(paths)[0]!.points
  return pts[2 * N - 1 - k]![0] - pts[k]![0]
}
/**
 * The dry brush's lanes: the shapes a rough band cuts out of its own clip (the
 * sheet's rectangle with the lanes inside it, clipped even-odd), as point lists.
 */
function dryLanes(calls: PaintCall[]): Array<Array<[number, number]>> {
  const out: Array<Array<[number, number]>> = []
  let shapes: Array<Array<[number, number]>> | null = null
  for (const c of calls) {
    if (c.op === 'beginPath') shapes = null
    else if (c.op === 'rect') shapes = []
    else if (shapes && c.op === 'moveTo') shapes.push([[c.args[0] as number, c.args[1] as number]])
    else if (shapes && c.op === 'lineTo') shapes.at(-1)!.push([c.args[0] as number, c.args[1] as number])
    else if (c.op === 'clip') {
      if (shapes && c.args[0] === 'evenodd') out.push(...shapes)
      shapes = null
    }
  }
  return out
}
/** Each fill and stroke, with whether a clip was in force when it was made (the recorder keeps no state stack). */
function marksWithClip(calls: PaintCall[]): Array<PaintCall & { clipped: boolean }> {
  const stack: boolean[] = []
  let clipped = false
  const out: Array<PaintCall & { clipped: boolean }> = []
  for (const c of calls) {
    if (c.op === 'save') stack.push(clipped)
    else if (c.op === 'restore') clipped = stack.pop() ?? false
    else if (c.op === 'clip') clipped = true
    else if (c.op === 'fill' || c.op === 'stroke') out.push({ ...c, clipped })
  }
  return out
}
/** A band's painted paths, comparable across frames (gradients are new objects each frame). */
const shapeOf = (paths: ReturnType<typeof paintedPaths>) => paths.map(p => ({ op: p.op, points: p.points, comp: p.comp, style: typeof p.style === 'string' ? p.style : 'gradient' }))
// One band is three glazes, two tide lines and four contours.
const BAND_PATHS = 9

let wet = 0
beforeEach(() => {
  resetPaperForTest()
  resetWashForTest()
  resetLoomState()
  enablePaper()
  wet = 0
  setWetnessForTest(() => wet)
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

describe('dry and wet', () => {
  test('a dry band is narrower than a wet one under the same lines, and hugs them', () => {
    const c = current(700)
    stage([c])
    const dry = outerWidth(paint([c], 1000).paths)
    resetWashForTest()
    wet = 1
    setWetnessForTest(() => wet)
    const soaked = outerWidth(paint([c], 1000).paths)
    expect(dry).toBeLessThan(soaked * 0.8)
    // The words are 60 px wide: a dry stain reaches only a little past them.
    expect(dry).toBeGreaterThan(2 * HALF * 0.8)
    expect(dry).toBeLessThan(2 * HALF * 1.45)
  })

  test('a dry band is still: consecutive wash frames paint it identically', () => {
    const c = current(700)
    stage([c])
    // Gradient objects are new each frame; compare outlines and flat styles.
    const shape = (t: number) => paint([c], t).paths.map(p => ({ op: p.op, points: p.points, style: typeof p.style === 'string' ? p.style : 'gradient' }))
    const frames = [1000, 1033, 1300, 2600].map(shape)
    for (const f of frames.slice(1)) expect(f).toEqual(frames[0]!)
  })

  test('a wet band\'s edge is redrawn on the slow clock, and holds between its ticks', () => {
    wet = 1
    const c = current(700)
    stage([c])
    const edge = (now: number) => glazes(paint([c], now).paths)[0]!.points
    const a = edge(1000)  // drawing 8
    const b = edge(1060)  // still drawing 8
    const next = edge(1130) // drawing 9
    expect(b).toEqual(a)
    expect(next).not.toEqual(a)
    // A small wander, a few px, not a jump.
    const moved = Math.max(...a.map(([x], i) => Math.abs(x - next[i]![0])))
    expect(moved).toBeGreaterThan(0.2)
    expect(moved).toBeLessThan(6)
  })

  test('wetting swells the band over a moment, and drying narrows it again over seconds: never a pop', () => {
    const c = current(700)
    stage([c])
    const dry = outerWidth(paint([c], 1000).paths)
    wet = 1
    const first = outerWidth(paint([c], 1033).paths)
    expect(first).toBeGreaterThan(dry)
    let w = first
    for (let t = 1066; t <= 2500; t += 33) w = outerWidth(paint([c], t).paths)
    expect(first - dry).toBeLessThan((w - dry) * 0.25)
    wet = 0
    const leaving = outerWidth(paint([c], 2533).paths)
    expect(leaving).toBeGreaterThan(w - (w - dry) * 0.1)
    let half = 0
    for (let t = 2566; t <= 6000; t += 33) {
      const now = outerWidth(paint([c], t).paths)
      if (!half && now < (w + dry) / 2) half = t
    }
    expect(half - 2533).toBeGreaterThan(300)
    expect(half - 2533).toBeLessThan(2000)
    // Dry again; it keeps the shape it had when it dried, so close to, not exactly, the first.
    expect(Math.abs(outerWidth(paint([c], 6033).paths) - dry)).toBeLessThan(dry * 0.06)
  })
})

describe('dry brush', () => {
  // Lines of text a second, as the band moves between two wash frames 100 ms apart.
  function flick(linesPerSecond: number) {
    const c = current(700)
    stage([c])
    paint([c], 1000)
    c.scroll += (linesPerSecond * 0.1) / 3
    return { c, calls: paint([c], 1100).calls }
  }

  test('a fast scroll breaks the wash into streaks; a slow one does not', () => {
    expect(dryLanes(flick(15).calls)).toHaveLength(0)
    expect(dryLanes(flick(200).calls).length).toBeGreaterThan(5)
  })

  test('the streaks are long thin runs inside the band, and the lanes it only thinned are painted again, fainter', () => {
    const { calls } = flick(200)
    const lanes = dryLanes(calls)
    const outer = glazes(paintedPaths(calls))[0]!.points.map(([x]) => x)
    const [lo, hi] = [Math.min(...outer), Math.max(...outer)]
    for (const lane of lanes) {
      for (const [x] of lane) expect(x >= lo - 3 && x <= hi + 3).toBe(true)
      // Down the band and back up: a lane is taller than it is wide.
      const ys = lane.map(([, y]) => y)
      const xs = lane.map(([x]) => x)
      if (ys.length >= 4) expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(Math.max(...xs) - Math.min(...xs))
    }
    // Clipped to the lanes alone (nonzero), the glazes again, at less than full strength.
    const thinned = calls.findIndex(c => c.op === 'clip' && c.args[0] === undefined)
    expect(thinned).toBeGreaterThan(-1)
    expect(calls.slice(thinned).some(c => c.op === 'fill')).toBe(true)
  })

  test('nothing the rough band does removes paint: a band beneath it is untouched', () => {
    // The lower band (painted first) and the rough one cross over the same column.
    const frame = (linesPerSecond: number) => {
      resetWashForTest()
      setWetnessForTest(() => wet)
      const lower = current(700, { familyNames: ['memory'], baseColor: [180, 40, 40], pathSeed: 4.2 })
      const upper = current(712)
      stage([lower, upper])
      paint([lower, upper], 1000)
      upper.scroll += (linesPerSecond * 0.1) / 3
      return paint([lower, upper], 1100)
    }
    const smooth = frame(15)
    const rough = frame(200)
    expect(dryLanes(rough.calls).length).toBeGreaterThan(5)
    expect(rough.calls.some(c => c.comp === 'destination-out')).toBe(false)
    expect(rough.calls.some(c => c.op === 'set:globalCompositeOperation' && c.args[0] !== 'multiply' && c.args[0] !== 'source-over')).toBe(false)
    expect(shapeOf(rough.paths.slice(0, BAND_PATHS))).toEqual(shapeOf(smooth.paths.slice(0, BAND_PATHS)))
    expect(marksWithClip(rough.calls).slice(0, BAND_PATHS).every(m => !m.clipped && m.comp === 'multiply')).toBe(true)
  })

  test('a band painted after the rough one carries the normal blend and none of its clip', () => {
    const frame = (linesPerSecond: number) => {
      resetWashForTest()
      setWetnessForTest(() => wet)
      const rough = current(700)
      const after = current(1000, { familyNames: ['memory'], baseColor: [180, 40, 40], pathSeed: 4.2 })
      stage([rough, after])
      paint([rough, after], 1000)
      rough.scroll += (linesPerSecond * 0.1) / 3
      return paint([rough, after], 1100)
    }
    const smooth = frame(15)
    const rough = frame(200)
    expect(dryLanes(rough.calls).length).toBeGreaterThan(5)
    const marks = marksWithClip(rough.calls)
    const later = marks.slice(-BAND_PATHS)
    expect(later.every(m => m.comp === 'multiply' && !m.clipped)).toBe(true)
    expect(shapeOf(rough.paths.slice(-BAND_PATHS))).toEqual(shapeOf(smooth.paths.slice(-BAND_PATHS)))
    // Every save is restored, and the frame ends as it began.
    expect(rough.calls.filter(c => c.op === 'save').length).toBe(rough.calls.filter(c => c.op === 'restore').length)
    expect(rough.calls.at(-1)).toMatchObject({ op: 'set:globalCompositeOperation', args: ['source-over'] })
  })

  test('a smooth band uses no clip at all', () => {
    expect(flick(15).calls.some(c => c.op === 'clip' || c.op === 'save')).toBe(false)
  })

  test('the streaks heal within about a second and a half once the text slows', () => {
    const { c } = flick(200)
    let t = 1100
    let last = Infinity
    while (t < 2600) {
      t += 33
      last = dryLanes(paint([c], t).calls).length
      if (last === 0) break
    }
    expect(last).toBe(0)
    expect(t).toBeGreaterThan(1300)
  })

  test('a jump of the text (a wrap, a voice brought into view) is not a stroke', () => {
    expect(dryLanes(flick(5000).calls)).toHaveLength(0)
  })

  test('a band not painted for a while (the lineage view, a hidden tab) does not come back streaked', () => {
    const c = current(700)
    stage([c])
    paint([c], 1000)
    // A minute of the text's own slow drift, none of it painted.
    c.scroll += 60 * 0.12
    expect(dryLanes(paint([c], 61000).calls)).toHaveLength(0)
  })

  test('the scroll wrapping at the end of a short text is not a stroke', () => {
    const c = current(700, { totalLines: 12, scroll: 0.05 })
    stage([c])
    paint([c], 1000)
    // Dragged back past its start: the scroll jumps by a whole lap, the text by a fraction of a line.
    c.scroll += 12 / 3 - 0.06
    expect(dryLanes(paint([c], 1100).calls)).toHaveLength(0)
  })
})
