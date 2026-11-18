import { beforeEach, expect, test } from 'bun:test'
import { layoutNextLine } from '@chenglou/pretext'
import { buildLoomTree, renderLoomTree } from '../../src/loom/loom-view.js'
import { initLoom } from '../../src/loom/init.js'
import { drawLineSegmented } from '../../src/loom/render/line.js'
import { getThreads, loomState, resetLoomState } from '../../src/loom/state.js'
import { aperture } from '../../src/loom/aperture.js'
import { CanvasContextStub, createCanvasContext, installViewport, loadState, makeState } from './helpers.js'

const word = 'ABCDEFGHIJKLMN'
const glyphWidth = 15 * 0.62 // The independent canvas harness's 15px measurement.

beforeEach(async () => {
  resetLoomState()
  installViewport(960, 640)
  await loadState(makeState([{ family: 'attention', voices: [
    { id: 'root', text: word + ' ', depth: 0.4, weave_count: 1 },
    { id: 'child', text: 'child', depth: 0.2, weave_from: 'root' },
  ] }], 103))
})

test('ocean paints per-grapheme advances and public layout agrees on narrow breaks', () => {
  initLoom()
  const thread = getThreads()[0]!
  const segmentIndex = thread.prepared.segments.indexOf(word)
  expect(segmentIndex).toBeGreaterThanOrEqual(0)
  const start = { segmentIndex, graphemeIndex: 0 }
  const line = layoutNextLine(thread.prepared, start, glyphWidth * 3 + 0.01)!
  expect(line.text).toBe('ABC')
  expect(line.width).toBeCloseTo(glyphWidth * 3)
  expect(line.end).toEqual({ segmentIndex, graphemeIndex: 3 })
  const ctx = createCanvasContext()
  drawLineSegmented(ctx, thread, start, line.end, line.text,
    100, 320, 200, line.width, 1, 0, 0, 1, 3, false, true, 100,
    200, 200, 1, 0)
  const calls = (ctx as unknown as CanvasContextStub).fillTextCalls
  expect(calls.map(call => call.text).join('')).toBe('ABC')
  expect(calls[1]!.x - calls[0]!.x).toBeCloseTo(glyphWidth)
  expect(calls[2]!.x - calls[1]!.x).toBeCloseTo(glyphWidth)
})

test('loom paints equally measured letters at equal advances, not cumulative widths', () => {
  const tree = buildLoomTree('root')!
  tree.enteredAt = -10000
  loomState.currentAperture = aperture(960)
  const ctx = createCanvasContext()
  renderLoomTree(ctx, 960, 640, 20000, tree, 1)
  const calls = (ctx as unknown as CanvasContextStub).fillTextCalls.filter(call => /^[A-N]$/.test(call.text))
  expect(calls.map(call => call.text).join('')).toBe(word)
  const fontSize = Number(calls[0]!.font.match(/(\d+)px/)![1])
  for (let i = 1; i < calls.length; i++) {
    expect(calls[i]!.x - calls[i - 1]!.x).toBeCloseTo(fontSize * 0.62)
  }
})

test('LOD: settled far texture lines paint whole words; magnified lines paint per letter', () => {
  initLoom()
  const thread = getThreads()[0]!
  const segmentIndex = thread.prepared.segments.indexOf(word)
  const start = { segmentIndex, graphemeIndex: 0 }
  const end = { segmentIndex: segmentIndex + 1, graphemeIndex: 0 }
  const draw = (proximity: number, diveT: number) => {
    const ctx = createCanvasContext()
    drawLineSegmented(ctx, thread, start, end, word,
      300, 320, 400, glyphWidth * word.length, 1, proximity, 0, 1, 3, false, true, -9999,
      200, 200, 1, 0, diveT)
    return (ctx as unknown as CanvasContextStub).fillTextCalls
  }
  // Settled lens (proximity 1 → shimmer damped to sub-pixel), line not magnified.
  const far = draw(1, 0)
  expect(far.map(c => c.text)).toEqual([word])
  // Same line inside the magnified band keeps per-letter painting.
  const near = draw(1, 0.8)
  expect(near.map(c => c.text).join('')).toBe(word)
  expect(near.length).toBe(word.length)
  // Lens still opening (low proximity → visible shimmer) keeps per-letter painting.
  expect(draw(0.2, 0).length).toBe(word.length)
})
