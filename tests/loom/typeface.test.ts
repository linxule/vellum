import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { clearCache } from '@chenglou/pretext'
import { initLoom, renderLoom } from '../../src/loom/index.js'
import { refreshLoom, remeasureLoom, threadGroupKey } from '../../src/loom/refresh.js'
import { loomState, resetLoomState } from '../../src/loom/state.js'
import type { Thread } from '../../src/loom/types.js'
import { loadTypeface, stylesheetsIn, within } from '../../src/runtime/fonts.js'
import { CanvasContextStub, installViewport, setMeasuredEm, loadState, makeMouse, makeState, runFrames, withFixedRandom } from './helpers.js'

// The sheet's typeface (runtime/fonts.ts, loom/refresh.ts remeasureLoom): the currents are
// measured in the face they are drawn in, and measured again when it arrives late.

const A = 'so we go on and on as the sea goes by and no one is in a rush to get to the end of it '
const M = 'and yet it is a new day for us all to see what we can do and be and say now '

// The test canvas measures every letter at 0.62 em. A face that arrives late is narrower.
function measureAt(em: number): () => void {
  setMeasuredEm(em)
  // Pretext keeps what it measured: the later test files must not inherit the narrow face.
  return () => { setMeasuredEm(0.62); clearCache() }
}

describe('measured again when the face arrives', () => {
  let restore: (() => void) | null = null
  beforeEach(async () => {
    resetLoomState()
    installViewport(1200, 800)
    await loadState(makeState([
      { family: 'attention', voices: [{ id: 'a0', text: A }, { id: 'a1', text: A }] },
      { family: 'memory', voices: [{ id: 'm0', text: M }, { id: 'm1', text: M }] },
    ], 7100))
    withFixedRandom(0.5, () => initLoom())
  })
  afterEach(() => { restore?.(); restore = null; resetLoomState() })

  const topLine = (t: Thread) => {
    const offset = ((Math.floor(t.scroll * 3) % t.totalLines) + t.totalLines) % t.totalLines
    return offset === 0 ? { segmentIndex: 0, graphemeIndex: 0 } : t.lineEndCursors[offset - 1]!
  }

  test('a rebuild alone keeps the fallback widths; measured again, the lines are the face\'s', () => {
    const t0 = loomState.threads[0]!
    const lines = t0.totalLines
    const width = t0.prepared.widths[0]!
    restore = measureAt(0.5)
    refreshLoom()
    // Pretext keeps the widths it measured: a rebuild does not see the new face.
    expect(loomState.threads[0]!.prepared.widths[0]).toBe(width)
    remeasureLoom()
    const t1 = loomState.threads[0]!
    expect(t1.prepared.widths[0]).toBeCloseTo(width * 0.5 / 0.62, 6)
    expect(t1.totalLines).toBeLessThan(lines)
  })

  test('each current keeps its place, and its text keeps its place in it', () => {
    for (const t of loomState.threads) t.scroll = 17.4
    const before = new Map(loomState.threads.map(t => [threadGroupKey(t.familyNames), { x: t.xCenter, top: topLine(t), sway: [t.freqMult, t.ampMult, t.currentResponse, t.breathRate] }]))
    restore = measureAt(0.5)
    withFixedRandom(0.9, () => remeasureLoom())
    for (const t of loomState.threads) {
      const b = before.get(threadGroupKey(t.familyNames))!
      expect(t.xCenter).toBe(b.x)
      expect([t.freqMult, t.ampMult, t.currentResponse, t.breathRate]).toEqual(b.sway)
      // The new top line begins at or just before the old one's first word: the same place in the text.
      const top = topLine(t)
      expect(top.segmentIndex).toBeLessThanOrEqual(b.top.segmentIndex)
      expect(b.top.segmentIndex - top.segmentIndex).toBeLessThan(16)
    }
  })

  test('the read current keeps its anchored line, which re-wraps around it', () => {
    const ctx = new CanvasContextStub()
    const mouse = makeMouse()
    const attention = loomState.threads.find(t => t.familyNames.includes('attention'))!
    let now = 0
    for (let i = 0; i < 120; i++) {
      const P = attention._path
      mouse.x = P.length > 1 ? P[Math.round(0.5 * (P.length - 1))]!.x : attention.xCenter
      mouse.y = 400
      now = runFrames(renderLoom, ctx as unknown as CanvasRenderingContext2D, mouse, 1, now)
    }
    // (Paper anchors the read; here the anchor is set by hand, as render/thread.ts would.)
    attention._anchor = { cursor: { segmentIndex: 40, graphemeIndex: 0 }, y: 400, scroll: attention.scroll, top: { segmentIndex: 20, graphemeIndex: 0 }, width: 300, prox: 0.8 }
    restore = measureAt(0.5)
    remeasureLoom()
    const next = loomState.threads.find(t => t.familyNames.includes('attention'))!
    expect(next._anchor?.cursor).toEqual({ segmentIndex: 40, graphemeIndex: 0 })
    expect(next._anchor?.y).toBe(400)
    // Its remembered width was the fallback's: forgotten, as on a resize.
    expect(next._anchor?.width).toBe(0)
    expect(next._anchor?.prox).toBe(-1)
  })

  test('before the sheet is built there is nothing to measure', () => {
    resetLoomState()
    expect(() => remeasureLoom()).not.toThrow()
    expect(loomState.threads).toEqual([])
  })
})

describe('runtime/fonts.ts', () => {
  const g = globalThis as any
  let saved: unknown
  beforeEach(() => { saved = g.document })
  afterEach(() => { g.document = saved })

  const fontsWith = (opts: { check: boolean, load?: () => Promise<unknown[]> }) => {
    const calls: string[] = []
    g.document = {
      fonts: {
        check: (font: string, text: string) => { calls.push(`check ${font} ${text}`); return opts.check },
        load: (font: string, text: string) => { calls.push(`load ${font} ${text}`); return opts.load!() },
      },
    }
    return calls
  }

  test('a face that had to load says so; one already in, or none to ask, does not', async () => {
    let calls = fontsWith({ check: false, load: async () => [{}] })
    expect(await loadTypeface('15px X', 'abc')).toBe(true)
    expect(calls).toEqual(['check 15px X abc', 'load 15px X abc'])
    calls = fontsWith({ check: true })
    expect(await loadTypeface('15px X', 'abc')).toBe(false)
    expect(calls).toEqual(['check 15px X abc'])
    fontsWith({ check: false, load: async () => [] })
    expect(await loadTypeface('15px X', 'abc')).toBe(false)
    fontsWith({ check: false, load: () => Promise.reject(new Error('blocked')) })
    expect(await loadTypeface('15px X', 'abc')).toBe(false)
    g.document = {}
    expect(await loadTypeface('15px X', 'abc')).toBe(false)
  })

  test('a wait gives up after its time, and not before', async () => {
    let settle!: (v: string) => void
    const slow = new Promise<string>(r => { settle = r })
    expect(await within(slow, 20, 'late')).toBe('late')
    const quick = within(new Promise<string>(r => setTimeout(() => r('in'), 5)), 200, 'late')
    expect(await quick).toBe('in')
    expect(await within(Promise.reject(new Error('x')), 200, 'late')).toBe('late')
    settle('done')
  })

  test('the face definitions: one already loaded counts, the others are waited for, a failed one too', async () => {
    const listeners: Record<string, Array<() => void>> = {}
    const pending = { sheet: null, addEventListener: (type: string, fn: () => void) => { (listeners[type] ??= []).push(fn) } }
    const loaded = { sheet: {}, addEventListener: () => { throw new Error('not waited for') } }
    g.document = { querySelectorAll: () => [loaded, pending] }
    let done = false
    const p = stylesheetsIn('link[data-face]').then(() => { done = true })
    await new Promise(r => setTimeout(r, 5))
    expect(done).toBe(false)
    listeners.error!.forEach(fn => fn())
    await p
    expect(done).toBe(true)
  })
})
