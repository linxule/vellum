import { beforeEach, expect, test } from 'bun:test'
import { layoutNextLineRange, prepareWithSegments, walkLineRanges, type LayoutCursor } from '@chenglou/pretext'
import { initLoom, resizeLoom } from '../../src/loom/init.js'
import { renderLoom } from '../../src/loom/render/frame.js'
import { getThreads, resetLoomState } from '../../src/loom/state.js'
import { lineEndsWholeWords, wholeWordWidth } from '../../src/loom/text.js'
import { FONT, WHOLE_WORD_MAX_LAYOUT_W } from '../../src/loom/types.js'
import { CanvasContextStub, createCanvasContext, installViewport, loadState, makeState, runFrames } from './helpers.js'

// The canvas stub measures every glyph at 0.62em, so at the 15px layout font a
// word is 9.3 units per letter: 'announcements' is 120.9 (under the 123 cap),
// and a 390px viewport's resting column lays out at ~73 units (7 letters).
const LONG = 'announcements'
const URL = 'https://example.dev/run/f13cef36-226b'
const NARROW = 73

beforeEach(() => {
  resetLoomState()
  installViewport(390, 800)
})

function prepare(text: string) {
  return prepareWithSegments(text, FONT, { whiteSpace: 'pre-wrap' })
}

test('plain Pretext splits a long word at a phone-width column (the bug this guards)', () => {
  const prepared = prepare(`the ${LONG} stay `)
  const start: LayoutCursor = { segmentIndex: prepared.segments.indexOf(LONG), graphemeIndex: 0 }
  const line = layoutNextLineRange(prepared, NARROW, { ...start })!
  expect(line.end.segmentIndex).toBe(start.segmentIndex)
  expect(line.end.graphemeIndex).toBeGreaterThan(0)
  expect(wholeWordWidth(prepared, start, line.end, NARROW)).toBeGreaterThan(prepared.widths[start.segmentIndex]!)
})

test('lineEndsWholeWords never ends a line inside a word that fits the cap', () => {
  const prepared = prepare(`the ${LONG} stay whole. ${LONG} again `.repeat(4))
  const ends = lineEndsWholeWords(prepared, NARROW)
  expect(ends.length).toBeGreaterThan(8)
  expect(ends.every(end => end.graphemeIndex === 0)).toBe(true)
})

test('a word wider than the cap (a URL) still wraps, and the walk terminates', () => {
  const prepared = prepare(`see ${URL} now `)
  // Pretext 1.0.0 follows the browser and allows a break after a hyphen, so the URL is two
  // segments ("…f13cef36-" and "226b"); its first part alone is still wider than the cap.
  const urlStart = prepared.segments.findIndex(segment => segment.startsWith('https://'))
  expect(prepared.widths[urlStart]!).toBeGreaterThan(WHOLE_WORD_MAX_LAYOUT_W)
  const ends = lineEndsWholeWords(prepared, NARROW)
  expect(ends.some(end => end.graphemeIndex > 0)).toBe(true)
  expect(ends[ends.length - 1]!.segmentIndex).toBe(prepared.segments.length)
})

test('text with no over-wide word lays out exactly as walkLineRanges does', () => {
  for (const width of [NARROW, 123.4, 300]) {
    const prepared = prepare('It is not a thing you aim. 有人在这里留下了一句话。 It is what stays on. '.repeat(6))
    const expected: LayoutCursor[] = []
    walkLineRanges(prepared, width, line => { expected.push({ ...line.end }) })
    expect(lineEndsWholeWords(prepared, width)).toEqual(expected)
  }
})

test('the ocean paints long words whole at phone width, and resize keeps them whole', async () => {
  await loadState(makeState([{ family: 'attention', voices: [
    { id: 'a', text: `the present moment needs no ${LONG} here`, depth: 0.3 },
    { id: 'b', text: `every thought begins as a question about ${LONG}`, depth: 0.3 },
  ] }], 301))
  initLoom()
  const check = () => {
    for (const thread of getThreads()) expect(thread.lineEndCursors.every(end => end.graphemeIndex === 0)).toBe(true)
    const ctx = createCanvasContext()
    runFrames(renderLoom, ctx, { x: -9999, y: -9999, vx: 0, vy: 0, down: false }, 3)
    const painted = (ctx as unknown as CanvasContextStub).fillTextCalls.map(call => call.text.trim())
    expect(painted.filter(text => text.includes(LONG)).length).toBeGreaterThan(0)
    // Every fragment of the word that reaches the canvas is the whole word.
    const fragments = painted.filter(text => /^(announ|ncements|cements|ements|ments)/.test(text) || /(announ|announc|announce|announcem)$/.test(text))
    expect(fragments.every(text => text.includes(LONG))).toBe(true)
  }
  check()
  installViewport(606, 800)
  resizeLoom()
  check()
})
