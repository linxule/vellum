import { expect, test } from 'bun:test'
import { scriptClass, containsRTL, isLineRTL, voiceUidAtCursor, voiceGroupIndex, voiceSpanForLine } from '../../src/loom/text.js'

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

test('isLineRTL treats a wrapped single RTL segment as RTL', () => {
  const prepared = {
    segLevels: new Int8Array([1]),
    widths: [12],
  } as any
  expect(isLineRTL(prepared, { segmentIndex: 0, graphemeIndex: 0 }, { segmentIndex: 0, graphemeIndex: 5 })).toBe(true)
})

test('isLineRTL counts the end segment when the line ends mid-segment', () => {
  const prepared = {
    segLevels: new Int8Array([0, 1]),
    widths: [1, 10],
  } as any
  expect(isLineRTL(prepared, { segmentIndex: 0, graphemeIndex: 0 }, { segmentIndex: 1, graphemeIndex: 3 })).toBe(true)
})

test('isLineRTL still short-circuits when levels are missing', () => {
  const prepared = {
    segLevels: null,
    widths: [10],
  } as any
  expect(isLineRTL(prepared, { segmentIndex: 0, graphemeIndex: 0 }, { segmentIndex: 0, graphemeIndex: 1 })).toBe(false)
})
