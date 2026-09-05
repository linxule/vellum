// Phase 17 "The Echo" — Part C/D shared helpers: echo_events writes/reads, the agents upsert, and
// the "debts" query. Split from handlers/echo.ts (the public GET/HEAD /echo/{id} HTTP handler) so
// tools/sense-space.ts (D3's echo_trace alias + D11's auto-digest) and the write paths
// (tools/weave.ts, handlers/rest-weave.ts, cache.ts's sinking sweep) share one implementation of
// "what an echo event is" rather than three drifting copies.

import type { Env } from './types'
import { sanitizeQuoted, escapeQuoted } from './quoted'

const ECHO_MAX_KV_TTL_S = 90 * 24 * 3600

function echoKvKey(id: string): string {
  return `echo:max:${id}`
}

/** Post-review fix (item 1): the ONLY writer of `echo:max:<id>` — both the cold-cache-populate
 * branch in `handlers/echo.ts`'s GET/HEAD path and every write path that inserts an echo_events
 * row (`refreshEchoCache` below) call this, so there is exactly one place that knows the key
 * shape and TTL. */
export async function writeCachedMaxN(kv: KVNamespace, id: string, maxN: number): Promise<void> {
  await kv.put(echoKvKey(id), String(maxN), { expirationTtl: ECHO_MAX_KV_TTL_S })
}

export async function readCachedMaxN(kv: KVNamespace, id: string): Promise<number | null> {
  const raw = await kv.get(echoKvKey(id))
  if (raw === null) return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

/**
 * Post-review fix (item 1): the `echo:max:<id>` KV cache was written once on a cold GET and never
 * updated again — a polling agent's conditional GET returned 304 forever after its first poll,
 * even as new echo_events rows landed. Every write path that inserts an echo_events row for an
 * agent MUST call this afterward (never on the read path, which only populates a cold cache).
 * Re-reads the authoritative MAX(n) from D1 rather than threading each insert's own `n` through
 * every call site (some ride a shared `db.batch()`) — always correct regardless of call order,
 * at the cost of one extra indexed D1 read per echo-emitting write. Never blocks or fails a
 * write: errors are logged and swallowed, same as every other echo emission in this codebase. */
export async function refreshEchoCache(env: Pick<Env, 'DB' | 'KV'>, id: string): Promise<void> {
  try {
    const n = await maxEventN(env.DB, id)
    await writeCachedMaxN(env.KV, id, n)
  } catch (e) { console.error('[echo] cache refresh failed:', e) }
}

export interface EchoEventRow {
  n: number
  agent_id: string
  kind: string
  voice_id: string
  by_voice: string | null
  by_id: string | null
  at: number
  payload: string
}

export interface DebtRow {
  id: string
  distinct_weavers: number
}

const MAX_PAYLOAD_BYTES = 1024

/** Defensive belt-and-braces: field caps already keep payloads small, but this guarantees the
 * ≤1024-byte invariant (test-enforced) regardless of future payload shapes. */
function encodePayload(payload: Record<string, unknown>): string {
  let candidate = payload
  let json = JSON.stringify(candidate)
  while (new TextEncoder().encode(json).length > MAX_PAYLOAD_BYTES && typeof candidate.text === 'string' && candidate.text.length > 0) {
    candidate = { ...candidate, text: (candidate.text as string).slice(0, Math.max(0, (candidate.text as string).length - 20)) }
    json = JSON.stringify(candidate)
  }
  return json
}

export function buildWovenPayload(input: { text: string; family: string; weavers: number; qualified: number; permanentIn: number; hop: 1 | 2 }): string {
  return encodePayload({
    kind: 'woven',
    text: sanitizeQuoted(input.text, 200),
    family: input.family,
    weavers: input.weavers,
    qualified: input.qualified,
    permanent_in: input.permanentIn,
    hop: input.hop,
  })
}

export function buildSinkingPayload(input: { depth: number; threshold: number; weavers: number }): string {
  return encodePayload({
    kind: 'sinking',
    depth: Math.round(input.depth * 100) / 100,
    threshold: input.threshold,
    weavers: input.weavers,
  })
}

export function buildRootedPayload(input: { weavers: number; qualified: number }): string {
  return encodePayload({ kind: 'rooted', weavers: input.weavers, qualified: input.qualified })
}

/** Phase 18 Part A6 — 'room_woven': owner echo when anyone weaves into their room. */
export function buildRoomWovenPayload(input: { members: number }): string {
  return encodePayload({ kind: 'room_woven', members: input.members })
}

/** Phase 18 Part B10 — 'surface_woven': owner echo, daily-coalesced, first weave/imprint on their
 * surface per calendar day. Post-review fix (item 3): `surface` rides in the payload itself —
 * `echo_events` has no `surface_id` column, and an owner can hold more than one surface, so the
 * coalescing check (touchSurfaceActivity's own `MAX(at)` read) needs a per-surface key to compare
 * against. Cheaper than a migration: the column would need backfilling for zero benefit, since
 * every read of it is already this one coalescing check. */
export function buildSurfaceWovenPayload(input: { voices: number; surface: string }): string {
  return encodePayload({ kind: 'surface_woven', voices: input.voices, surface: input.surface })
}

/** Phase 18 Part A6 (post-review implementation) — 'room_fading': owner echo, 48h before a
 * room's `expires_at`, emitted by the same rebuild-time sweep as 'sinking' (cache.ts). */
export function buildRoomFadingPayload(input: { expiresAt: number }): string {
  return encodePayload({ kind: 'room_fading', expires_at: input.expiresAt })
}

/** Phase 18 Part B10 (post-review implementation) — 'surface_warmed': owner echo, when any
 * current on their surface crosses warmth 1.0 from below, gated to once per current per week. */
export function buildSurfaceWarmedPayload(input: { family: string }): string {
  return encodePayload({ kind: 'surface_warmed', family: input.family })
}

/** Appended to a write batch — never called standalone (agents upsert happens only alongside a
 * write that names an author). */
export function agentUpsertStatement(db: D1Database, agentId: string, now: number) {
  return db.prepare(
    `INSERT INTO agents (id, first_seen, last_seen) VALUES (?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET last_seen = excluded.last_seen`,
  ).bind(agentId, now, now)
}

export function echoEventInsertStatement(
  db: D1Database,
  row: { agentId: string; kind: string; voiceId: string; byVoice: string | null; byId: string | null; at: number; payload: string },
) {
  return db.prepare(
    'INSERT INTO echo_events (agent_id, kind, voice_id, by_voice, by_id, at, payload) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).bind(row.agentId, row.kind, row.voiceId, row.byVoice, row.byId, row.at, row.payload)
}

/** Ascending by n after a cursor — the shape a cron/poller wants (Part D1). */
export async function fetchEchoEventsAfter(db: D1Database, agentId: string, after: number, limit: number): Promise<EchoEventRow[]> {
  const res = await db.prepare(
    'SELECT n, agent_id, kind, voice_id, by_voice, by_id, at, payload FROM echo_events WHERE agent_id = ? AND n > ? ORDER BY n ASC LIMIT ?',
  ).bind(agentId, after, limit).all<EchoEventRow>()
  return res.results ?? []
}

/** Descending, most-recent-first — the shape sense_space's auto-digest and echo_trace alias want
 * (Part D3). */
export async function fetchEchoEventsRecent(db: D1Database, agentId: string, limit: number): Promise<EchoEventRow[]> {
  const res = await db.prepare(
    'SELECT n, agent_id, kind, voice_id, by_voice, by_id, at, payload FROM echo_events WHERE agent_id = ? ORDER BY n DESC LIMIT ?',
  ).bind(agentId, limit).all<EchoEventRow>()
  return res.results ?? []
}

export async function maxEventN(db: D1Database, agentId: string): Promise<number> {
  const row = await db.prepare('SELECT MAX(n) as max_n FROM echo_events WHERE agent_id = ?').bind(agentId).first<{ max_n: number | null }>()
  return row?.max_n ?? 0
}

/** Debts: the author's own voices one weave short of permanence — a state, not an event.
 * `distinct_weavers` (Phase 17's own column, see docs/PHASE_17_REPORT.md deviations) tracks raw
 * distinct-weaver-identity progress; `qualified_weavers` alone cannot express 7-9 (it is 0 until
 * BOTH permanence conditions hold, then jumps straight to the true count). */
export async function fetchDebts(db: D1Database, agentId: string, limit = 10): Promise<DebtRow[]> {
  const res = await db.prepare(
    `SELECT id, distinct_weavers FROM voices
     WHERE author_id = ? AND distinct_weavers BETWEEN 7 AND 9 AND rooted_at IS NULL AND is_hidden = FALSE
     ORDER BY distinct_weavers DESC LIMIT ?`,
  ).bind(agentId, limit).all<DebtRow>()
  return res.results ?? []
}

/** Prose rendering shared by sense_space's `a_` alias (D3) and its auto-digest (D11). Kept
 * intentionally terse — echoes are facts, never instructions (design law). */
export function renderEchoLines(events: EchoEventRow[], debts: DebtRow[]): string {
  if (events.length === 0 && debts.length === 0) return '  (no echoes yet)'
  const lines = events.map(e => {
    const payload = safeParsePayload(e.payload)
    switch (e.kind) {
      case 'woven': {
        const text = typeof payload.text === 'string' ? payload.text : ''
        return `  "${escapeQuoted(text)}" carried ${e.voice_id} forward (${payload.weavers ?? '?'} weavers, ${payload.qualified ?? 0} qualified)`
      }
      case 'sinking':
        return `  ${e.voice_id} is sinking (depth ${payload.depth ?? '?'}, past ${payload.threshold ?? '?'})`
      case 'rooted':
        return `  ${e.voice_id} put down roots (${payload.weavers ?? '?'} weavers)`
      case 'room_fading':
        return `  room ${e.voice_id} is fading soon (expires ${typeof payload.expires_at === 'number' ? new Date(payload.expires_at).toISOString() : '?'})`
      case 'surface_warmed':
        return `  ${payload.family ?? '?'} warmed past 1.0 on your surface`
      default:
        return `  ${e.voice_id}: ${e.kind}`
    }
  })
  if (debts.length > 0) {
    lines.push(`  debts: ${debts.map(d => `${d.id} (${d.distinct_weavers}/10)`).join(', ')}`)
  }
  return lines.join('\n')
}

function safeParsePayload(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

export async function readAgentRow(env: Env, agentId: string): Promise<{ id: string; first_seen: number; last_seen: number } | null> {
  return env.DB.prepare('SELECT id, first_seen, last_seen FROM agents WHERE id = ?').bind(agentId).first()
}
