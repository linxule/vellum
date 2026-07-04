import type { MouseState } from '../loom.js'

/**
 * Attach mouse, touch, and wheel handlers to document.
 * Returns a disposer. Callers typically don't dispose — entry points live
 * for the document lifetime — but the return value makes the attachment
 * contract explicit.
 *
 * scrollThread is injected so this module doesn't depend on the loom barrel.
 */
export function attachInputHandlers(opts: {
  mouse: MouseState
  scrollThread: (dy: number, dx?: number) => void
  aperture: (vw: number) => { touchPersistence: number }
}): () => void {
  const { mouse, scrollThread, aperture } = opts
  let touchEndTimeout: ReturnType<typeof setTimeout> | null = null

  const clearTouchEndTimeout = () => {
    if (touchEndTimeout !== null) {
      clearTimeout(touchEndTimeout)
      touchEndTimeout = null
    }
  }

  const handleMouseMove = (e: MouseEvent) => {
    mouse.x = e.clientX; mouse.y = e.clientY
  }
  const handleMouseLeave = () => { mouse.x = -9e3; mouse.y = -9e3; mouse.prevX = -9e3; mouse.prevY = -9e3 }
  let lastTouchAt = 0
  const handleMouseDown = () => {
    mouse.down = true; mouse.downStart = performance.now()
    // Only clear touch flag for real mouse clicks — synthetic mousedown fires
    // within ~500ms of touchstart on mobile; don't let it clobber the flag
    if (performance.now() - lastTouchAt > 500) mouse.touch = false
  }
  const handleMouseUp = () => { mouse.down = false }

  let lastTouchX = 0
  let lastTouchY = 0
  const handleTouchStart = (e: TouchEvent) => {
    lastTouchAt = performance.now()
    clearTouchEndTimeout()
    const t = e.touches[0]
    mouse.x = t.clientX; mouse.y = t.clientY
    lastTouchX = t.clientX
    lastTouchY = t.clientY
    mouse.down = true; mouse.downStart = performance.now(); mouse.touch = true
  }
  const handleTouchMove = (e: TouchEvent) => {
    clearTouchEndTimeout()
    const t = e.touches[0]
    const dx = t.clientX - lastTouchX
    const dy = t.clientY - lastTouchY
    lastTouchX = t.clientX
    lastTouchY = t.clientY
    mouse.x = t.clientX; mouse.y = t.clientY
    if (Math.abs(dy) > 1 || Math.abs(dx) > 1) scrollThread(dy * -0.8, dx ? dx * -0.8 : undefined)
  }
  const handleTouchEnd = () => {
    mouse.down = false
    clearTouchEndTimeout()
    const persistence = aperture(innerWidth).touchPersistence * 1000
    touchEndTimeout = setTimeout(() => {
      mouse.x = -9e3; mouse.y = -9e3; mouse.prevX = -9e3; mouse.prevY = -9e3
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
    document.removeEventListener('wheel', handleWheel)
  }
}
