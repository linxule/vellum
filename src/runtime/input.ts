import type { MouseState } from '../loom.js'

/** Reading by touch (loom/reading.ts), injected so this module stays off the loom barrel. */
export interface TouchReading {
  /** False where touch keeps the old follow-the-finger lens (the lineage view). */
  enabled(): boolean
  /** False where a drag on a resting sheet belongs to the page around it (an inline ext-app in a scrolling chat). Default: true. */
  dragOpens?(): boolean
  active(): boolean
  /** A current let go by touch, still easing shut (it keeps the lens until then). */
  receding?(): boolean
  /** A tap at (x, y); `byDrag`: a drag opening a current from rest, the thumb still down. */
  tap(x: number, y: number, byDrag?: boolean): 'opened' | 'kept' | 'closed'
  /** A tap opened a current at (x, y): a drop falls there. Called at the tap's end, never at touchstart or for a drag. */
  dropped?(x: number, y: number): void
  /** The finger moved by dy px while dragging. */
  drag(dy: number): void
  /** The finger lifted mid-drag, moving at this many px per frame. */
  fling(pxPerFrame: number): void
  /** Lets the current go: `recede` eases it shut where it was read (a touch); otherwise at once (a pointer takes over). */
  release(recede?: boolean): void
}

/** A finger must travel this far (px) before a touch is a drag and not a tap. */
export const DRAG_SLOP_PX = 8
/** A touch held longer than this is not a tap. */
export const TAP_MAX_MS = 500
/** Two taps on a woven voice within this long open its lineage; a single one lets the current go once it has passed. */
export const DOUBLE_TAP_MS = 500
/** With no touch for this long, the open current is let go and the sheet rests. */
export const READING_IDLE_MS = 45000
/** Browsers follow a tap with made-up mouse events; for this long after a touch they are ignored. */
const SYNTHETIC_MOUSE_MS = 800

/**
 * Attach mouse, touch, and wheel handlers to document.
 * Returns a disposer. Callers typically don't dispose — entry points live
 * for the document lifetime — but the return value makes the attachment
 * contract explicit.
 *
 * scrollThread is injected so this module doesn't depend on the loom barrel.
 *
 * With `reading`, touch works differently from the mouse: a tap chooses a
 * current, which opens where the tap fell and stays open (a drop falls there,
 * `dropped`); a drag moves its text and never moves the lens; letting go
 * recedes; a touch on a control (`.u`, `#info`) reaches only that control.
 *
 * `onTap` is a finished tap on the sheet, once per tap: from the touch itself
 * (a touch that neither travelled DRAG_SLOP_PX nor lasted TAP_MAX_MS, called at
 * touchend), or from a click that no touch tap has just accounted for (a mouse,
 * a keyboard). It never waits for the click a browser may make up after a touch:
 * iOS Safari need not send one for a canvas with no listener of its own.
 */
export function attachInputHandlers(opts: {
  mouse: MouseState
  scrollThread: (dy: number, dx?: number) => void
  aperture: (vw: number) => { touchPersistence: number }
  reading?: TouchReading
  /** A finished tap on the sheet at (x, y); `e` is the touchend or the click. */
  onTap?: (x: number, y: number, e: Event) => void
  /** A touch on the sheet became a drag. */
  onDrag?: () => void
}): () => void {
  const { mouse, scrollThread, aperture, reading, onTap, onDrag } = opts
  let touchEndTimeout: ReturnType<typeof setTimeout> | null = null
  let keptTimeout: ReturnType<typeof setTimeout> | null = null
  const clearKept = () => { if (keptTimeout !== null) { clearTimeout(keptTimeout); keptTimeout = null } }

  const clearTouchEndTimeout = () => {
    if (touchEndTimeout !== null) {
      clearTimeout(touchEndTimeout)
      touchEndTimeout = null
    }
  }
  const park = () => { mouse.x = -9e3; mouse.y = -9e3; mouse.prevX = -9e3; mouse.prevY = -9e3 }
  // After a touch let go: a receding current keeps the lens until it has shut (and parks it then); otherwise park now.
  const letGo = () => { if (!reading?.receding?.()) park() }

  let lastTouchAt = -1e9
  const afterTouch = () => performance.now() - lastTouchAt < SYNTHETIC_MOUSE_MS
  // The click a browser may make up after a touch tap is the same tap: it has already acted.
  let touchTapAt = -1e9
  const handleClick = (e: MouseEvent) => {
    if (performance.now() - touchTapAt < SYNTHETIC_MOUSE_MS) return
    onTap?.(e.clientX, e.clientY, e)
  }

  const handleMouseMove = (e: MouseEvent) => {
    if (afterTouch()) return
    // A real pointer takes the lens back from a current held (or receding) by touch.
    if (reading && (reading.active() || reading.receding?.())) reading.release()
    mouse.x = e.clientX; mouse.y = e.clientY
  }
  const handleMouseLeave = () => { if (!afterTouch()) park() }
  const handleMouseDown = () => {
    mouse.down = true; mouse.downStart = performance.now()
    // Only clear touch flag for real mouse clicks — synthetic mousedown fires
    // within ~500ms of touchstart on mobile; don't let it clobber the flag
    if (!afterTouch()) mouse.touch = false
  }
  const handleMouseUp = () => { mouse.down = false }

  type TouchMode = 'follow' | 'reading' | 'control'
  let mode: TouchMode = 'follow'
  let lastTouchX = 0
  let lastTouchY = 0
  let startX = 0
  let startY = 0
  let startAt = 0
  let dragging = false
  let lastMoveAt = 0
  let velocity = 0   // px per ms, of the last move

  const onControl = (target: EventTarget | null): boolean =>
    typeof Element !== 'undefined' && target instanceof Element && target.closest('.u, #info') !== null

  const handleTouchStart = (e: TouchEvent) => {
    const now = performance.now()
    lastTouchAt = now
    const t = e.touches[0]
    if (!t) return
    if (onControl(e.target)) { mode = 'control'; return }
    clearTouchEndTimeout()
    clearKept()
    lastTouchX = t.clientX
    lastTouchY = t.clientY
    mouse.down = true; mouse.downStart = now; mouse.touch = true
    startX = t.clientX; startY = t.clientY; startAt = now
    dragging = false
    if (reading?.enabled()) {
      mode = 'reading'
      velocity = 0; lastMoveAt = now
      // An arriving voice may be holding the lens (phantom hover): the hand takes over.
      mouse.lastMove = now
      return
    }
    mode = 'follow'
    if (reading && (reading.active() || reading.receding?.())) reading.release()
    mouse.x = t.clientX; mouse.y = t.clientY
  }
  const handleTouchMove = (e: TouchEvent) => {
    lastTouchAt = performance.now()
    if (mode === 'control') return
    const t = e.touches[0]
    if (!t) return
    clearTouchEndTimeout()
    const dx = t.clientX - lastTouchX
    const dy = t.clientY - lastTouchY
    lastTouchX = t.clientX
    lastTouchY = t.clientY
    if (mode === 'reading' && reading) {
      if (!dragging && Math.hypot(t.clientX - startX, t.clientY - startY) > DRAG_SLOP_PX) {
        dragging = true
        onDrag?.()
        // A drag that begins on a resting sheet picks up the current under it.
        if (!reading.active() && (reading.dragOpens?.() ?? true)) reading.tap(startX, startY, true)
      }
      if (dragging && reading.active()) {
        const now = performance.now()
        velocity = dy / Math.max(1, now - lastMoveAt)
        lastMoveAt = now
        reading.drag(dy)
      }
      return
    }
    if (!dragging && Math.hypot(t.clientX - startX, t.clientY - startY) > DRAG_SLOP_PX) { dragging = true; onDrag?.() }
    mouse.x = t.clientX; mouse.y = t.clientY
    if (Math.abs(dy) > 1 || Math.abs(dx) > 1) scrollThread(dy * -0.8, dx ? dx * -0.8 : undefined)
  }
  const handleTouchEnd = (e: TouchEvent) => {
    const now = performance.now()
    lastTouchAt = now
    if (mode === 'control') return
    mouse.down = false
    clearTouchEndTimeout()
    // After the reading has had the tap (a current opened, its drop fell), the page has it.
    const tapped = e.type === 'touchend' && !dragging && now - startAt < TAP_MAX_MS
    const tapDone = () => { if (tapped && onTap) { touchTapAt = now; onTap(startX, startY, e) } }
    if (mode === 'reading' && reading) {
      if (dragging) {
        // Only a finger still moving when it lifts carries the text on.
        if (reading.active() && now - lastMoveAt < 60) reading.fling(velocity * 16.7)
      } else if (now - startAt < TAP_MAX_MS) {
        const result = reading.tap(startX, startY)
        if (result === 'opened') reading.dropped?.(startX, startY)
        else if (result === 'closed') letGo()
        else if (result === 'kept') {
          // On a woven voice: wait for the second tap (the lineage). If none comes, this was a tap to let go.
          keptTimeout = setTimeout(() => {
            keptTimeout = null
            if (reading.enabled() && reading.active()) { reading.release(true); letGo() }
          }, DOUBLE_TAP_MS)
        }
      }
      touchEndTimeout = setTimeout(() => {
        touchEndTimeout = null
        if (reading.active()) { reading.release(true); letGo() }
      }, READING_IDLE_MS)
      tapDone()
      return
    }
    const persistence = aperture(innerWidth).touchPersistence * 1000
    touchEndTimeout = setTimeout(() => {
      park()
      touchEndTimeout = null
    }, persistence)
    tapDone()
  }

  const handleWheel = (e: WheelEvent) => {
    e.preventDefault()
    const dy = e.deltaMode === 1 ? e.deltaY * 40
              : e.deltaMode === 2 ? e.deltaY * innerHeight
              : e.deltaY
    const dx = e.deltaMode === 1 ? e.deltaX * 40
              : e.deltaMode === 2 ? e.deltaX * innerWidth
              : e.deltaX
    scrollThread(dy, dx || undefined)
  }

  document.addEventListener('mousemove', handleMouseMove)
  document.addEventListener('mouseleave', handleMouseLeave)
  document.addEventListener('mousedown', handleMouseDown)
  document.addEventListener('mouseup', handleMouseUp)
  document.addEventListener('touchstart', handleTouchStart, { passive: true })
  document.addEventListener('touchmove', handleTouchMove, { passive: true })
  document.addEventListener('touchend', handleTouchEnd, { passive: true })
  document.addEventListener('touchcancel', handleTouchEnd, { passive: true })
  document.addEventListener('wheel', handleWheel, { passive: false })
  if (onTap) document.addEventListener('click', handleClick)

  return () => {
    clearTouchEndTimeout()
    clearKept()
    document.removeEventListener('mousemove', handleMouseMove)
    document.removeEventListener('mouseleave', handleMouseLeave)
    document.removeEventListener('mousedown', handleMouseDown)
    document.removeEventListener('mouseup', handleMouseUp)
    document.removeEventListener('touchstart', handleTouchStart)
    document.removeEventListener('touchmove', handleTouchMove)
    document.removeEventListener('touchend', handleTouchEnd)
    document.removeEventListener('touchcancel', handleTouchEnd)
    document.removeEventListener('wheel', handleWheel)
    document.removeEventListener('click', handleClick)
  }
}
