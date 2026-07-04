import { FAMILIES, type WarmthEntry, type WarmthRow } from './types'

const WARMTH_DECAY_RATE = 0.029

export function computeWarmthValue(entry: { score: number; last_updated: number }, now: number): number {
  const elapsed = (now - entry.last_updated) / 3_600_000
  return entry.score * Math.exp(-elapsed * WARMTH_DECAY_RATE)
}

export async function getWarmth(db: D1Database, family: string): Promise<number> {
  const entry = await db.prepare(`
    SELECT score, last_updated
    FROM warmth_state
    WHERE family = ?
  `).bind(family).first<WarmthEntry>()

  if (!entry) return 0
  return computeWarmthValue(entry, Date.now())
}

export async function getWarmthMap(db: D1Database): Promise<Record<string, number>> {
  const result = await db.prepare(`
    SELECT family, score, last_updated
    FROM warmth_state
  `).all<WarmthRow>()

  const now = Date.now()
  const warmths = Object.fromEntries(FAMILIES.map(family => [family, 0])) as Record<string, number>
  for (const row of result.results ?? []) {
    warmths[row.family] = computeWarmthValue(row, now)
  }
  return warmths
}

export async function updateWarmth(db: D1Database, family: string, dwell_s: number): Promise<void> {
  const now = Date.now()
  const contribution = Math.min(dwell_s / 60, 1.0)

  // Single atomic UPSERT: insert new family or decay-then-add for existing.
  // D1's SQLite build includes math functions (EXP). This replaces the former
  // 5-retry CAS loop (worst case 10 D1 statements) with 1 statement, zero retries.
  await db.prepare(`
    INSERT INTO warmth_state (family, score, last_updated)
    VALUES (?1, ?2, ?3)
    ON CONFLICT(family) DO UPDATE SET
      score = warmth_state.score * EXP(-${WARMTH_DECAY_RATE} * (?3 - warmth_state.last_updated) / 3600000.0) + ?2,
      last_updated = ?3
  `).bind(family, contribution, now).run()
}
