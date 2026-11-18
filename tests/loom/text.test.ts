import { expect, test } from 'bun:test'
import { layoutNextLineRange, prepareWithSegments } from '@chenglou/pretext'
import { scriptClass, containsRTL, isLineRTL, letterAdvances, measureLetterAdvances, graphemeSegmenter, voiceUidAtCursor, voiceGroupIndex, voiceSpanForLine } from '../../src/loom/text.js'
import { FONT } from '../../src/loom/types.js'
import { installViewport } from './helpers.js'

const stubThread = {
  segVoiceUid: [0, 0, 1, 2],
  groupBoundaries: [2, 3],
  prepared: {
    segments: ['alpha', 'beta', 'gamma', 'delta'],
  },
} as any

test('scriptClass identifies latin, cjk, arabic, and indic samples', () => {
  expect(scriptClass('A')).toBe(0)
  expect(scriptClass('静')).toBe(1)
  expect(scriptClass('ش')).toBe(2)
  expect(scriptClass('म')).toBe(3)
})

test('containsRTL differentiates LTR and RTL strings', () => {
  expect(containsRTL('hello world')).toBe(false)
  expect(containsRTL('مرحبا بالعالم')).toBe(true)
})

test('voiceUidAtCursor and voiceGroupIndex map fixture segments correctly', () => {
  expect(voiceUidAtCursor(stubThread, { segmentIndex: 2, graphemeIndex: 0 })).toBe(1)
  expect(voiceGroupIndex(stubThread, 0)).toBe(0)
  expect(voiceGroupIndex(stubThread, 2)).toBe(1)
})

test('voiceSpanForLine returns anchor UID and unique UIDs for a span', () => {
  const span = voiceSpanForLine(stubThread, { segmentIndex: 1, graphemeIndex: 0 }, { segmentIndex: 3, graphemeIndex: 0 })
  expect(span.anchorUid).toBe(1)
  expect(span.uids).toEqual([0, 1])
})

test('scriptClass returns 0 (latin) for whitespace, punctuation, and ASCII digits', () => {
  expect(scriptClass(' ')).toBe(0)
  expect(scriptClass('.')).toBe(0)
  expect(scriptClass('42')).toBe(0)
})

test('containsRTL detects a single RTL character embedded in a longer LTR string', () => {
  expect(containsRTL('mostly LTR with one א at the end')).toBe(true)
})

test('voiceUidAtCursor at segment 0 returns the first voice UID', () => {
  expect(voiceUidAtCursor(stubThread, { segmentIndex: 0, graphemeIndex: 0 })).toBe(0)
})

// Pretext 1.0.0 has no bidi levels: direction comes from each segment's own letters.
test('isLineRTL treats a wrapped single RTL segment as RTL', () => {
  const prepared = { segments: ['مرحبابالعالم'], widths: [12] } as any
  expect(isLineRTL(prepared, { segmentIndex: 0, graphemeIndex: 0 }, { segmentIndex: 0, graphemeIndex: 5 })).toBe(true)
})

test('isLineRTL counts the end segment when the line ends mid-segment', () => {
  const prepared = { segments: ['a', 'שלוםעולם'], widths: [1, 10] } as any
  expect(isLineRTL(prepared, { segmentIndex: 0, graphemeIndex: 0 }, { segmentIndex: 1, graphemeIndex: 3 })).toBe(true)
})

test('isLineRTL is false for a line with no RTL letters, and the wider side wins a mixed line', () => {
  const ltr = { segments: ['plain', ' ', 'words'], widths: [10, 3, 10] } as any
  expect(isLineRTL(ltr, { segmentIndex: 0, graphemeIndex: 0 }, { segmentIndex: 3, graphemeIndex: 0 })).toBe(false)
  const mixed = { segments: ['a', ' ', 'مرحبا', ' ', 'long english tail'], widths: [5, 3, 20, 3, 60] } as any
  expect(isLineRTL(mixed, { segmentIndex: 0, graphemeIndex: 0 }, { segmentIndex: 3, graphemeIndex: 0 })).toBe(true)
  expect(isLineRTL(mixed, { segmentIndex: 0, graphemeIndex: 0 }, { segmentIndex: 5, graphemeIndex: 0 })).toBe(false)
})

test('isLineRTL does not let the spaces of an RTL line count against it', () => {
  const prepared = { segments: ['x', ' ', 'ب', ' ', 'ب', ' '], widths: [4, 3, 3, 3, 3, 3] } as any
  expect(isLineRTL(prepared, { segmentIndex: 0, graphemeIndex: 0 }, { segmentIndex: 6, graphemeIndex: 0 })).toBe(true)
})

test('isLineRTL reads real prepared text: an Arabic line is RTL, the English line after it is not', () => {
  installViewport(960, 640)
  const prepared = prepareWithSegments('السكوت ليس غياب الصوت. Silence is not the absence of sound. ', FONT, { whiteSpace: 'pre-wrap' })
  const split = prepared.segments.indexOf('Silence')
  expect(split).toBeGreaterThan(0)
  const start = { segmentIndex: 0, graphemeIndex: 0 }
  const mid = { segmentIndex: split, graphemeIndex: 0 }
  expect(isLineRTL(prepared, start, mid)).toBe(true)
  expect(isLineRTL(prepared, mid, { segmentIndex: prepared.segments.length, graphemeIndex: 0 })).toBe(false)
  // And a line Pretext itself lays out from the Arabic start is RTL too.
  const line = layoutNextLineRange(prepared, 120, { ...start })!
  expect(isLineRTL(prepared, start, line.end)).toBe(true)
})

// Pretext 1.0.0 no longer publishes its per-letter table. These three pin what the renderer
// relies on: the table is there and has one advance per letter; if a later release drops or
// reshapes it, letters are measured here and each segment keeps Pretext's width.
test('letterAdvances: Pretext still carries one advance per letter of every multi-letter word', () => {
  installViewport(960, 640)
  const prepared = prepareWithSegments('attention 記憶 صوت stays ', FONT, { whiteSpace: 'pre-wrap' })
  expect(Array.isArray((prepared as any).breakableFitAdvances)).toBe(true)
  const table = letterAdvances(prepared)
  expect(table).toBe((prepared as any).breakableFitAdvances)
  for (const word of ['attention', 'stays']) {
    const i = prepared.segments.indexOf(word)
    const advances = table[i]!
    expect(advances.length).toBe(word.length)
    let sum = 0
    for (let k = 0; k < advances.length; k++) sum += advances[k]!
    expect(sum).toBeCloseTo(prepared.widths[i]!)
  }
  expect(table[prepared.segments.indexOf(' ')]).toBeNull()
})

test('letterAdvances falls back to its own measurement when the handle has no usable table', () => {
  installViewport(960, 640)
  const real = prepareWithSegments('attention 記憶 a stays ', FONT, { whiteSpace: 'pre-wrap' })
  for (const broken of [undefined, 'nope', [null], real.segments.map(() => 7)]) {
    const handle = { segments: real.segments, widths: real.widths, breakableFitAdvances: broken } as any
    const table = letterAdvances(handle)
    expect(table.length).toBe(real.segments.length)
    for (let i = 0; i < real.segments.length; i++) {
      const letters = Array.from(graphemeSegmenter.segment(real.segments[i]!)).length
      const advances = table[i]
      if (real.segments[i]!.trim() === '' || letters < 2) { expect(advances).toBeNull(); continue }
      expect(advances!.length).toBe(letters)
      let sum = 0
      for (let k = 0; k < advances!.length; k++) sum += advances![k]!
      expect(sum).toBeCloseTo(real.widths[i]!)
    }
  }
})

test('measured letter advances agree with Pretext\'s own on plain words', () => {
  installViewport(960, 640)
  const prepared = prepareWithSegments('the afterglow lifted ', FONT, { whiteSpace: 'pre-wrap' })
  const own = (prepared as any).breakableFitAdvances as (number[] | null)[]
  const measured = measureLetterAdvances(prepared)
  for (let i = 0; i < prepared.segments.length; i++) {
    if (!own[i]) { expect(measured[i]).toBeNull(); continue }
    expect(measured[i]!.length).toBe(own[i]!.length)
    for (let k = 0; k < own[i]!.length; k++) expect(measured[i]![k]!).toBeCloseTo(own[i]![k]!)
  }
})
