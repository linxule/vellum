import { layoutNextLineRange, type LayoutCursor, type PreparedTextWithSegments } from '@chenglou/pretext'
import { FONT, WHOLE_WORD_MAX_LAYOUT_W, type Thread } from './types.js'

export const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

export function scriptClass(text: string): number {
  const c = text.codePointAt(0) ?? 0
  if ((c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3040 && c <= 0x30ff)
    || (c >= 0xac00 && c <= 0xd7af) || (c >= 0x3400 && c <= 0x4dbf)
    || (c >= 0x3000 && c <= 0x303f)
    || (c >= 0x31f0 && c <= 0x31ff) || (c >= 0xff00 && c <= 0xffef)) return 1
  if ((c >= 0x0600 && c <= 0x06ff) || (c >= 0x0590 && c <= 0x05ff)
    || (c >= 0xfb50 && c <= 0xfdff) || (c >= 0xfe70 && c <= 0xfeff)) return 2
  if ((c >= 0x0900 && c <= 0x097f) || (c >= 0x0e00 && c <= 0x0e7f)
    || (c >= 0x0980 && c <= 0x09ff)) return 3
  return 0
}

const rtlRe = /[\u0590-\u05FF\u0600-\u06FF\u0700-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/
export function containsRTL(text: string): boolean { return rtlRe.test(text) }

// Pretext 1.0.0 dropped `segLevels` (its per-segment bidi levels). The renderer only ever used
// them to decide whether a line reads right to left, so that is worked out here: a segment with an
// Arabic or Hebrew letter is RTL, any other non-blank segment is LTR, blank ones take no side, and
// the wider side wins. One class per segment, computed once per prepared text.
const segmentDirections = new WeakMap<object, Int8Array>()
function directionsOf(prepared: PreparedTextWithSegments): Int8Array {
  let dirs = segmentDirections.get(prepared)
  if (!dirs) {
    const segments = prepared.segments
    dirs = new Int8Array(segments.length)
    for (let i = 0; i < segments.length; i++) {
      const text = segments[i]!
      dirs[i] = rtlRe.test(text) ? 1 : text.trim() === '' ? 0 : -1
    }
    segmentDirections.set(prepared, dirs)
  }
  return dirs
}

export function isLineRTL(prepared: PreparedTextWithSegments, start: LayoutCursor, end: LayoutCursor): boolean {
  const dirs = directionsOf(prepared)
  const widths = prepared.widths
  const lastSeg = Math.min(end.segmentIndex - (end.graphemeIndex === 0 ? 1 : 0), dirs.length - 1)
  let rtl = 0
  let ltr = 0
  for (let i = start.segmentIndex; i <= lastSeg; i++) {
    const w = widths[i] || 1
    if (dirs[i] === 1) rtl += w
    else if (dirs[i] === -1) ltr += w
  }
  return rtl > ltr
}

/** Each letter's advance within a segment (15px layout units), or null for a blank or
 * one-letter segment. Both renderers place letters one by one from this. */
export type LetterAdvances = ArrayLike<ArrayLike<number> | null>

// Pretext keeps this table on the handle as `breakableFitAdvances`. Since 1.0.0 it is no longer
// in the published type and upstream calls it working data, so it is read in this one place, its
// shape is checked, and when it is missing the letters are measured here instead. The fallback
// scales each segment's letters to Pretext's own width for that segment, so lines keep their
// length; it measures letters one at a time, so pair kerning is spread evenly.
const letterAdvancesCache = new WeakMap<object, LetterAdvances>()
export function letterAdvances(prepared: PreparedTextWithSegments): LetterAdvances {
  let table = letterAdvancesCache.get(prepared)
  if (!table) {
    const own = (prepared as { breakableFitAdvances?: unknown }).breakableFitAdvances
    table = isLetterAdvances(own, prepared.segments.length) ? own : measureLetterAdvances(prepared)
    letterAdvancesCache.set(prepared, table)
  }
  return table
}

function isLetterAdvances(value: unknown, segmentCount: number): value is LetterAdvances {
  if (!Array.isArray(value) || value.length !== segmentCount) return false
  for (const entry of value) {
    if (entry !== null && (typeof entry !== 'object' || typeof (entry as ArrayLike<number>).length !== 'number')) return false
  }
  return true
}

let measureCtx: { font: string, measureText(text: string): { width: number } } | null = null
export function measureLetterAdvances(prepared: PreparedTextWithSegments): LetterAdvances {
  if (!measureCtx) {
    measureCtx = typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(1, 1).getContext('2d')
      : document.createElement('canvas').getContext('2d')
    if (!measureCtx) throw new Error('No canvas context to measure letters with.')
  }
  measureCtx.font = FONT
  const bySegmentText = new Map<string, number[] | null>()
  const segments = prepared.segments
  const table: (number[] | null)[] = new Array(segments.length)
  for (let i = 0; i < segments.length; i++) {
    const text = segments[i]!
    let raw = bySegmentText.get(text)
    if (raw === undefined) {
      raw = null
      if (text.trim() !== '') {
        const letters = Array.from(graphemeSegmenter.segment(text), g => measureCtx!.measureText(g.segment).width)
        if (letters.length > 1) raw = letters
      }
      bySegmentText.set(text, raw)
    }
    if (!raw) { table[i] = null; continue }
    let sum = 0
    for (const w of raw) sum += w
    const scale = sum > 0 ? (prepared.widths[i] ?? sum) / sum : 1
    table[i] = scale === 1 ? raw : raw.map(w => w * scale)
  }
  return table
}

export function copyCursor(cursor: LayoutCursor): LayoutCursor {
  return { segmentIndex: cursor.segmentIndex, graphemeIndex: cursor.graphemeIndex }
}

// Pretext splits a word only when it is wider than the whole line, and then
// only at the start of a line ("documentat / ionx" in a phone-width column).
// So a line that began on a word boundary and ended inside that same word is
// exactly that case. Returns the width to re-lay that line at so the word stays
// whole (the line then runs wider than its column), or 0 when the line stands.
// Words past the cap (a URL) still wrap.
export function wholeWordWidth(prepared: PreparedTextWithSegments, start: LayoutCursor, end: LayoutCursor, maxWidth: number): number {
  if (end.graphemeIndex === 0 || start.graphemeIndex !== 0 || start.segmentIndex !== end.segmentIndex) return 0
  const wordW = prepared.widths[end.segmentIndex] ?? 0
  return wordW > maxWidth && wordW <= WHOLE_WORD_MAX_LAYOUT_W ? wordW + 0.01 : 0
}

/** Line-end cursors for the whole text, keeping words whole per `wholeWordWidth`. */
export function lineEndsWholeWords(prepared: PreparedTextWithSegments, maxWidth: number): LayoutCursor[] {
  const ends: LayoutCursor[] = []
  let cursor: LayoutCursor = { segmentIndex: 0, graphemeIndex: 0 }
  for (;;) {
    let line = layoutNextLineRange(prepared, maxWidth, copyCursor(cursor))
    if (!line) break
    const wordW = wholeWordWidth(prepared, cursor, line.end, maxWidth)
    if (wordW > 0) line = layoutNextLineRange(prepared, wordW, copyCursor(cursor)) ?? line
    const end = line.end
    if (end.segmentIndex === cursor.segmentIndex && end.graphemeIndex === cursor.graphemeIndex) break
    ends.push(copyCursor(end))
    cursor = copyCursor(end)
  }
  return ends
}

export function voiceUidAtCursor(thread: Thread, cursor: LayoutCursor): number {
  return thread.segVoiceUid[cursor.segmentIndex] ?? -1
}

const voiceSpanUidsScratch: number[] = []
const voiceSpanRunsScratch: { uid: number, weight: number }[] = []

export function voiceGroupIndex(thread: Thread, uid: number): number {
  if (uid < 0 || thread.groupBoundaries.length <= 1) return 0
  const voiceCount = thread.groupBoundaries[thread.groupBoundaries.length - 1]
  const vIdx = uid % voiceCount
  for (let g = 0; g < thread.groupBoundaries.length; g++) {
    if (vIdx < thread.groupBoundaries[g]) return g
  }
  return thread.groupBoundaries.length - 1
}

export function voiceSpanForLine(thread: Thread, start: LayoutCursor, end: LayoutCursor): { anchorUid: number, uids: number[] } {
  const segments = thread.prepared.segments
  const segmentCount = thread.segVoiceUid.length
  if (segmentCount === 0) return { anchorUid: -1, uids: [] }

  const startSeg = Math.min(Math.max(0, start.segmentIndex), segmentCount - 1)
  let lastSeg = end.segmentIndex - (end.graphemeIndex === 0 ? 1 : 0)
  lastSeg = Math.min(Math.max(startSeg, lastSeg), segmentCount - 1)

  voiceSpanUidsScratch.length = 0
  voiceSpanRunsScratch.length = 0
  let totalWeight = 0

  for (let s = startSeg; s <= lastSeg; s++) {
    const uid = thread.segVoiceUid[s] ?? -1
    if (uid < 0) continue
    if (!voiceSpanUidsScratch.includes(uid)) voiceSpanUidsScratch.push(uid)
    const weight = Math.max(1, segments[s]?.length ?? 0)
    totalWeight += weight

    const prev = voiceSpanRunsScratch[voiceSpanRunsScratch.length - 1]
    if (prev?.uid === uid) prev.weight += weight
    else voiceSpanRunsScratch.push({ uid, weight })
  }

  let anchorUid = voiceUidAtCursor(thread, start)
  let acc = 0
  const midpoint = totalWeight / 2
  for (const run of voiceSpanRunsScratch) {
    acc += run.weight
    if (acc >= midpoint) {
      anchorUid = run.uid
      break
    }
  }

  return { anchorUid, uids: voiceSpanUidsScratch }
}
