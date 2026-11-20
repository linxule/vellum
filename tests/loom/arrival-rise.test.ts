import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { initLoom, refreshLoom, renderLoom, risingPoint } from '../../src/loom/index.js'
import { threadColor, underPaper } from '../../src/loom/color.js'
import { enablePaper, paper, PAPER_RGB, resetPaperForTest } from '../../src/loom/paper.js'
import { pathXAtY } from '../../src/loom/path.js'
import { resetWashForTest } from '../../src/loom/render/wash.js'
import { RISE_MS } from '../../src/loom/render/thread.js'
import { loomState, resetLoomState } from '../../src/loom/state.js'
import { cursorAt, placeOf } from '../../src/loom/text.js'
import type { Thread } from '../../src/loom/types.js'
import { CanvasContextStub, installViewport, loadState, makeMouse, makeState, withFixedRandom } from './helpers.js'

// On paper an ordinary arrival (a voice into a current that already has others)
// surfaces by its own lines only: they rise from the paper's colour into their
// ink, line by line (render/thread.ts), and nothing already on the sheet moves,
// glows or changes depth (refresh.ts).

const VW = 960
const VH = 640
const words = (p: string, n: number) => Array.from({ length: n }, (_, i) => `${p}${i}`).join(' ') + ' '

let ctx: CanvasContextStub
let mouse: ReturnType<typeof makeMouse>
let now = 1000

const before = [{ id: 'a0', text: words('a', 120) }, { id: 'a1', text: words('b', 300) }]
const memory = { family: 'memory', voices: [{ id: 'm0', text: words('m', 300) }] }

async function sheet(on: boolean): Promise<void> {
  resetLoomState(); resetPaperForTest(); resetWashForTest()
  installViewport(VW, VH)
  await loadState(makeState([{ family: 'attention', voices: before }, memory], 9600))
  if (on) enablePaper()
  withFixedRandom(0.5, () => initLoom())
  ctx = new CanvasContextStub()
  mouse = makeMouse()
  now = 1000
  // The end of a0 near the top of the sheet: where the arrival comes in.
  attention().scroll = 50 / 3
  attention().scrollVel = 0
  frames(6)
}

function frames(n: number, each?: () => void): void {
  for (let i = 0; i < n; i++) {
    ctx.fillTextCalls = []
    ctx.clipCalls = []
    renderLoom(ctx as unknown as CanvasRenderingContext2D, VW, VH, now, 0.016, mouse)
    now += 16
    each?.()
  }
}

const attention = (): Thread => loomState.threads.find(t => t.familyNames.includes('attention'))!

/**
 * A voice arrives in the attention current (after a0 by default). The lens is not
 * sent to it: refresh.ts steers neither the scroll nor the lens while the reader
 * holds a current open, as it does when the reader is elsewhere.
 */
async function arrive(voices = [before[0]!, { id: 'n0', text: words('n', 60) }, before[1]!], random = 0.5): Promise<void> {
  await loadState(makeState([{ family: 'attention', voices }, memory], 9601))
  const reading = loomState.readingKey
  if (reading === null) loomState.readingKey = 'elsewhere'
  withFixedRandom(random, () => refreshLoom([{ hasNew: true, newIds: new Set(['n0']) }, { hasNew: false, newIds: new Set() }], now))
  loomState.readingKey = reading
}

const rgba = (fill: unknown) => String(fill).match(/[\d.]+/g)!.map(Number)
const fromPaper = (fill: unknown) => { const c = rgba(fill); return Math.abs(c[0]! - PAPER_RGB[0]!) + Math.abs(c[1]! - PAPER_RGB[1]!) + Math.abs(c[2]! - PAPER_RGB[2]!) }

/** The attention current's lines this frame, top to bottom: their text and fills. */
function lines(): { y: number, text: string, fills: string[] }[] {
  const t = attention()
  const by = new Map<number, { y: number, text: string, fills: string[] }>()
  for (const c of ctx.fillTextCalls) {
    if (!/^[abn0-9 ]+$/.test(c.text) || Math.abs(c.x - pathXAtY(t._path, c.y)) > 200) continue
    const y = Math.round(c.y * 10) / 10
    const line = by.get(y) ?? { y, text: '', fills: [] }
    line.text += c.text
    line.fills.push(String(c.fillStyle))
    by.set(y, line)
  }
  return [...by.values()].sort((p, q) => p.y - q.y)
}
const only = (prefix: string) => (l: { text: string }) => l.text.trim().split(/\s+/).every(w => w.startsWith(prefix))
const mixed = (l: { text: string }) => /\bn\d/.test(l.text) && /\ba\d/.test(l.text)

afterEach(() => resetPaperForTest())

describe('colour: a line still under the paper', () => {
  afterEach(() => resetPaperForTest())

  test('underPaper mixes toward the paper by how far under it lies', () => {
    enablePaper()
    const ink: [number, number, number] = [40, 30, 20]
    expect(underPaper([...ink] as [number, number, number], 0)).toEqual(ink)
    expect(underPaper([...ink] as [number, number, number], 1)).toEqual([...PAPER_RGB] as [number, number, number])
    const half = underPaper([...ink] as [number, number, number], 0.5)
    for (let i = 0; i < 3; i++) expect(Math.abs(half[i]! - (ink[i]! + PAPER_RGB[i]!) / 2)).toBeLessThanOrEqual(1)
  })

  test('threadColor on paper follows lineFaint; the old look ignores it', () => {
    const base = [60, 70, 140]
    enablePaper()
    const plain = [...threadColor(base, 0.8, 0)]
    paper.lineFaint = 1
    expect([...threadColor(base, 0.8, 0)]).toEqual([...PAPER_RGB])
    paper.lineFaint = 0
    expect([...threadColor(base, 0.8, 0)]).toEqual(plain)
    resetPaperForTest()
    const sea = [...threadColor(base, 0.8, 0)]
    paper.lineFaint = 1
    expect([...threadColor(base, 0.8, 0)]).toEqual(sea)
    paper.lineFaint = 0
  })
})

describe('on paper, an arrival rises line by line and nothing else changes', () => {
  beforeEach(async () => { await sheet(true) })

  test('the current keeps its glow, its depth and its words; only the new lines are faint', async () => {
    const t0 = attention()
    const depth = t0.restingDepth
    const old = lines().filter(only('a'))
    expect(old.length).toBeGreaterThan(3)
    await arrive()
    const t = attention()
    expect(t.arrivalGlow).toBe(0)
    expect(t.emergenceDepthFrom).toBe(-1)
    frames(1)
    // Every resting line of a0 above the new voice reads and prints as it did.
    const now1 = lines()
    for (const l of old) {
      const same = now1.find(n => Math.abs(n.y - l.y) < 1.5)
      expect(same?.text).toBe(l.text)
      const [r, g, b, a] = rgba(same!.fills[0])
      const [r0, g0, b0, a0] = rgba(l.fills[0])
      expect([r, g, b]).toEqual([r0, g0, b0])
      expect(Math.abs(a! - a0!)).toBeLessThan(0.02)
    }
    frames(300)
    expect(attention().restingDepth).toBe(depth)
  })

  test('the new voice rises from the paper into its ink, its first line before its later ones', async () => {
    const t0 = attention()
    await arrive()
    frames(1)
    const first = lines().filter(only('n'))
    expect(first.length).toBeGreaterThan(3)
    const startTop = fromPaper(first[0]!.fills[0])
    // Partway: the top line has risen further than a line four below it.
    frames(Math.round(900 / 16))
    const mid = lines().filter(only('n'))
    expect(fromPaper(mid[0]!.fills[0])).toBeGreaterThan(startTop)
    expect(fromPaper(mid[0]!.fills[0])).toBeGreaterThan(fromPaper(mid[4]!.fills[0]))
    // Risen: as dark as the voice's own ink at rest (the same as an a0 line's).
    frames(Math.round((5000 + RISE_MS) / 16))
    const done = lines()
    const n = done.filter(only('n'))
    const a = done.filter(only('a'))
    expect(rgba(n[0]!.fills[0]).slice(0, 3)).toEqual(rgba(a[0]!.fills[0]).slice(0, 3))
    expect(fromPaper(n[0]!.fills[0])).toBeGreaterThan(startTop * 2)
    expect(t0).not.toBe(attention())
  })

  test('a line shared with an older voice is printed twice, clipped: the old words at full ink', async () => {
    await arrive()
    frames(1)
    const shared = lines().find(mixed)
    expect(shared).toBeDefined()
    const ink = lines().find(only('a'))!.fills[0]!
    // One pass at the line's own ink (clipped to the old words), one faint (clipped to the new).
    expect(shared!.fills.some(f => rgba(f).slice(0, 3).join() === rgba(ink).slice(0, 3).join())).toBe(true)
    expect(shared!.fills.some(f => fromPaper(f) < fromPaper(ink) * 0.5)).toBe(true)
    expect(ctx.clipCalls.length).toBeGreaterThanOrEqual(2)
  })

  test('where it rises is known while it rises, so its rings can fall there', async () => {
    await arrive()
    frames(2)
    const p = risingPoint('n0', now)
    expect(p).not.toBeNull()
    const top = lines().find(only('n'))!
    expect(Math.abs(p!.y - top.y)).toBeLessThan(20)
    expect(risingPoint('a0', now)).toBeNull()
    frames(Math.round(5600 / 16))
    expect(risingPoint('n0', now)).toBeNull()
  })

  test('a resting column keeps its top line when a voice arrives above it, and its wash does not move', async () => {
    const t0 = attention()
    t0.scroll = 40 / 3
    frames(1)
    const topBefore = lines().find(l => l.y > 0)!.text
    const scrollBefore = t0.scroll
    await arrive([{ id: 'n0', text: words('n', 60) }, ...before])
    const t = attention()
    // Renumbered, not moved: the scroll index jumps by the inserted lines, and the
    // wash, which rides scroll - _scrollBase, stays where it was.
    expect(t.scroll).toBeGreaterThan(scrollBefore + 1)
    expect(t.scroll - (t._scrollBase ?? 0)).toBeCloseTo(scrollBefore, 6)
    frames(1)
    // Its top line begins with the same word. (The text after an arriving voice
    // flows on from it, so a line can gain or lose a word at its start.)
    expect(lines().find(l => l.y > 0)!.text.split(' ')).toContain(topBefore.split(' ')[0]!)
  })

  test('a rebuild keeps each current\'s shape: path, sway and pace', async () => {
    const t0 = attention()
    const path = t0._path.map(p => p.x)
    const shape = [t0.freqMult, t0.ampMult, t0.currentResponse, t0.breathRate]
    await arrive(undefined, 0.9)
    const t = attention()
    expect([t.freqMult, t.ampMult, t.currentResponse, t.breathRate]).toEqual(shape)
    expect(t._path.map(p => p.x)).toEqual(path)
  })
})

describe('the read line keeps its words when a voice arrives in its current', () => {
  beforeEach(async () => { await sheet(true) })

  function hold(y: number): void {
    const t = attention()
    mouse.x = pathXAtY(t._path, y); mouse.y = y; mouse.prevX = mouse.x; mouse.prevY = y
  }
  const at = (y: number) => lines().filter(l => Math.abs(l.y - y) < 1.5).map(l => l.text.replace(/ /g, '')).join('')

  test('an arrival above the read line inserts text without moving it', async () => {
    attention().scroll = 60 / 3
    frames(200, () => hold(300))
    const anchor = attention()._anchor!
    const read = at(anchor.y)
    expect(read).toMatch(/^b/)
    await arrive([{ id: 'n0', text: words('n', 60) }, ...before])
    expect(attention()._anchor).toBeDefined()
    frames(30, () => hold(300))
    expect(at(anchor.y)).toBe(read)
  })

  test('a voice in and a voice out that leave as many pieces as before still move the text: the read line keeps its words', async () => {
    attention().scroll = 60 / 3
    frames(200, () => hold(300))
    const anchor = attention()._anchor!
    const read = at(anchor.y)
    expect(read).toMatch(/^b/)
    const pieces = attention().prepared.segments.length
    // 60 words in above the read voice, a0's 120 out, 60 in below: the count is as it was, every index is not.
    await arrive([{ id: 'n0', text: words('n', 60) }, before[1]!, { id: 'n1', text: words('n', 60) }])
    expect(attention().prepared.segments.length).toBe(pieces)
    expect(attention()._anchor).toBeDefined()
    frames(30, () => hold(300))
    expect(at(anchor.y)).toBe(read)
  })

  test('a voice is found again by its words, even when the arrival repeats its text', async () => {
    // The reader is in the second "x" voice; the arrival is a third "x", placed first.
    const x = words('x', 50)
    await loadState(makeState([{ family: 'attention', voices: [{ id: 'x0', text: x }, { id: 'b0', text: words('b', 50) }, { id: 'x1', text: x }] }, memory], 9700))
    withFixedRandom(0.5, () => initLoom())
    const old = attention()
    const s = old.segVoiceUid.indexOf(2) + 6
    const place = placeOf(old, { segmentIndex: s, graphemeIndex: 0 })!
    expect(place).not.toBeNull()
    await loadState(makeState([{ family: 'attention', voices: [{ id: 'n0', text: x }, { id: 'x0', text: x }, { id: 'b0', text: words('b', 50) }, { id: 'x1', text: x }] }, memory], 9701))
    withFixedRandom(0.5, () => initLoom())
    const next = attention()
    const found = cursorAt(next, place)!
    expect(next.segVoiceUid[found.segmentIndex]).toBe(3)
    expect(next.prepared.segments[found.segmentIndex]).toBe(old.prepared.segments[s])
  })
})

describe('the old look is unchanged', () => {
  beforeEach(async () => { await sheet(false) })

  test('the current glows and eases to its depth; the scroll index is kept as it was', async () => {
    attention().scroll = 40 / 3
    const scroll = attention().scroll
    await arrive([{ id: 'n0', text: words('n', 60) }, ...before])
    const t = attention()
    expect(t.arrivalGlow).toBe(1)
    expect(t.emergenceDepthFrom).toBe(t.restingDepth)
    expect(t.scroll).toBe(scroll)
    expect(t._scrollBase).toBeUndefined()
    expect(risingPoint('n0', now)).toBeNull()
  })
})
