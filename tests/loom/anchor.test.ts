import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { layoutNextLine, prepareWithSegments } from '@chenglou/pretext'
import { initLoom, refreshLoom, renderLoom } from '../../src/loom/index.js'
import { enablePaper, resetPaperForTest } from '../../src/loom/paper.js'
import { pathXAtY } from '../../src/loom/path.js'
import { scrollThreadToVoice } from '../../src/loom/scroll.js'
import { resetWashForTest } from '../../src/loom/render/wash.js'
import { loomState, resetLoomState } from '../../src/loom/state.js'
import { compareCursors, lineEndingAt } from '../../src/loom/text.js'
import { aperture } from '../../src/loom/aperture.js'
import { WHOLE_WORD_MAX_LAYOUT_W, type Thread } from '../../src/loom/types.js'
import { CanvasContextStub, installViewport, loadState, makeMouse, makeState, withFixedRandom } from './helpers.js'

// The text being read stays still (render/thread.ts, thread._anchor): on paper the
// read current is laid out from the reading line outward, so the words under the
// lens keep their place while the lens opens, while it closes and while the lines
// breathe. The reader's own scrolling moves them, line for line.

const VW = 420
const VH = 912
const words = (p: string, n: number) => Array.from({ length: n }, (_, i) => `${p}${i}`).join(' ') + ' '

let ctx: CanvasContextStub
let mouse: ReturnType<typeof makeMouse>
let now = 1000
let attention: Thread

async function sheet(paper: boolean): Promise<void> {
  resetLoomState(); resetPaperForTest(); resetWashForTest()
  installViewport(VW, VH)
  await loadState(makeState([
    { family: 'attention', voices: [{ id: 'a0', text: words('a', 400) }, { id: 'a1', text: words('b', 400) }] },
    { family: 'memory', voices: [{ id: 'm0', text: words('m', 400) }] },
  ], 9400))
  if (paper) enablePaper()
  withFixedRandom(0.5, () => initLoom())
  ctx = new CanvasContextStub()
  mouse = makeMouse()
  now = 1000
  frames(6)
  attention = loomState.threads.find(t => t.familyNames.includes('attention'))!
}

function frames(n: number, each?: () => void): void {
  for (let i = 0; i < n; i++) {
    ctx.fillTextCalls = []
    renderLoom(ctx as unknown as CanvasRenderingContext2D, VW, VH, now, 0.016, mouse)
    now += 16
    each?.()
  }
}

function hold(y: number): void {
  mouse.x = pathXAtY(attention._path, y); mouse.y = y; mouse.prevX = mouse.x; mouse.prevY = y
}

function leave(): void {
  mouse.x = -9e3; mouse.y = -9e3; mouse.prevX = -9e3; mouse.prevY = -9e3
}

/** The words printed on the line at y, in the attention current, left to right. */
function textAt(y: number): string {
  const x = pathXAtY(attention._path, y)
  return ctx.fillTextCalls
    .filter(c => Math.abs(c.y - y) < 1.5 && Math.abs(c.x - x) < 250 && /^[ab0-9 ]+$/.test(c.text))
    .sort((p, q) => p.x - q.x).map(c => c.text.replace(/ /g, '')).join('')
}

afterEach(() => resetPaperForTest())

describe('lineEndingAt: a line laid out backwards', () => {
  const text = words('a', 60) + '这是一个非常缓慢的合唱。この場所の美しさは、誰のものでもない 빛은 기억을 비추지만 long-word here.'
  let prepared: ReturnType<typeof prepareWithSegments>
  beforeEach(() => { installViewport(400, 800); prepared ??= prepareWithSegments(text, '400 15px serif') })

  for (const width of [40, 70, 130]) {
    test(`walking back from the end at ${width} units rebuilds the text, every line fitting its width`, () => {
      installViewport(400, 800)
      let end = { segmentIndex: prepared.segments.length, graphemeIndex: 0 }
      const parts: string[] = []
      for (let i = 0; i < 400; i++) {
        const line = lineEndingAt(prepared, width, end)
        if (!line) break
        parts.unshift(line.text)
        const forward = layoutNextLine(prepared, Math.max(width, line.width), { ...line.start })
        expect(forward).not.toBeNull()
        // It fits: forwards, Pretext would not break it before its end. (A line can be
        // shorter than a forward one: laid out backwards, the ragged line is the top one.)
        expect(compareCursors(forward!.end, end)).toBeGreaterThanOrEqual(0)
        end = line.start
      }
      expect(end).toEqual({ segmentIndex: 0, graphemeIndex: 0 })
      expect(parts.join('')).toBe(text)
    })
  }

  test('at the very start of the text there is no line before', () => {
    expect(lineEndingAt(prepared, 100, { segmentIndex: 0, graphemeIndex: 0 })).toBeNull()
  })

  // Voices keep their own line breaks and spaces (the thread is prepared pre-wrap), and may hold a URL.
  const awkward: Record<string, string> = {
    'line breaks, and an empty line': 'one two three\nfour five six seven eight nine\n\nten eleven twelve thirteen. ',
    'a word far wider than any line': 'short words then https://example.com/a/very/long/unbroken/path/that/goes/on/and/on/and/on/for/several/lines/of/a/narrow/column/indeed and after ',
    'runs of spaces, from the first letter on': '   leading spaces and  double  spaces    inside and trailing   ',
    'tabs': 'a\tb\tc tabbed\ttext with\ttabs here and there ',
  }
  for (const [name, awkwardText] of Object.entries(awkward)) {
    for (const width of [70, 130, 200]) {
      test(`${name}, at ${width} units: every line fits forwards, none crosses a line break, and the text is whole`, () => {
        installViewport(400, 800)
        const p = prepareWithSegments(awkwardText, '400 15px serif', { whiteSpace: 'pre-wrap' })
        let end = { segmentIndex: p.segments.length, graphemeIndex: 0 }
        const parts: string[] = []
        for (let i = 0; i < 400; i++) {
          const line = lineEndingAt(p, width, end)
          if (!line) break
          parts.unshift(line.text)
          expect(compareCursors(line.start, end)).toBeLessThan(0)
          // A whole word may run wide (wholeWordWidth); nothing wider than that does.
          expect(line.width).toBeLessThanOrEqual(Math.max(width, WHOLE_WORD_MAX_LAYOUT_W) + 0.01)
          const forward = layoutNextLine(p, Math.max(width, line.width), { ...line.start })
          expect(forward).not.toBeNull()
          expect(compareCursors(forward!.end, end)).toBeGreaterThanOrEqual(0)
          // No break in the text inside the line (its own, at its end, is the last segment).
          for (let s = line.start.segmentIndex; s < end.segmentIndex - 1; s++) expect(p.kinds[s]).not.toBe('hard-break')
          end = line.start
        }
        expect(end).toEqual({ segmentIndex: 0, graphemeIndex: 0 })
        expect(parts.join('')).toBe(awkwardText.replace(/\n/g, ''))
      })
    }
  }
})

describe('on paper, the words under the lens stay put', () => {
  beforeEach(async () => { await sheet(true) })

  test('opening: from the first frame the lens touches the current, the line at the lens reads the same', () => {
    const y = 400
    hold(y)
    frames(1)
    const anchorY = attention._anchor!.y
    expect(Math.abs(anchorY - y)).toBeLessThan(aperture(VW, VH).textureLineH)
    const cursor = { ...attention._anchor!.cursor }
    const seen: string[] = []
    let settledY = NaN
    frames(100, () => {
      hold(y)
      seen.push(textAt(anchorY))
      // The same line from the first frame. Until the current is held (proximity
      // 0.1) it still flows, and the line with it, by a fraction of a pixel.
      expect(attention._anchor!.cursor).toEqual(cursor)
      expect(Math.abs(attention._anchor!.y - anchorY)).toBeLessThan(0.5)
      if (attention.touched && Number.isNaN(settledY)) settledY = attention._anchor!.y
    })
    const read = seen[seen.length - 1]!
    expect(read.length).toBeGreaterThan(0)
    // The line keeps its first word from the start and only gains words as it
    // widens (re-wrapping around it is allowed); it never drops one and gets it back.
    const drawn = seen.filter(t => t.length > 0)
    expect(drawn.length).toBeGreaterThan(60)
    for (let i = 0; i < drawn.length; i++) {
      expect(read.startsWith(drawn[i]!)).toBe(true)
      if (i > 0) expect(drawn[i]!.length).toBeGreaterThanOrEqual(drawn[i - 1]!.length)
    }
    expect(attention._anchor!.y).toBeCloseTo(settledY, 6)
  })

  test('a still pointer for 16 s: breath and current keep running, the words do not move', () => {
    const y = 400
    hold(y)
    frames(120, () => hold(y))
    const anchorY = attention._anchor!.y
    const read = textAt(anchorY)
    expect(read.length).toBeGreaterThan(4)
    const cursor = { ...attention._anchor!.cursor }
    const seen = new Set<string>()
    frames(1000, () => { hold(y); seen.add(textAt(anchorY)) })
    expect([...seen]).toEqual([read])
    expect(attention._anchor!.cursor).toEqual(cursor)
    expect(attention._anchor!.y).toBeCloseTo(anchorY, 6)
  })

  test('closing: the line that was read keeps its words while it shrinks back', () => {
    const y = 400
    frames(200, () => hold(y))
    const anchorY = attention._anchor!.y
    const cursor = { ...attention._anchor!.cursor }
    const first = textAt(anchorY).match(/^[ab]\d+/)![0]
    leave()
    let printed = 0
    for (let i = 0; i < 300; i++) {
      frames(1)
      expect(attention._anchor?.cursor).toEqual(cursor)
      expect(attention._anchor!.y).toBeCloseTo(anchorY, 6)
      const read = textAt(anchorY)
      if (read.length > 0) { printed++; expect(read.startsWith(first)).toBe(true) }
    }
    expect(attention.proximity).toBeLessThan(0.05)
    expect(printed).toBeGreaterThan(250)
  })

  test('the reader scrolling moves the words line for line; a jump to a voice lets go', () => {
    const y = 400
    frames(200, () => hold(y))
    const before = { ...attention._anchor! }
    const ap = aperture(VW, VH)
    // Two resting lines' worth of scroll, as a drag does.
    attention.scroll -= 2 / 3
    frames(1, () => hold(y))
    expect(attention._anchor!.cursor).not.toEqual(before.cursor) // re-caught at the line now under the lens
    attention.scroll += 40 / 3
    frames(1, () => hold(y))
    // A jump is not reading: the scroll keeps it, and the anchor starts over where the lens is now.
    expect(attention._anchor).toBeDefined()
    expect(Math.abs(attention._anchor!.y - y)).toBeLessThan(ap.diveLineH)
  })

  test('a short jump to a voice, just after the lens left, is kept (the anchor does not pull the text back)', () => {
    const y = 400
    frames(200, () => hold(y))
    leave()
    frames(30)
    // Still held in place: a current stays touched for a while after the lens leaves it.
    expect(attention._anchor).toBeDefined()
    const idx = loomState.threads.indexOf(attention)
    const was = attention.scroll
    // A jump of a few lines: under the 12-line threshold that tells a jump from reading.
    attention.scroll = was + 2
    scrollThreadToVoice(idx, 'a0')
    const jumped = attention.scroll
    expect(attention._anchor).toBeUndefined()
    frames(1)
    expect(Math.abs(attention.scroll - jumped)).toBeLessThan(0.2)
  })

  test('an arriving voice begins at the lens line and stays there: the lens does not chase it', async () => {
    // The old look steers the lens to wherever the arriving voice's line lies, and that line
    // moves when the lens does. With an anchor opening upward it ran off the sheet and the lens
    // swung after it for the whole hold (seen on a desktop with the mouse resting on the page).
    await loadState(makeState([
      { family: 'attention', voices: [{ id: 'a0', text: words('a', 400) }, { id: 'n0', text: words('n', 90) }, { id: 'a1', text: words('b', 400) }] },
      { family: 'memory', voices: [{ id: 'm0', text: words('m', 400) }] },
    ], 9500))
    withFixedRandom(0.5, () => refreshLoom([{ hasNew: true, newIds: new Set(['n0']) }, { hasNew: false, newIds: new Set() }], now))
    attention = loomState.threads.find(t => t.familyNames.includes('attention'))!
    const focus = loomState.phantomFocus!
    expect(focus).not.toBeNull()
    const ys: number[] = []
    const read: string[] = []
    frames(400, () => {
      const anchor = attention._anchor!
      expect(anchor).toBeDefined()
      expect(attention.prepared.segments[anchor.cursor.segmentIndex]).toBe('n0')
      expect(focus.capturedY).toBe(anchor.y)
      ys.push(mouse.y)
      // Under the lens the line is printed letter by letter.
      if (attention.proximity > 0.5) read.push(ctx.fillTextCalls.filter(c => Math.abs(c.y - anchor.y) < 1.5).sort((p, q) => p.x - q.x).map(c => c.text.replace(/ /g, '')).join('').slice(0, 4))
    })
    // The lens stood still, in the middle of the sheet, on the voice's first words.
    expect(Math.max(...ys) - Math.min(...ys)).toBeLessThan(1)
    expect(Math.abs(mouse.y - VH / 2)).toBeLessThan(VH * 0.1)
    expect(new Set(read)).toEqual(new Set(['n0n1']))
    expect(attention.proximity).toBeGreaterThan(0.9)
  })

  test('the anchor follows a drag exactly: scroll by k resting lines moves the read line by k reading lines', () => {
    const y = 400
    frames(200, () => hold(y))
    const a = attention._anchor!
    const startY = a.y
    const startCursor = { ...a.cursor }
    const ap = aperture(VW, VH)
    leave() // no lens: the anchor is not re-caught, only moved
    attention.touched = true
    attention.scroll -= 1 / 3
    frames(1)
    expect(attention._anchor!.cursor).toEqual(startCursor)
    expect(attention._anchor!.y).toBeCloseTo(startY + ap.diveLineH, 6)
  })

  test('handing back to the scroll is seamless: the top line keeps its words and place', () => {
    frames(200, () => hold(400))
    leave()
    let last = ''
    for (let i = 0; i < 2000 && attention._anchor; i++) {
      frames(1)
      if (attention._anchor) last = topLine()
    }
    expect(attention._anchor).toBeUndefined()
    expect(topLine()).toBe(last)
  })

  test('the current being read holds its place sideways too; a current at rest keeps moving', () => {
    const y = 400
    frames(200, () => hold(y))
    const memory = loomState.threads.find(t => t.familyNames.includes('memory'))!
    const readX = pathXAtY(attention._path, y)
    const restX = pathXAtY(memory._path, y)
    let readMoved = 0
    frames(1000, () => { hold(y); readMoved = Math.max(readMoved, Math.abs(pathXAtY(attention._path, y) - readX)) })
    expect(readMoved).toBeLessThan(0.5)
    expect(Math.abs(pathXAtY(memory._path, y) - restX)).toBeGreaterThan(1)
  })

  test('a new state arriving while a current is read keeps its words where they are', () => {
    const y = 400
    frames(200, () => hold(y))
    const anchorY = attention._anchor!.y
    const read = textAt(anchorY)
    const x = pathXAtY(attention._path, y)
    withFixedRandom(0.5, () => refreshLoom(undefined, now))
    attention = loomState.threads.find(t => t.familyNames.includes('attention'))!
    frames(30, () => hold(y))
    expect(textAt(anchorY)).toBe(read)
    expect(Math.abs(pathXAtY(attention._path, y) - x)).toBeLessThan(0.5)
  })

  function topLine(): string {
    const x = attention._path[0]!.x
    const calls = ctx.fillTextCalls.filter(c => c.y >= -2 && Math.abs(c.x - x) < 120 && /^[ab0-9]+$/.test(c.text))
    const top = Math.min(...calls.map(c => c.y))
    return calls.filter(c => Math.abs(c.y - top) < 1.5).map(c => c.text).join('')
  }
})

test('the old look never anchors', async () => {
  await sheet(false)
  frames(300, () => hold(400))
  leave()
  frames(100)
  expect(attention._anchor).toBeUndefined()
})
