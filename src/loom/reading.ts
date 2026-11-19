// Reading by touch. The finger is a drop of water: a tap opens the current it
// lands on, at the height it lands (kept on the sheet, so the open text fits),
// and the current stays open with no finger on the glass; dragging moves its
// text through that line, the lens never follows a drag. Letting go recedes:
// the lens stays where it was while the current eases shut. The other currents
// keep their colour and drop their words.
//
// The mechanism is the same lens as everywhere else: while a current is held
// (or receding), the pointer position is driven onto it each frame (as the
// phantom hover does for an arriving voice).

import { pathXAtY, widthAtY } from './path.js'
import { threadGroupKey } from './refresh.js'
import { getLastFrameHitVoiceIdAt, loomState } from './state.js'
import { DIVE_SIGMA_LINES, type MouseState, type Thread } from './types.js'

/** The reading line of a tiny sheet, and a cap on how far a read is kept from the top, as a fraction of its height. */
export const READING_LINE = 0.4
/** A read is kept this many lens sigmas from the top edge (the open block above it stays on the sheet). */
export const READING_EDGE_SIGMAS = 2.2
/** ...and from the bottom edge, at least this fraction of the sheet's height (room for the block below it). */
export const READING_FOOT = 0.35
/** A drag that opens a current from a resting sheet opens it this many lens sigmas above the thumb, which stays down. */
export const DRAG_LIFT_SIGMAS = 1.3
/** While a current is held by touch, its proximity rises this much of the way per 60 fps frame (a mouse: 0.022). */
export const TOUCH_OPEN_RATE = 0.05
/** A receding current is let go (the pointer parked) once its proximity is below this: nothing depends on the pointer there. */
export const RECEDED_PROXIMITY = 0.01
/** While one current is open, a tap this close (px) to another's line moves to it. */
export const TAP_REACH_PX = 30
/** On a sheet at rest a tap opens the nearest current, from up to this far (px): a thumb is not a pointer. */
export const REST_TAP_REACH_PX = 56
/** Once the read current is this far open, the others print no words. */
export const WORDLESS_PROXIMITY = 0.35

export type TapResult = 'opened' | 'kept' | 'closed'

/** The current held open for reading, if any. */
export function readingThread(): Thread | null {
  return threadOf(loomState.readingKey)
}

export function isReading(): boolean {
  return loomState.readingKey !== null
}

/** The family whose instrument and ink the held current has (a merged current: its first). */
export function readingFamily(): string | null {
  return readingThread()?.familyNames[0] ?? null
}

/**
 * Lets the current go. By touch it recedes (`recede`): the lens stays at its line
 * while the current eases shut at the usual closing rate, then the pointer is
 * parked (driveReading). Without `recede` (a real pointer takes over, the lineage
 * view opens, the current was rebuilt) it is let go at once, recession included.
 */
export function closeReading(recede = false): void {
  if (recede && loomState.readingKey !== null) {
    loomState.recedingKey = loomState.readingKey
    loomState.recedingY = loomState.readingY
  } else if (!recede) {
    loomState.recedingKey = null
  }
  loomState.readingKey = null
}

/** The current easing shut after a touch let it go, if any. */
export function recedingThread(): Thread | null {
  return threadOf(loomState.recedingKey)
}

export function isReceding(): boolean {
  return loomState.recedingKey !== null
}

function threadOf(key: string | null): Thread | null {
  if (key === null) return null
  for (const thread of loomState.threads) {
    if (threadGroupKey(thread.familyNames) === key) return thread
  }
  return null
}

/** The lens's gaussian (px) on this sheet. */
function lensSigma(): number {
  const ac = loomState.currentAperture
  return ac ? DIVE_SIGMA_LINES * ac.diveLineH : 0
}

/**
 * Where a read at height `y` is kept: not higher than m from the top, not lower
 * than max(m, READING_FOOT of the sheet) from the bottom, m = min(READING_LINE of
 * the sheet, READING_EDGE_SIGMAS lens sigmas). On a short sheet (an inline
 * ext-app, ~320 px) that leaves it near the middle.
 */
export function clampReadingY(y: number): number {
  const vh = loomState.VH
  if (!Number.isFinite(y)) y = READING_LINE * vh
  const m = Math.min(READING_LINE * vh, READING_EDGE_SIGMAS * lensSigma())
  const lo = m
  const hi = vh - Math.max(m, READING_FOOT * vh)
  return Math.max(lo, Math.min(hi, y))
}

/**
 * A tap at (x, y). On a current at rest: it opens, read at the tapped height. On
 * the open current: it is let go (it recedes), unless `keep` (the tap is on a
 * woven voice, where a second tap opens its lineage; the caller lets go if none
 * comes). On or beside another current: that one opens instead, at the tapped
 * height. On bare paper: the open one recedes. `byDrag`: a drag opening a current
 * from rest, whose thumb stays down, so it is read DRAG_LIFT_SIGMAS above it.
 */
export function tapCurrent(x: number, y: number, keep = false, byDrag = false): TapResult {
  const ac = loomState.currentAperture
  if (!loomState.ready || !ac) return 'closed'
  const open = readingThread()
  if (open && onOpenLines(open, loomState.readingY, x, y)) {
    if (keep) return 'kept'
    closeReading(true)
    return 'closed'
  }
  // A tap on the lines of a current still easing shut opens it again (its lines are wider than its reach).
  const receding = open ? null : recedingThread()
  const onReceding = receding !== null && onOpenLines(receding, loomState.recedingY, x, y)
  let nearest: Thread | null = onReceding ? receding : null
  let best = open ? Math.max(TAP_REACH_PX, ac.restingWidth * 0.75) : Math.max(REST_TAP_REACH_PX, ac.restingWidth)
  // Otherwise the nearest current within reach (not the first one found there).
  for (let i = 0; !onReceding && i < loomState.threads.length; i++) {
    const thread = loomState.threads[i]!
    if (thread === open || thread._path.length < 2) continue
    if ((loomState.frameVisibilityAlpha[i] ?? 0) < 0.5) continue
    const d = Math.abs(x - pathXAtY(thread._path, y))
    if (d <= best) { best = d; nearest = thread }
  }
  if (!nearest) {
    closeReading(true)
    return 'closed'
  }
  loomState.readingKey = threadGroupKey(nearest.familyNames)
  loomState.readingY = clampReadingY(byDrag ? y - DRAG_LIFT_SIGMAS * lensSigma() : y)
  // A new read wins over one still receding, at once.
  loomState.recedingKey = null
  return 'opened'
}

/** Whether (x, y) falls on an open (or opening, or closing) current's lines, as wide as they are drawn at y. */
function onOpenLines(thread: Thread, readingY: number, x: number, y: number): boolean {
  const ac = loomState.currentAperture
  if (!ac || thread._path.length < 2) return false
  // Where its lines were printed last frame (the text painter records them for the current under the lens).
  if (loomState.touchedThread === thread && getLastFrameHitVoiceIdAt(x, y, true) !== null) return true
  const half = widthAtY(y, clampReadingY(readingY), thread.proximity, Math.min(thread.balancedWidth, ac.openWidth), ac.restingWidth) / 2
  // As the painter does, an open line is kept inside the sheet's edges (8 px).
  let cx = pathXAtY(thread._path, y)
  if (cx - half < 8) cx = 8 + half
  else if (cx + half > loomState.VW - 8) cx = loomState.VW - 8 - half
  return Math.abs(x - cx) <= half + 8
}

/**
 * Each frame: keep the lens on the held current, at its reading line (re-kept
 * on the sheet, so a rotation or resize cannot strand it). While a current
 * recedes, the lens stays at its line until it has eased shut; then the
 * pointer is parked.
 */
export function driveReading(mouse: MouseState): void {
  if (loomState.readingKey === null && loomState.recedingKey === null) return
  if (loomState.loomViewActive || loomState.phantomFocus !== null) {
    // The lens is someone else's now: a recession has nothing left to hold.
    loomState.recedingKey = null
    return
  }
  if (loomState.readingKey !== null) {
    const thread = readingThread()
    if (!thread) {
      // The current was rebuilt under another grouping (a resize): let go, and
      // park the pointer, or the lens would stay open on whatever lies there now.
      closeReading()
      parkPointer(mouse)
      return
    }
    loomState.readingY = clampReadingY(loomState.readingY)
    putLens(mouse, thread, loomState.readingY)
    return
  }
  const thread = recedingThread()
  if (!thread || thread.proximity < RECEDED_PROXIMITY) {
    loomState.recedingKey = null
    parkPointer(mouse)
    return
  }
  loomState.recedingY = clampReadingY(loomState.recedingY)
  putLens(mouse, thread, loomState.recedingY)
}

function parkPointer(mouse: MouseState): void {
  mouse.x = -9e3; mouse.y = -9e3; mouse.prevX = -9e3; mouse.prevY = -9e3
}

function putLens(mouse: MouseState, thread: Thread, y: number): void {
  mouse.x = thread._path.length > 1 ? pathXAtY(thread._path, y) : thread.xCenter
  mouse.y = y
  mouse.prevX = mouse.x
  mouse.prevY = mouse.y
}

/** A sheet narrower or shorter than this has no room for the others' words beside an open current. */
export const SMALL_SHEET_W = 760
export const SMALL_SHEET_H = 520

/** Below this the read current's openness no longer quiets the others: their words fade back in between the two. */
export const WORDLESS_FROM = 0.2

/**
 * While one current is read, the others keep their wash and print no words: always
 * when it is held by touch, and on a small sheet (a phone, an inline ext-app)
 * however it was opened, a mouse included. 1 once the read current is open past
 * WORDLESS_PROXIMITY; between WORDLESS_FROM and that, the words fade (they come
 * back gently as it closes). Applied by the water's rule (render/water.ts, waterOver).
 */
export function wordlessAmount(thread: Thread): number {
  if (loomState.loomViewActive) return 0
  let open: Thread | null = null
  // A receding current still quiets the others, by its own openness: their words come back as it closes.
  if (loomState.readingKey !== null) open = readingThread()
  else if (loomState.recedingKey !== null) open = recedingThread()
  else if (loomState.VW < SMALL_SHEET_W || loomState.VH < SMALL_SHEET_H) open = loomState.touchedThread
  if (open === null || open === thread) return 0
  if (open.proximity > WORDLESS_PROXIMITY) return 1
  return Math.max(0, (open.proximity - WORDLESS_FROM) / (WORDLESS_PROXIMITY - WORDLESS_FROM))
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
