// Phase 16 "The Levee" — Part C: permanence weighting. Permanence is a rendering property
// (depth floor + unconditional foundation inclusion), not a gate; this module decides who has
// earned it. Pure functions plus one crypto helper (weaverBucket), no D1/KV access.

export interface WeaveLogRow {
  weaverKey: string
  hourBucket: number
}

/**
 * Both conditions must hold: >=10 distinct weavers (network buckets, or minted ids once Phase 17
 * ships) AND those rows span >=6 distinct clock-hour buckets. Below that, qualified_weavers reads
 * 0 rather than a partial count — the column IS the read-site predicate (`>= 10`), so a number
 * between 1 and 9 would be indistinguishable from "condition 1 not yet met" and a number >=10
 * written before condition 2 holds would wrongly grant permanence early.
 */
export function computeQualifiedWeavers(rows: WeaveLogRow[], minWeavers = 10, minHourBuckets = 6): number {
  const distinctWeavers = new Set(rows.map(r => r.weaverKey))
  const distinctHours = new Set(rows.map(r => r.hourBucket))
  if (distinctWeavers.size >= minWeavers && distinctHours.size >= minHourBuckets) return distinctWeavers.size
  return 0
}

export function isPermanent(row: { qualified_weavers: number; permanence_source?: 'legacy' | 'earned' }, minWeavers = 10): boolean {
  return row.permanence_source === 'legacy' || row.qualified_weavers >= minWeavers
}

/**
 * Phase 17: the raw distinct-weaver-identity count, ignoring the hour-bucket gate.
 * `qualified_weavers` alone can never express partial progress (7, 8, 9) — it reads 0 until BOTH
 * permanence conditions hold, then jumps straight to the true count (see computeQualifiedWeavers'
 * own doc comment). Echo's "debts" and "permanent_in" narrative numbers need a number that moves
 * one at a time as distinct minds carry a voice forward, so this is tracked separately in
 * `voices.distinct_weavers` (Phase 17's own migration column — not in the design brief, which
 * assumed qualified_weavers could serve both roles; see docs/PHASE_17_REPORT.md deviations).
 */
export function computeDistinctWeavers(rows: WeaveLogRow[]): number {
  return new Set(rows.map(r => r.weaverKey)).size
}

export function hourBucketOf(timestampMs: number): number {
  return Math.floor(timestampMs / 3_600_000)
}

/**
 * Coarse network bucket (IPv4 /24, IPv6 /48), salted-hashed with SESSION_SECRET so weave_log is
 * never an IP ledger. Returned as 16 hex chars — collision-acceptable, this only needs to compare
 * equal for the same coarse network, not resist adversarial recovery of the IP.
 */
export async function weaverBucket(ip: string, secret: string): Promise<string> {
  const coarse = ip.includes(':')
    ? ip.split(':').slice(0, 3).join(':') + '::/48'
    : ip.split('.').slice(0, 3).join('.') + '.0/24'
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret + ':' + coarse))
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('').slice(0, 16)
}
