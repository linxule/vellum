import { FAMILIES, type WarmthEntry, type WarmthRow } from './types'
import { DEFAULT_SURFACE } from './surfaces'

const WARMTH_DECAY_RATE = 0.029

export function computeWarmthValue(entry: { score: number; last_updated: number }, now: number): number {
  const elapsed = (now - entry.last_updated) / 3_600_000
  return entry.score * Math.exp(-elapsed * WARMTH_DECAY_RATE)
}

// Phase 18 Part B1/B3: warmth_state's PRIMARY KEY became (surface_id, family) — every function
// here gains a `surface` parameter, defaulting to the default ocean so every pre-Phase-18 caller
// (and every caller that has no reason to care about surfaces) is unaffected.
export async function getWarmth(db: D1Database, family: string, surface: string = DEFAULT_SURFACE): Promise<number> {
  const entry = await db.prepare(`
    SELECT score, last_updated
    FROM warmth_state
    WHERE family = ? AND surface_id = ?
  `).bind(family, surface).first<WarmthEntry>()

  if (!entry) return 0
  return computeWarmthValue(entry, Date.now())
}

export async function getWarmthMap(db: D1Database, surface: string = DEFAULT_SURFACE): Promise<Record<string, number>> {
  const result = await db.prepare(`
    SELECT family, score, last_updated
    FROM warmth_state
    WHERE surface_id = ?
  `).bind(surface).all<WarmthRow>()

  const now = Date.now()
  const warmths = Object.fromEntries(FAMILIES.map(family => [family, 0])) as Record<string, number>
  for (const row of result.results ?? []) {
    warmths[row.family] = computeWarmthValue(row, now)
  }
  return warmths
}

export interface WarmthCheckpoint {
  checkedScore: number
  warmedEchoedAt: number | null
}

/**
 * Post-review fix (item 6, 'surface_warmed'): the crossing-detection state cache.ts's rebuild
 * sweep needs — a snapshot of the score last time the sweep looked, plus the last time it
 * actually echoed (the once-per-week gate). Separate from `getWarmthMap`'s live-decayed score:
 * `checked_score` is a plain stored value, only ever written by that same sweep. Missing rows
 * (every pre-Phase-18-gap-fix row, and any family that has never crossed) read as
 * `{ checkedScore: 0, warmedEchoedAt: null }` — always "was below 1.0, never echoed".
 */
export async function getWarmthCheckpoints(db: D1Database, surface: string = DEFAULT_SURFACE): Promise<Record<string, WarmthCheckpoint>> {
  const result = await db.prepare(`
    SELECT family, checked_score, warmed_echoed_at
    FROM warmth_state
    WHERE surface_id = ?
  `).bind(surface).all<{ family: string; checked_score: number | null; warmed_echoed_at: number | null }>()

  const checkpoints = Object.fromEntries(FAMILIES.map(family => [family, { checkedScore: 0, warmedEchoedAt: null }])) as Record<string, WarmthCheckpoint>
  for (const row of result.results ?? []) {
    checkpoints[row.family] = { checkedScore: row.checked_score ?? 0, warmedEchoedAt: row.warmed_echoed_at ?? null }
  }
  return checkpoints
}

export async function updateWarmth(db: D1Database, family: string, dwell_s: number, surface: string = DEFAULT_SURFACE): Promise<void> {
  const now = Date.now()
  const contribution = Math.min(dwell_s / 60, 1.0)

  // Single atomic UPSERT: insert new (surface, family) or decay-then-add for existing.
  // D1's SQLite build includes math functions (EXP). This replaces the former
  // 5-retry CAS loop (worst case 10 D1 statements) with 1 statement, zero retries.
  await db.prepare(`
    INSERT INTO warmth_state (surface_id, family, score, last_updated)
    VALUES (?1, ?2, ?3, ?4)
    ON CONFLICT(surface_id, family) DO UPDATE SET
      score = warmth_state.score * EXP(-${WARMTH_DECAY_RATE} * (?4 - warmth_state.last_updated) / 3600000.0) + ?3,
      last_updated = ?4
  `).bind(surface, family, contribution, now).run()
}

/** Match discover's family-level ordering, including its weave-count tie break. */
export function sortByWarmth<T extends { family: string; weave_count: number }>(voices: T[], warmth: ReadonlyMap<string, number>): T[] {
  return voices.sort((a, b) => (warmth.get(b.family) ?? 0) - (warmth.get(a.family) ?? 0) || b.weave_count - a.weave_count)
}
