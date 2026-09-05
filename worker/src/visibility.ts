// Phase 16 "The Levee" post-review fix (see docs/PHASE_16_REPORT.md "Post-review fixes").
//
// `voices.visibility` and `voices.is_hidden` are a strict mirror: is_hidden = (visibility !=
// 'surfaced'). Before this fix, admin hide/unhide wrote is_hidden alone, leaving visibility stuck
// at 'surfaced' — the mirror broke on the very first admin hide, and `resolveSource` (which reads
// `visibility != 'hidden'`, not is_hidden) let a hidden voice keep resolving by id.
//
// This module is the ONLY writer of either column. Every call site that used to hand-roll an
// UPDATE of is_hidden and/or visibility (admin hide/unhide/bulk, quarantine release, the weave
// batch's settling-release statement) now goes through `setVisibility`/`setVisibilityStatement`.
import type { VisibilityState } from './types'

export function setVisibilityStatement(
  db: D1Database,
  id: string,
  state: VisibilityState,
  opts?: { onlyIfCurrently?: VisibilityState },
): D1PreparedStatement {
  const isHidden = state !== 'surfaced' ? 1 : 0
  return opts?.onlyIfCurrently
    ? db.prepare('UPDATE voices SET visibility = ?, is_hidden = ? WHERE id = ? AND visibility = ?').bind(state, isHidden, id, opts.onlyIfCurrently)
    : db.prepare('UPDATE voices SET visibility = ?, is_hidden = ? WHERE id = ?').bind(state, isHidden, id)
}

export async function setVisibility(
  db: D1Database,
  id: string,
  state: VisibilityState,
  opts?: { onlyIfCurrently?: VisibilityState },
): Promise<D1Result> {
  return setVisibilityStatement(db, id, state, opts).run()
}

/**
 * Post-review fix (Phase 18 review, item 2): the quarantine-release sweep (`cache.ts`'s
 * `rebuildStateProjection`, Phase 16 Part E's fuse) was still hand-rolling its own bulk
 * `UPDATE voices SET visibility = ..., is_hidden = ...` — the file-level comment above already
 * claimed this module was the only writer, but that one WHERE-matched bulk release never actually
 * went through it. Unlike `setVisibility`/`setVisibilityStatement` (single id), this is a
 * multi-row release keyed on a condition, not an id — so it gets its own statement builder here
 * rather than forcing a fetch-then-loop, but it stays in THIS file so the invariant is real: every
 * write to either column lives in visibility.ts, full stop.
 */
export function releaseQuarantineStatement(db: D1Database, quarantineMaxAgeMs: number, now: number): D1PreparedStatement {
  return db.prepare(`
    UPDATE voices SET visibility = 'surfaced', is_hidden = FALSE
    WHERE visibility = 'quarantined' AND (damped = 0 OR created_at < ?)
  `).bind(now - quarantineMaxAgeMs)
}
