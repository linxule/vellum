/**
 * What a tap on the sheet does to the lineage view, for both entry points. It is fed by
 * runtime/input.ts `onTap`, which calls it once per tap: from the touch itself at touchend,
 * or from a click no touch tap has accounted for. So nothing here waits on a click that iOS
 * may never send for a tap on the canvas.
 *
 * In the lineage view, a tap on another voice recentres it and a tap on bare paper leaves.
 * Elsewhere a click on a woven voice opens its lineage; by touch it takes two taps on the same
 * voice within DOUBLE_TAP_MS (the first one is reading it). A drag in between forgets the first
 * (`clearPending`).
 */
import { DOUBLE_TAP_MS } from './input'

export interface SheetTapDeps {
  /** The last pointer was a finger. */
  touch(): boolean
  /** The woven voice whose printed line is under (x, y) in the last frame, if any. */
  hitAt(x: number, y: number): string | null
  woven(id: string): boolean
  loomActive(): boolean
  loomSeed(): string | null
  enter(id: string): void
  recenter(id: string): void
  exit(): void
}

export function createSheetTap(deps: SheetTapDeps): { tap(x: number, y: number): void, clearPending(): void } {
  let pendingId: string | null = null
  let pendingAt = 0
  const clearPending = () => { pendingId = null }
  const tap = (x: number, y: number) => {
    const hitId = deps.hitAt(x, y)
    if (deps.loomActive()) {
      if (hitId && hitId !== deps.loomSeed()) deps.recenter(hitId)
      else if (!hitId) deps.exit() // tapping the seed itself does nothing
      return
    }
    if (!hitId) { pendingId = null; return }
    if (!deps.woven(hitId)) return
    if (!deps.touch()) { deps.enter(hitId); return }
    const now = performance.now()
    if (pendingId === hitId && now - pendingAt < DOUBLE_TAP_MS) {
      pendingId = null
      deps.enter(hitId)
      return
    }
    pendingId = hitId
    pendingAt = now
  }
  return { tap, clearPending }
}
