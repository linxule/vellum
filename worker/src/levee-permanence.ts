// Phase 16 "The Levee" — Part C: permanence weighting. Permanence is a rendering property
// (depth floor + unconditional foundation inclusion), not a gate; this module decides who has
// earned it. Pure functions plus one crypto helper (weaverBucket), no D1/KV access. The bar
// itself (weavers, clock hours, legacy cutoff) lives in contract.ts's LEVEE.permanence.

export interface WeaveLogRow {
  weaverKey: string
  hourBucket: number
}

/**
 * Both conditions must hold: at least `minWeavers` distinct weavers AND those rows spanning at
 * least `minHourBuckets` distinct clock-hour buckets. Below that, qualified_weavers reads 0 rather
 * than a partial count — the column IS the read-site predicate (`>= minWeavers`), so a number
 * below the bar would be indistinguishable from "condition 1 not yet met" and a number at or above
 * it written before condition 2 holds would wrongly grant permanence early.
 * No defaults: every caller passes LEVEE.permanence (contract.ts), the single source of the bar.
 */
export function computeQualifiedWeavers(rows: WeaveLogRow[], minWeavers: number, minHourBuckets: number): number {
  const distinctWeavers = new Set(rows.map(r => r.weaverKey))
  const distinctHours = new Set(rows.map(r => r.hourBucket))
  if (distinctWeavers.size >= minWeavers && distinctHours.size >= minHourBuckets) return distinctWeavers.size
  return 0
}

export function isPermanent(row: { qualified_weavers: number; permanence_source?: 'legacy' | 'earned' }, minWeavers: number): boolean {
  return row.permanence_source === 'legacy' || row.qualified_weavers >= minWeavers
}

/**
 * The weave_log rows that count toward one source voice's permanence, one bind: the source id.
 * Shared by tools/weave.ts and handlers/rest-weave.ts; migration 0014 states the same rule in SQL.
 * Weaver key: the agent id, else the network bucket, else — only for a row older than
 * `legacyWeaveCutoffMs`, written before either column existed — one key per weaving session. A
 * newer row with neither has a NULL key and does not count (the anti-farming guard).
 * LEFT JOIN: a row that names the voice its weave produced counts only while that voice is
 * surfaced (a settling weaver waits); a row from before weaver_voice_id existed names none and
 * is kept.
 */
export function weaverRowsSql(legacyWeaveCutoffMs: number): string {
  return `SELECT COALESCE(wl.weaver_id, wl.weaver_bucket,
              CASE WHEN wl.created_at < ${legacyWeaveCutoffMs} THEN 'legacy:' || wl.weaver_trace_id END) as weaver_key,
            wl.created_at
     FROM weave_log wl LEFT JOIN voices v ON v.id = wl.weaver_voice_id
     WHERE wl.source_voice_id = ?
       AND (wl.weaver_voice_id IS NULL OR v.visibility = 'surfaced')`
}

export function toWeaveLogRows(rows: { weaver_key: string | null; created_at: number }[]): WeaveLogRow[] {
  return rows.filter(r => r.weaver_key).map(r => ({ weaverKey: r.weaver_key as string, hourBucket: hourBucketOf(r.created_at) }))
}

/**
 * Phase 17: the raw distinct-weaver-identity count, ignoring the hour-bucket gate.
 * `qualified_weavers` alone can never express partial progress — it reads 0 until BOTH
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
