import type { LayoutCursor, PreparedTextWithSegments } from '@chenglou/pretext'
import type { Thread } from './types.js'

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

export function isLineRTL(prepared: PreparedTextWithSegments, start: LayoutCursor, end: LayoutCursor): boolean {
  const levels = (prepared as any).segLevels as Int8Array | null
  if (!levels) return false
  const widths = (prepared as any).widths as number[]
  const lastSeg = end.segmentIndex - (end.graphemeIndex === 0 ? 1 : 0)
  let rtl = 0
  let ltr = 0
  for (let i = start.segmentIndex; i <= lastSeg; i++) {
    const w = widths[i] || 1
    if (levels[i]! & 1) rtl += w
    else ltr += w
  }
  return rtl > ltr
}

export function copyCursor(cursor: LayoutCursor): LayoutCursor {
  return { segmentIndex: cursor.segmentIndex, graphemeIndex: cursor.graphemeIndex }
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
