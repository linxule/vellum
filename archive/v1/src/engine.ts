// ═══════════════════════════════════════════════════════
// V E L L U M — Pretext engine
// The bridge between content fragments and typographic layout
// ═══════════════════════════════════════════════════════

import {
  prepareWithSegments,
  layoutNextLine,
  layoutWithLines,
  type PreparedTextWithSegments,
  type LayoutCursor,
  type LayoutLine,
} from '@chenglou/pretext'
import type { Fragment } from './content.js'

// ── Types ──────────────────────────────────────────────

export interface FragmentSpan {
  charStart: number
  charEnd: number
  fragment: Fragment
}

export interface StyledRun {
  text: string
  fragment: Fragment
}

export interface VellumLine {
  runs: StyledRun[]
  y: number
  lineWidth: number   // actual text width (from Pretext)
  maxWidth: number    // available width at this y
  marginX: number     // left margin for centering
}

export interface WovenPosition {
  y: number
  family: string
  weaveCount: number
  layerIndex: number
}

export interface PreparedLayer {
  fullText: string
  spans: FragmentSpan[]
  prepared: PreparedTextWithSegments
  segments: string[]
}

// ── Preparation ────────────────────────────────────────

export function prepareLayer(fragments: Fragment[], font: string): PreparedLayer {
  const fullText = fragments.map(f => f.text).join('')
  const spans: FragmentSpan[] = []
  let offset = 0
  for (const f of fragments) {
    spans.push({ charStart: offset, charEnd: offset + f.text.length, fragment: f })
    offset += f.text.length
  }
  const prepared = prepareWithSegments(fullText, font, { whiteSpace: 'pre-wrap' })
  return { fullText, spans, prepared, segments: prepared.segments }
}

// ── Cursor → character offset ──────────────────────────
// Pretext cursors are {segmentIndex, graphemeIndex}.
// We convert to character offsets using the segments array.

function cursorToCharOffset(segments: string[], cursor: LayoutCursor): number {
  let offset = 0
  for (let i = 0; i < cursor.segmentIndex && i < segments.length; i++) {
    offset += segments[i].length
  }
  if (cursor.segmentIndex < segments.length) {
    // Count graphemes → chars within the segment
    const seg = segments[cursor.segmentIndex]
    const graphemes = Array.from(seg) // handles surrogate pairs
    for (let i = 0; i < Math.min(cursor.graphemeIndex, graphemes.length); i++) {
      offset += graphemes[i].length
    }
  }
  return offset
}

// ── Run mapping ────────────────────────────────────────
// Split a character range into styled runs based on fragment spans

function mapToRuns(spans: FragmentSpan[], charStart: number, charEnd: number, fullText: string): StyledRun[] {
  const runs: StyledRun[] = []
  for (const span of spans) {
    if (span.charEnd <= charStart) continue
    if (span.charStart >= charEnd) break
    const s = Math.max(charStart, span.charStart)
    const e = Math.min(charEnd, span.charEnd)
    const text = fullText.slice(s, e)
    if (text.length > 0) {
      runs.push({ text, fragment: span.fragment })
    }
  }
  return runs
}

// ═══════════════════════════════════════════════════════
// LAYOUT — the core of everything Pretext enables
// ═══════════════════════════════════════════════════════

// Variable-width layout: every line gets a different width.
// This is what CSS cannot do. This is Vellum.

export function layoutVariable(
  layer: PreparedLayer,
  widthFn: (y: number) => number,
  startY: number,
  lineHeight: number,
  viewportWidth: number,
): { lines: VellumLine[]; endY: number; wovenPositions: WovenPosition[] } {
  const { prepared, spans, fullText, segments } = layer
  const lines: VellumLine[] = []
  const wovenPositions: WovenPosition[] = []
  let cursor: LayoutCursor = { segmentIndex: 0, graphemeIndex: 0 }
  let prevCharOffset = 0
  let y = startY

  while (true) {
    const maxWidth = widthFn(y)
    const line = layoutNextLine(prepared, cursor, maxWidth)
    if (!line) break

    // Character range for this line
    const lineCharEnd = cursorToCharOffset(segments, line.end)
    const lineCharStart = prevCharOffset

    // Build styled runs
    const runs = mapToRuns(spans, lineCharStart, lineCharEnd, fullText)

    // Center text in viewport
    const marginX = Math.max(22, (viewportWidth - maxWidth) / 2)

    lines.push({ runs, y, lineWidth: line.width, maxWidth, marginX })

    // Track woven fragment positions for interaction
    for (const run of runs) {
      if (run.fragment.woven && run.fragment.family) {
        wovenPositions.push({
          y, family: run.fragment.family,
          weaveCount: run.fragment.weaveCount, layerIndex: 0,
        })
      }
    }

    prevCharOffset = lineCharEnd
    cursor = line.end
    y += lineHeight
  }

  return { lines, endY: y, wovenPositions }
}

// Fixed-width layout: for ghost layers (frozen in time)
// Ghost layers don't reflow — their line breaks are permanent.

export function layoutFixed(
  layer: PreparedLayer,
  width: number,
  lineHeight: number,
  startY: number,
  viewportWidth: number,
  layerIndex: number,
): { lines: VellumLine[]; endY: number; wovenPositions: WovenPosition[] } {
  const { prepared, spans, fullText, segments } = layer
  const result = layoutWithLines(prepared, width, lineHeight)
  const lines: VellumLine[] = []
  const wovenPositions: WovenPosition[] = []
  const marginX = Math.max(22, (viewportWidth - width) / 2)

  // Map each Pretext line to a VellumLine with styled runs
  let prevCharOffset = 0
  for (let i = 0; i < result.lines.length; i++) {
    const pLine = result.lines[i]
    const y = startY + i * lineHeight
    const lineCharEnd = cursorToCharOffset(segments, pLine.end)
    const runs = mapToRuns(spans, prevCharOffset, lineCharEnd, fullText)

    lines.push({ runs, y, lineWidth: pLine.width, maxWidth: width, marginX })

    for (const run of runs) {
      if (run.fragment.woven && run.fragment.family) {
        wovenPositions.push({
          y, family: run.fragment.family,
          weaveCount: run.fragment.weaveCount, layerIndex,
        })
      }
    }

    prevCharOffset = lineCharEnd
  }

  return { lines, endY: startY + result.lines.length * lineHeight, wovenPositions }
}

// Stream layout: for Loom mode — pre-compute all line breaks at base width

export interface StreamLine {
  text: string
  width: number
}

export function layoutStream(
  prepared: PreparedTextWithSegments,
  baseWidth: number,
  lineHeight: number,
): StreamLine[] {
  const result = layoutWithLines(prepared, baseWidth, lineHeight)
  return result.lines.map(l => ({ text: l.text, width: l.width }))
}
