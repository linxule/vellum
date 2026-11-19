// Reading by touch. A finger covers what it points at, so on a touch screen the
// lens does not follow the finger: a tap chooses a current, which opens at a
// fixed reading line above the thumb and stays open; dragging moves its text
// through that line. The other currents keep their colour and drop their words.
//
// The mechanism is the same lens as everywhere else: while a current is held,
// the pointer position is driven onto it each frame (as the phantom hover does
// for an arriving voice).

import { pathXAtY, widthAtY } from './path.js'
import { threadGroupKey } from './refresh.js'
import { loomState } from './state.js'
import type { MouseState, Thread } from './types.js'

/** Where the open current is read, as a fraction of the sheet's height. */
export const READING_LINE = 0.4
/** While one current is open, a tap this close (px) to another's line moves to it. */
export const TAP_REACH_PX = 30
/** On a sheet at rest a tap opens the nearest current, from up to this far (px): a thumb is not a pointer. */
export const REST_TAP_REACH_PX = 56
/** Once the read current is this far open, the others print no words. */
export const WORDLESS_PROXIMITY = 0.35

export type TapResult = 'opened' | 'kept' | 'closed'

/** The current held open for reading, if any. */
export function readingThread(): Thread | null {
  const key = loomState.readingKey
  if (key === null) return null
  for (const thread of loomState.threads) {
    if (threadGroupKey(thread.familyNames) === key) return thread
  }
  return null
}

export function isReading(): boolean {
  return loomState.readingKey !== null
}

export function closeReading(): void {
  loomState.readingKey = null
}

/**
 * A tap at (x, y). On a current at rest: it opens. On the open current: it is let
 * go, unless `keep` (the tap is on a woven voice, where a second tap opens its
 * lineage; the caller lets go if none comes). On or beside another current: that one opens instead. On bare paper:
 * the open one closes.
 */
export function tapCurrent(x: number, y: number, keep = false): TapResult {
  const ac = loomState.currentAperture
  if (!loomState.ready || !ac) return 'closed'
  const open = readingThread()
  if (open && open._path.length > 1) {
    const readY = loomState.VH * READING_LINE
    const half = widthAtY(y, readY, open.proximity, Math.min(open.balancedWidth, ac.openWidth), ac.restingWidth) / 2
    // As the painter does, an open line is kept inside the sheet's edges (8 px).
    let cx = pathXAtY(open._path, y)
    if (cx - half < 8) cx = 8 + half
    else if (cx + half > loomState.VW - 8) cx = loomState.VW - 8 - half
    if (Math.abs(x - cx) <= half + 8) {
      if (keep) return 'kept'
      closeReading()
      return 'closed'
    }
  }
  let nearest: Thread | null = null
  let best = open ? Math.max(TAP_REACH_PX, ac.restingWidth * 0.75) : Math.max(REST_TAP_REACH_PX, ac.restingWidth)
  for (let i = 0; i < loomState.threads.length; i++) {
    const thread = loomState.threads[i]!
    if (thread === open || thread._path.length < 2) continue
    if ((loomState.frameVisibilityAlpha[i] ?? 0) < 0.5) continue
    const d = Math.abs(x - pathXAtY(thread._path, y))
    if (d <= best) { best = d; nearest = thread }
  }
  if (!nearest) {
    closeReading()
    return 'closed'
  }
  loomState.readingKey = threadGroupKey(nearest.familyNames)
  return 'opened'
}

/** Each frame: keep the lens on the held current, at the reading line. */
export function driveReading(mouse: MouseState): void {
  if (loomState.readingKey === null) return
  if (loomState.loomViewActive || loomState.phantomFocus !== null) return
  const thread = readingThread()
  if (!thread) {
    // The current was rebuilt under another grouping (a resize): let go.
    closeReading()
    return
  }
  const y = loomState.VH * READING_LINE
  mouse.x = thread._path.length > 1 ? pathXAtY(thread._path, y) : thread.xCenter
  mouse.y = y
  mouse.prevX = mouse.x
  mouse.prevY = mouse.y
}

/** A sheet narrower or shorter than this has no room for the others' words beside an open current. */
export const SMALL_SHEET_W = 760
export const SMALL_SHEET_H = 520

/**
 * While one current is read, the others keep their wash and print no words: always
 * when it is held by touch, and on a small sheet (a phone, an inline ext-app)
 * however it was opened, a mouse included.
 */
export function wordlessWhileReading(thread: Thread): boolean {
  if (loomState.loomViewActive) return false
  let open: Thread | null = null
  if (loomState.readingKey !== null) open = readingThread()
  else if (loomState.VW < SMALL_SHEET_W || loomState.VH < SMALL_SHEET_H) open = loomState.touchedThread
  return open !== null && open !== thread && open.proximity > WORDLESS_PROXIMITY
}

/**
 * A finger dragging the open current: its text follows, line for line at the
 * reading line. `dyPx` is the finger's movement (down is positive).
 */
export function dragReading(dyPx: number): void {
  const thread = readingThread()
  const ac = loomState.currentAperture
  if (!thread || !ac) return
  thread.scroll -= dyPx / (3 * ac.diveLineH)
  if (thread.totalLines > 0 && thread.scroll < 0) thread.scroll += thread.totalLines / 3
}

/** The finger lifts mid-drag: the text glides a little further. `pxPerFrame` as in dragReading. */
export function flingReading(pxPerFrame: number): void {
  const thread = readingThread()
  const ac = loomState.currentAperture
  if (!thread || !ac) return
  thread.userScroll = Math.max(-2, Math.min(2, -pxPerFrame / (3 * ac.diveLineH)))
}
