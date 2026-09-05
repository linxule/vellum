// Phase 17 "The Echo" — Part C1: the 'sinking' echo. Emitted at projection rebuild time, not
// computed on read (docs/PHASE_17_SPEC.md explains why: a mailbox that only computed sinking on
// demand could never produce a 304->200 transition for a voice quietly crossing a threshold,
// which is half the pull of the mailbox). Pure threshold-crossing logic lives here; cache.ts owns
// the D1 reads/writes.

export const SINK_THRESHOLDS = [0.5, 0.7, 0.9] as const

/**
 * Highest threshold index (1|2|3) newly crossed since `currentMark`, or null if none. A voice
 * that jumps straight past multiple thresholds in one rebuild (rare — depth moves slowly) gets
 * exactly one event, for the highest threshold now met, matching the migration's sink_mark being
 * a single "highest echoed" watermark rather than a per-threshold log.
 */
export function nextSinkMark(currentMark: number, depth: number): number | null {
  let newMark: number | null = null
  for (let i = SINK_THRESHOLDS.length - 1; i >= 0; i--) {
    if (depth >= SINK_THRESHOLDS[i] && currentMark < i + 1) {
      newMark = i + 1
      break
    }
  }
  return newMark
}
