import type { MouseState } from '../loom.js'

/** Update mouse velocity + moving state in-place. Called once per frame. */
export function updateMouseVelocity(mouse: MouseState, now: number): void {
  const dx = mouse.x - mouse.prevX, dy = mouse.y - mouse.prevY
  mouse.speed = Math.sqrt(dx * dx + dy * dy)
  mouse.moving = mouse.speed > 1.2
  if (mouse.moving) mouse.lastMove = now
  mouse.prevX = mouse.x; mouse.prevY = mouse.y
}

/**
 * requestAnimationFrame when visible, setTimeout(100ms) when hidden.
 * Mutates the caller-provided handle so callbacks null the same object the
 * caller later passes to `clearScheduledFrame`.
 */
export function scheduleNextFrame(
  handle: {
    frameId: number | null
    frameTimeout: ReturnType<typeof setTimeout> | null
  },
  renderFn: (now: number) => void,
): void {
  if (document.hidden) {
    handle.frameTimeout = setTimeout(() => {
      handle.frameTimeout = null
      renderFn(performance.now())
    }, 100)
    return
  }
  handle.frameId = requestAnimationFrame(now => {
    handle.frameId = null
    renderFn(now)
  })
}

export function clearScheduledFrame(handle: {
  frameId: number | null
  frameTimeout: ReturnType<typeof setTimeout> | null
}): void {
  if (handle.frameId !== null) {
    cancelAnimationFrame(handle.frameId)
    handle.frameId = null
  }
  if (handle.frameTimeout !== null) {
    clearTimeout(handle.frameTimeout)
    handle.frameTimeout = null
  }
}
