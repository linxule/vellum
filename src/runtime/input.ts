import type { MouseState } from '../loom.js'

/** Reading by touch (loom/reading.ts), injected so this module stays off the loom barrel. */
export interface TouchReading {
  /** False where touch keeps the old follow-the-finger lens (the lineage view). */
  enabled(): boolean
  active(): boolean
  tap(x: number, y: number): 'opened' | 'kept' | 'closed'
  /** The finger moved by dy px while dragging. */
  drag(dy: number): void
  /** The finger lifted mid-drag, moving at this many px per frame. */
  fling(pxPerFrame: number): void
  release(): void
}

/** A finger must travel this far (px) before a touch is a drag and not a tap. */
export const DRAG_SLOP_PX = 8
/** A touch held longer than this is not a tap. */
export const TAP_MAX_MS = 500
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
 * current, which opens at a fixed reading line and stays open; a drag moves its
 * text and never moves the lens; a touch on a control (`.u`, `#info`) reaches
 * only that control.
 */
export function attachInputHandlers(opts: {
  mouse: MouseState
  scrollThread: (dy: number, dx?: number) => void
  aperture: (vw: number) => { touchPersistence: number }
  reading?: TouchReading
}): () => void {
  const { mouse, scrollThread, aperture, reading } = opts
  let touchEndTimeout: ReturnType<typeof setTimeout> | null = null

  const clearTouchEndTimeout = () => {
    if (touchEndTimeout !== null) {
      clearTimeout(touchEndTimeout)
      touchEndTimeout = null
    }
  }
  const park = () => { mouse.x = -9e3; mouse.y = -9e3; mouse.prevX = -9e3; mouse.prevY = -9e3 }

  let lastTouchAt = -1e9
  const afterTouch = () => performance.now() - lastTouchAt < SYNTHETIC_MOUSE_MS

  const handleMouseMove = (e: MouseEvent) => {
    if (afterTouch()) return
    // A real pointer takes the lens back from a current held by touch.
    if (reading?.active()) reading.release()
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
    lastTouchX = t.clientX
    lastTouchY = t.clientY
    mouse.down = true; mouse.downStart = now; mouse.touch = true
    if (reading?.enabled()) {
      mode = 'reading'
      startX = t.clientX; startY = t.clientY; startAt = now
      dragging = false; velocity = 0; lastMoveAt = now
      // An arriving voice may be holding the lens (phantom hover): the hand takes over.
      mouse.lastMove = now
      return
    }
    mode = 'follow'
    if (reading?.active()) reading.release()
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
        // A drag that begins on a resting sheet picks up the current under it.
        if (!reading.active()) reading.tap(startX, startY)
      }
      if (dragging) {
        const now = performance.now()
        velocity = dy / Math.max(1, now - lastMoveAt)
        lastMoveAt = now
        reading.drag(dy)
      }
      return
    }
    mouse.x = t.clientX; mouse.y = t.clientY
    if (Math.abs(dy) > 1 || Math.abs(dx) > 1) scrollThread(dy * -0.8, dx ? dx * -0.8 : undefined)
  }
  const handleTouchEnd = () => {
    const now = performance.now()
    lastTouchAt = now
    if (mode === 'control') return
    mouse.down = false
    clearTouchEndTimeout()
    if (mode === 'reading' && reading) {
      if (dragging) {
        // Only a finger still moving when it lifts carries the text on.
        if (now - lastMoveAt < 60) reading.fling(velocity * 16.7)
      } else if (now - startAt < TAP_MAX_MS) {
        if (reading.tap(startX, startY) === 'closed') park()
      }
      touchEndTimeout = setTimeout(() => {
        touchEndTimeout = null
        if (reading.active()) { reading.release(); park() }
      }, READING_IDLE_MS)
      return
    }
    const persistence = aperture(innerWidth).touchPersistence * 1000
    touchEndTimeout = setTimeout(() => {
      park()
      touchEndTimeout = null
    }, persistence)
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

  return () => {
    clearTouchEndTimeout()
    document.removeEventListener('mousemove', handleMouseMove)
    document.removeEventListener('mouseleave', handleMouseLeave)
    document.removeEventListener('mousedown', handleMouseDown)
    document.removeEventListener('mouseup', handleMouseUp)
    document.removeEventListener('touchstart', handleTouchStart)
    document.removeEventListener('touchmove', handleTouchMove)
    document.removeEventListener('touchend', handleTouchEnd)
    document.removeEventListener('touchcancel', handleTouchEnd)
    document.removeEventListener('wheel', handleWheel)
  }
}
