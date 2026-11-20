import { layoutNextLineRange, materializeLineRange, type LayoutCursor, type PreparedTextWithSegments } from '@chenglou/pretext'
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

/**
 * Where a cursor lies in a current's text, by its words rather than its index: in
 * which voice's text, in which tiled copy, and how many characters into it. A
 * rebuild that adds or drops other voices moves every index after them; the words
 * stay the words (cursorAt finds them again). Two voices can carry the same text
 * (an exact repeat is welcome), so a voice is also known by the voice before it,
 * and then by how many such pairs come before it.
 */
export interface TextPlace { text: string, before: string, nth: number, cycle: number, chars: number, grapheme: number }

/** Each voice's text in a current's first copy, by voice index (its separating space dropped). */
function voiceTexts(thread: Thread): string[] {
  const n = thread.groupBoundaries[thread.groupBoundaries.length - 1] ?? 0
  const texts: string[] = Array.from({ length: n }, () => '')
  const segments = thread.prepared.segments
  for (let s = 0; s < segments.length; s++) {
    const uid = thread.segVoiceUid[s] ?? -1
    if (uid < 0 || uid >= n) break
    texts[uid] += segments[s]!
  }
  return texts.map(t => t.trimEnd())
}

const sameVoice = (texts: string[], i: number, j: number) =>
  texts[i] === texts[j] && texts[(i + texts.length - 1) % texts.length] === texts[(j + texts.length - 1) % texts.length]

export function placeOf(thread: Thread, cursor: LayoutCursor): TextPlace | null {
  const n = thread.groupBoundaries[thread.groupBoundaries.length - 1] ?? 0
  const seg = cursor.segmentIndex
  const uid = thread.segVoiceUid[seg] ?? -1
  if (n <= 0 || uid < 0) return null
  let start = seg
  while (start > 0 && thread.segVoiceUid[start - 1] === uid) start--
  let chars = 0
  for (let s = start; s < seg; s++) chars += thread.prepared.segments[s]!.length
  const texts = voiceTexts(thread)
  const v = uid % n
  let nth = 0
  for (let i = 0; i < v; i++) if (sameVoice(texts, i, v)) nth++
  return { text: texts[v]!, before: texts[(v + n - 1) % n]!, nth, cycle: Math.floor(uid / n), chars, grapheme: cursor.graphemeIndex }
}

/** The cursor at a place in a (rebuilt) current's text; null if its voice is no longer there. */
export function cursorAt(thread: Thread, place: TextPlace): LayoutCursor | null {
  const n = thread.groupBoundaries[thread.groupBoundaries.length - 1] ?? 0
  const texts = voiceTexts(thread)
  // The same text after the same voice first; failing that, the same text anywhere.
  let v = -1
  for (const strict of [true, false]) {
    let seen = 0
    for (let i = 0; i < n; i++) {
      if (texts[i] !== place.text || (strict && texts[(i + n - 1) % n] !== place.before)) continue
      v = i
      if (seen++ === place.nth) break
    }
    if (v >= 0) break
  }
  if (v < 0) return null
  const find = (uid: number) => thread.segVoiceUid.indexOf(uid)
  let s = find(place.cycle * n + v)
  if (s < 0) s = find(v)
  if (s < 0) return null
  const segments = thread.prepared.segments
  let chars = 0
  while (chars < place.chars && s < segments.length) chars += segments[s++]!.length
  if (s >= segments.length) return null
  return { segmentIndex: s, graphemeIndex: place.grapheme }
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

/** The resting scroll whose layout starts with the line that starts at `top` (an anchored layout handing back, render/thread.ts). */
export const scrollForTop = (thread: Thread, top: LayoutCursor): number =>
  (Math.max(0, thread.lineEndCursors.findIndex(end => compareCursors(end, top) > 0)) + 0.5) / 3

/** Order of two cursors: negative, zero or positive. */
export function compareCursors(a: LayoutCursor, b: LayoutCursor): number {
  return a.segmentIndex !== b.segmentIndex ? a.segmentIndex - b.segmentIndex : a.graphemeIndex - b.graphemeIndex
}

// Laying a line out backwards, for the lines above an anchored reading line
// (render/thread.ts). Pretext breaks lines forwards only; this finds where a line
// that ends at a given cursor would start, by Pretext's own segments: a line
// starts after a space or a break, or between two text segments (Pretext splits
// text only where a line may break: Han characters, Hangul syllables, after a
// hyphen), never on a space, and its trailing spaces hang. It sums Pretext's own
// segment widths, as Pretext's forward layout does (tests/loom/anchor.test.ts
// checks that each line fits forwards).
// Kinds a line may break after: space, preserved-space, tab, zero-width-break,
// soft-hyphen, hard-break. Of those, spaces and tabs hang at a line's end.
const BREAK_AFTER = /space|tab|break|hyphen/
const HANGING = /space|tab/

function canStartLine(prepared: PreparedTextWithSegments, s: number): boolean {
  if (s <= 0) return true
  const kind = prepared.kinds[s]!
  const before = prepared.kinds[s - 1]!
  return !/space|tab|hard|glue/.test(kind) && !/glue/.test(before) && (BREAK_AFTER.test(before) || (before === 'text' && kind === 'text'))
}

/**
 * The line of at most `maxWidth` (15px layout units) that ends exactly at `end`:
 * its start, text and width. It never reaches back across a line break in the
 * text (an empty line between two breaks is a line). A single word wider than
 * the line is kept whole (the line runs wide, as `wholeWordWidth` lets a forward
 * line do), unless it is wider than WHOLE_WORD_MAX_LAYOUT_W too (a URL): that one
 * is cut between letters, as Pretext cuts it forwards. Null at the very start of
 * the text.
 */
export function lineEndingAt(prepared: PreparedTextWithSegments, maxWidth: number, end: LayoutCursor): { start: LayoutCursor, text: string, width: number } | null {
  const kinds = prepared.kinds
  const line = (start: LayoutCursor, width: number) => ({ start, text: materializeLineRange(prepared, { width, start, end }).text, width })
  // The letters of segment `seg` before `upTo` that fit in `room`, from the end backwards (at least one).
  const cut = (seg: number, upTo: number, room: number, used: number) => {
    const letters = letterAdvances(prepared)[seg]
    // No letter table for it (a one-letter segment cannot be cut): whole.
    if (!letters) return line({ segmentIndex: seg, graphemeIndex: 0 }, used + (prepared.widths[seg] ?? 0))
    let g = upTo
    let w = 0
    while (g > 0 && (g === upTo || w + letters[g - 1]! <= room + 0.01)) w += letters[--g]!
    return line({ segmentIndex: seg, graphemeIndex: g }, used + w)
  }
  // A piece of a cut word ends here: the line is the piece before it.
  if (end.graphemeIndex > 0) return cut(end.segmentIndex, end.graphemeIndex, maxWidth, 0)
  let i = end.segmentIndex - 1
  if (i < 0) return null
  // The line's own break, then the spaces hanging at its end.
  if (kinds[i] === 'hard-break') i--
  while (i >= 0 && HANGING.test(kinds[i]!)) i--
  let width = 0
  let best = -1
  let widthAtBest = 0
  for (; i >= 0; i--) {
    // The line before ended at this break. A tab's width depends on where it falls, which is not known
    // backwards: the line starts after it (short, and sure to fit). Either way everything back to
    // here fitted, so the line starts right after it, on a space too (an indented line keeps its indent).
    if (kinds[i] === 'hard-break' || kinds[i] === 'tab') return line({ segmentIndex: i + 1, graphemeIndex: 0 }, width)
    const own = prepared.widths[i] ?? 0
    const w = width + own
    if (w > maxWidth + 0.01) {
      if (best >= 0) break
      if (own > Math.max(maxWidth, WHOLE_WORD_MAX_LAYOUT_W) && letterAdvances(prepared)[i]) {
        return cut(i, letterAdvances(prepared)[i]!.length, maxWidth - width, width)
      }
    }
    width = w
    if (canStartLine(prepared, i)) { best = i; widthAtBest = width }
  }
  // The start of the text was reached: the line starts there, on its leading spaces if it has any.
  return i < 0 ? line({ segmentIndex: 0, graphemeIndex: 0 }, width) : line({ segmentIndex: best, graphemeIndex: 0 }, widthAtBest)
}
