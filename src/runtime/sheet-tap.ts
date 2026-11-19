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
 *
 * By touch where voices can be held (`hold`, the paper look), the lineage view reads as the
 * ocean does: a tap on a voice holds it open for reading, a tap on the held voice lets it go,
 * two taps on a voice within DOUBLE_TAP_MS recentre on it, and a tap on bare paper (farther
 * than a finger's reach, `near`, from every voice) leaves. A mouse click recentres as before.
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
  /** By touch, in the lineage view: hold this voice open for reading, or let it go (null). Absent: a tap recentres. */
  hold?(id: string | null): void
  /** The voice held open, if any. */
  held?(): string | null
  /** A lineage voice within a finger's reach of (x, y), when none is right under it. */
  near?(x: number, y: number): string | null
}

export function createSheetTap(deps: SheetTapDeps): { tap(x: number, y: number): void, clearPending(): void } {
  let pendingId: string | null = null
  let pendingAt = 0
  const clearPending = () => { pendingId = null }
  const tap = (x: number, y: number) => {
    const hitId = deps.hitAt(x, y)
    if (deps.loomActive() && deps.hold && deps.touch()) {
      const id = hitId ?? deps.near?.(x, y) ?? null
      if (!id) { pendingId = null; deps.exit(); return }
      const now = performance.now()
      if (pendingId === id && now - pendingAt < DOUBLE_TAP_MS) {
        pendingId = null
        // The first of the two let the voice go or took it up; the second settles it.
        if (id !== deps.loomSeed()) deps.recenter(id)
        else deps.hold(id)
        return
      }
      pendingId = id
      pendingAt = now
      deps.hold(deps.held?.() === id ? null : id)
      return
    }
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
