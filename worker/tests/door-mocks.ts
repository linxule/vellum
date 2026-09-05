// Phase 15 transport fixtures extend the hand-rolled DB, never its projection SQL matchers.
import { mock } from 'bun:test'
import { MockD1, MockKV, MockExecutionContext, MockAnalytics } from './mocks'
import type { Env, VoiceRow, Family } from '../src/types'
import { FAMILIES } from '../src/types'
import { signSessionId } from '../src/hmac'

const htmlText = await Bun.file(new URL('../../app/dist/mcp-app.html', import.meta.url)).text()
mock.module('../../app/dist/mcp-app.html', () => ({ default: htmlText }))
const agentsText = await Bun.file(new URL('../../AGENTS.md', import.meta.url)).text()
mock.module('../../AGENTS.md', () => ({ default: agentsText }))
export const { default: worker, handleMCP } = await import('../src/index')

const norm = (sql: string) => sql.replace(/\s+/g, ' ').trim()
export const voice = (id = 'v:source', text = 'The original thought', extra: Partial<VoiceRow> = {}): VoiceRow => ({
  id, text, language: 'en', created_at: Date.now(), trace_id: null, model: null, declared_model: null,
  weave_count: 0, unique_weavers: 0, weave_from: null, is_hidden: 0,
  content_hash: null, simhash: null, damped: 0, qualified_weavers: 0, permanence_source: 'earned', visibility: 'surfaced',
  // Post-review fix (item 2)
  writer_bucket: null,
  // Phase 17 "The Echo"
  author_id: null, sink_mark: 0, rooted_at: null, distinct_weavers: 0,
  // Phase 18 "The Archipelago"
  surface_id: 'vellum', room_id: null,
  ...extra,
})

type AgentRow = { id: string; first_seen: number; last_seen: number }
type EchoEventRow = { n: number; agent_id: string; kind: string; voice_id: string; by_voice: string | null; by_id: string | null; at: number; payload: string }
type OpReceiptRow = { op_key: string; body_hash: string; status: number; receipt: string; created_at: number }
type RoomRow = { seed_voice_id: string; surface_id: string; name: string; invitation: string; author_id: string; created_at: number; last_activity_at: number; expires_at: number; fading_echoed_at?: number | null }
type SurfaceRow = { id: string; name: string; invitation: string; founding_voice_id: string; author_id: string; created_at: number; last_activity_at: number; listed_until: number }

export class DoorD1 extends MockD1 {
  sourceReads = 0
  failReads = false
  // Phase 18 "The Archipelago"
  rooms: RoomRow[] = []
  surfaces: SurfaceRow[] = []
  private weavers = new Map<string, Set<string>>()
  // Post-review fix (item 3): per-row weave_log state (keyed `${sourceVoiceId}::${weaverTraceId}`,
  // matching the real PRIMARY KEY — INSERT OR IGNORE semantics), so the qualified_weavers
  // recompute can join against the weaving voice's own visibility.
  private weaveLogRows = new Map<string, { sourceVoiceId: string; weaverKey: string; weaverVoiceId: string; createdAt: number }>()
  // Phase 17 "The Echo" state
  agents = new Map<string, AgentRow>()
  echoEvents: EchoEventRow[] = []
  private echoN = 0
  opReceipts = new Map<string, OpReceiptRow>()
  override async first<T>(sql: string, args: unknown[]): Promise<T | null> {
    const n = norm(sql)
    if (this.failReads) throw new Error('private database failure')
    if (n === 'SELECT * FROM voices WHERE id = ? AND is_hidden = FALSE') {
      this.sourceReads++
      return (this.voices.find(v => v.id === args[0] && !v.is_hidden) ?? null) as T | null
    }
    // Post-review fix (item 1): buildLineage's seed lookup + ancestor walk (handlers/lineage.ts)
    // both now carry `AND surface_id = ?`.
    if (n === 'SELECT * FROM voices WHERE id = ? AND is_hidden = FALSE AND surface_id = ?') {
      this.sourceReads++
      const [id, surfaceId] = args as [string, string]
      return (this.voices.find(v => v.id === id && !v.is_hidden && (v.surface_id ?? 'vellum') === surfaceId) ?? null) as T | null
    }
    if (n === "SELECT * FROM voices WHERE id = ? AND surface_id = ? AND visibility != 'hidden'") {
      this.sourceReads++
      const [id, surface] = args as [string, string]
      return (this.voices.find(v => v.id === id && (v.surface_id ?? 'vellum') === surface && (v.visibility ?? 'surfaced') !== 'hidden') ?? null) as T | null
    }
    if (n.includes('FROM voices WHERE text = ?')) {
      const [text, surface] = args as [string, string]
      return (this.voices.find(v => v.text === text && !v.is_hidden && (v.surface_id ?? 'vellum') === surface) ?? null) as T | null
    }
    if (n.includes('TRIM(RTRIM(LOWER')) {
      const [normalized, surface] = args as [string, string]
      return (this.voices.find(v => !v.is_hidden && (v.surface_id ?? 'vellum') === surface && v.text.toLowerCase().replace(/\s+/g, ' ').replace(/[.!?,;:]+$/, '').trim() === normalized) ?? null) as T | null
    }
    if (n.includes('text LIKE ?')) {
      const [likePattern, surface] = args as [string, string]
      const fragment = likePattern.slice(1, -1).replace(/\\([%_])/g, '$1')
      return (this.voices.find(v => !v.is_hidden && (v.surface_id ?? 'vellum') === surface && v.text.includes(fragment)) ?? null) as T | null
    }
    // Phase 18 Part A — rooms table lookups.
    if (n === 'SELECT * FROM rooms WHERE seed_voice_id = ? AND surface_id = ?') {
      const [seedId, surface] = args as [string, string]
      return (this.rooms.find(r => r.seed_voice_id === seedId && r.surface_id === surface) ?? null) as T | null
    }
    if (n === 'SELECT * FROM rooms WHERE seed_voice_id = ?') {
      return (this.rooms.find(r => r.seed_voice_id === args[0]) ?? null) as T | null
    }
    if (n === "SELECT * FROM rooms WHERE surface_id = ? AND name = ? AND expires_at > ? ORDER BY last_activity_at DESC LIMIT 1") {
      const [surface, name, now] = args as [string, string, number]
      const matches = this.rooms.filter(r => r.surface_id === surface && r.name === name && r.expires_at > now)
        .sort((a, b) => b.last_activity_at - a.last_activity_at)
      return (matches[0] ?? null) as T | null
    }
    if (n === 'SELECT author_id, expires_at FROM rooms WHERE seed_voice_id = ?') {
      const r = this.rooms.find(r => r.seed_voice_id === args[0])
      return (r ? { author_id: r.author_id, expires_at: r.expires_at } : null) as T | null
    }
    if (n === 'SELECT id, author_id, surface_id, room_id FROM voices WHERE id = ? AND is_hidden = FALSE') {
      const v = this.voices.find(v => v.id === args[0] && !v.is_hidden)
      return (v ? { id: v.id, author_id: v.author_id ?? null, surface_id: v.surface_id ?? 'vellum', room_id: v.room_id ?? null } : null) as T | null
    }
    if (n === 'SELECT COUNT(*) as cnt FROM voices WHERE room_id = ? AND is_hidden = FALSE') {
      return { cnt: this.voices.filter(v => v.room_id === args[0] && !v.is_hidden).length } as T
    }
    // Phase 18 Part B — surfaces table lookups.
    if (n === 'SELECT id FROM surfaces WHERE id = ?') {
      return (this.surfaces.find(s => s.id === args[0]) ? { id: args[0] } : null) as T | null
    }
    if (n === 'SELECT id as slug, name, invitation FROM surfaces WHERE id = ?') {
      const s = this.surfaces.find(s => s.id === args[0])
      return (s ? { slug: s.id, name: s.name, invitation: s.invitation } : null) as T | null
    }
    if (n === 'SELECT id, name, invitation FROM surfaces WHERE id = ?') {
      const s = this.surfaces.find(s => s.id === args[0])
      return (s ? { id: s.id, name: s.name, invitation: s.invitation } : null) as T | null
    }
    if (n === 'SELECT * FROM surfaces WHERE id = ?') {
      return (this.surfaces.find(s => s.id === args[0]) ?? null) as T | null
    }
    if (n === 'SELECT author_id, listed_until FROM surfaces WHERE id = ?') {
      const s = this.surfaces.find(s => s.id === args[0])
      return (s ? { author_id: s.author_id, listed_until: s.listed_until } : null) as T | null
    }
    if (n === 'SELECT listed_until FROM surfaces WHERE id = ?') {
      const s = this.surfaces.find(s => s.id === args[0])
      return (s ? { listed_until: s.listed_until } : null) as T | null
    }
    // Post-review fix (item 6): cache.ts's 'surface_warmed' sweep looks up just the owner.
    if (n === 'SELECT author_id FROM surfaces WHERE id = ?') {
      const s = this.surfaces.find(s => s.id === args[0])
      return (s ? { author_id: s.author_id } : null) as T | null
    }
    if (n === 'SELECT weave_count, unique_weavers FROM voices WHERE id = ?') return (this.voices.find(v => v.id === args[0]) ?? null) as T | null
    // Phase 17 "The Echo" — these author_id-scoped counts share the "SELECT COUNT(*) as cnt FROM
    // voices" prefix with the pre-existing generic total-count query below, so they MUST be
    // checked first (more specific matcher wins).
    if (n.startsWith('SELECT COUNT(*) as cnt FROM voices WHERE author_id = ?')) {
      const authorId = String(args[0])
      if (n.includes('weave_count > 0')) return { cnt: this.voices.filter(v => v.author_id === authorId && v.weave_count > 0 && !v.is_hidden).length } as T
      if (n.includes('rooted_at IS NOT NULL')) return { cnt: this.voices.filter(v => v.author_id === authorId && v.rooted_at).length } as T
      if (n.includes('distinct_weavers BETWEEN 7 AND 9')) return { cnt: this.voices.filter(v => v.author_id === authorId && (v.distinct_weavers ?? 0) >= 7 && (v.distinct_weavers ?? 0) <= 9 && !v.rooted_at && !v.is_hidden).length } as T
      return { cnt: this.voices.filter(v => v.author_id === authorId && !v.is_hidden).length } as T
    }
    // Post-review fix (item 2): the fuse's returning-writer check — a returning writer is any
    // surfaced voice matching the named author id, the MCP session trace id, or the anonymous
    // network bucket. All three binds are always present (empty string when not applicable),
    // matching the fixed literal SQL text levee-admission.ts always issues.
    if (n === "SELECT COUNT(*) as cnt FROM voices WHERE visibility = 'surfaced' AND (author_id = ? OR trace_id = ? OR writer_bucket = ?)") {
      const [authorId, traceId, bucket] = args as [string, string, string]
      const cnt = this.voices.filter(v => (v.visibility ?? 'surfaced') === 'surfaced' && (
        (Boolean(authorId) && v.author_id === authorId) ||
        (Boolean(traceId) && v.trace_id === traceId) ||
        (Boolean(bucket) && v.writer_bucket === bucket)
      )).length
      return { cnt } as T
    }
    // Post-review fix (item 1): /api/admin/stats's levee block — previously unmatched (silently
    // caught, always reading 0 regardless of real state).
    if (n === "SELECT COUNT(*) as cnt FROM voices WHERE visibility = 'quarantined'") {
      return { cnt: this.voices.filter(v => v.visibility === 'quarantined').length } as T
    }
    if (n === 'SELECT COUNT(*) as cnt FROM voices WHERE damped = 1') {
      return { cnt: this.voices.filter(v => (v.damped ?? 0) === 1).length } as T
    }
    if (n === "SELECT COUNT(*) as cnt FROM voices WHERE is_hidden != (visibility != 'surfaced')") {
      return { cnt: this.voices.filter(v => Boolean(v.is_hidden) !== ((v.visibility ?? 'surfaced') !== 'surfaced')).length } as T
    }
    if (n === 'SELECT COUNT(*) as cnt FROM voices WHERE is_hidden = FALSE AND created_at > ?') {
      return { cnt: this.voices.filter(v => !v.is_hidden && v.created_at > Number(args[0])).length } as T
    }
    if (n.startsWith('SELECT COUNT(*) as cnt FROM voices')) return { cnt: this.voices.filter(v => !v.is_hidden).length } as T
    if (n.includes('MIN(created_at)')) return { oldest: Date.now() } as T
    if (n === 'SELECT author_id, distinct_weavers, qualified_weavers FROM voices WHERE id = ?') {
      const v = this.voices.find(v => v.id === args[0])
      return (v ? { author_id: v.author_id ?? null, distinct_weavers: v.distinct_weavers ?? 0, qualified_weavers: v.qualified_weavers ?? 0 } : null) as T | null
    }
    // /api/admin/stats's levee ceiling counters and the write-attempts counter — all read the
    // same single-column shape (production code, not the pre-existing `count, expires_at` variant
    // mocks.ts already handles for checkAndIncrementRateLimit's own read-back).
    if (n === 'SELECT count FROM rate_limits WHERE key = ?') {
      const row = this.rateLimits.find(r => r.key === args[0])
      return (row ? { count: row.count } : null) as T | null
    }
    if (n === 'SELECT id, first_seen, last_seen FROM agents WHERE id = ?') return (this.agents.get(String(args[0])) ?? null) as T | null
    if (n.startsWith('SELECT COUNT(DISTINCT COALESCE(weaver_id, weaver_bucket)) as cnt FROM weave_log')) {
      const authorId = String(args[0])
      const sourceIds = new Set(this.voices.filter(v => v.author_id === authorId).map(v => v.id))
      const distinct = new Set<string>()
      for (const [sourceId, set] of this.weavers.entries()) {
        if (sourceIds.has(sourceId)) for (const w of set) distinct.add(w)
      }
      return { cnt: distinct.size } as T
    }
    if (n === 'SELECT op_key, body_hash, status, receipt, created_at FROM op_receipts WHERE op_key = ?') return (this.opReceipts.get(String(args[0])) ?? null) as T | null
    if (n === 'SELECT status, receipt FROM op_receipts WHERE op_key = ?') {
      const row = this.opReceipts.get(String(args[0]))
      return (row ? { status: row.status, receipt: row.receipt } : null) as T | null
    }
    if (n === "SELECT MAX(at) as last_at FROM echo_events WHERE agent_id = ? AND kind = ? AND json_extract(payload, '$.surface') = ?") {
      // Post-review fix (item 3): touchSurfaceActivity's surface_woven coalescing check is now
      // per-surface — the third bound arg is the surface slug, matched against the JSON payload
      // the same way D1's real json_extract would (buildSurfaceWovenPayload always writes it).
      const [agentId, kind, surfaceId] = args as [string, string, string]
      const rows = this.echoEvents.filter(e => e.agent_id === agentId && e.kind === kind && (JSON.parse(e.payload) as { surface?: string }).surface === surfaceId)
      return { last_at: rows.length ? Math.max(...rows.map(e => e.at)) : null } as T
    }
    if (n === 'SELECT MAX(at) as last_at FROM echo_events WHERE agent_id = ? AND kind = ?') {
      const [agentId, kind] = args as [string, string]
      const rows = this.echoEvents.filter(e => e.agent_id === agentId && e.kind === kind)
      return { last_at: rows.length ? Math.max(...rows.map(e => e.at)) : null } as T
    }
    if (n === 'SELECT MAX(at) as last_at FROM echo_events WHERE agent_id = ?') {
      const rows = this.echoEvents.filter(e => e.agent_id === args[0])
      return { last_at: rows.length ? Math.max(...rows.map(e => e.at)) : null } as T
    }
    if (n === 'SELECT MAX(n) as max_n FROM echo_events WHERE agent_id = ?') {
      const rows = this.echoEvents.filter(e => e.agent_id === args[0])
      return { max_n: rows.length ? Math.max(...rows.map(e => e.n)) : null } as T
    }
    return super.first<T>(sql, args)
  }
  override async all<T>(sql: string, args: unknown[]): Promise<{ results: T[] }> {
    const n = norm(sql)
    // Phase 18 Part A2: backfillRoomId's BFS — more specific than the broad weave_from-IN matcher
    // below, so it MUST be checked first.
    if (n.includes('FROM voices WHERE weave_from IN') && n.includes('room_id IS NULL')) {
      return { results: this.voices.filter(v => !v.room_id && args.includes(v.weave_from)).map(v => ({ id: v.id })) as T[] }
    }
    // Post-review fix (item 1): buildLineage's descendant BFS (handlers/lineage.ts) now carries
    // `AND surface_id = ?` — the last bound arg is the surfaceId in that case, the rest the
    // weave_from IN (...) placeholders. Checked before the plain (no-surface) form below.
    if (n.includes('FROM voices WHERE weave_from IN') && n.includes('surface_id = ?')) {
      const surfaceId = args.at(-1) as string
      const frontier = args.slice(0, -1)
      return { results: this.voices.filter(v => !v.is_hidden && frontier.includes(v.weave_from) && (v.surface_id ?? 'vellum') === surfaceId) as T[] }
    }
    if (n.includes('FROM voices WHERE weave_from IN')) return { results: this.voices.filter(v => !v.is_hidden && args.includes(v.weave_from)) as T[] }
    // Phase 18 Part A4 — the fade physics' "who's quietest" scans.
    if (n === 'SELECT seed_voice_id FROM rooms WHERE surface_id = ? AND expires_at > ? ORDER BY last_activity_at ASC') {
      const [surface, now] = args as [string, number]
      const rows = this.rooms.filter(r => r.surface_id === surface && r.expires_at > now).sort((a, b) => a.last_activity_at - b.last_activity_at)
      return { results: rows.map(r => ({ seed_voice_id: r.seed_voice_id })) as T[] }
    }
    if (n === 'SELECT seed_voice_id FROM rooms WHERE author_id = ? AND expires_at > ? ORDER BY last_activity_at ASC') {
      const [authorId, now] = args as [string, number]
      const rows = this.rooms.filter(r => r.author_id === authorId && r.expires_at > now).sort((a, b) => a.last_activity_at - b.last_activity_at)
      return { results: rows.map(r => ({ seed_voice_id: r.seed_voice_id })) as T[] }
    }
    if (n === 'SELECT id FROM surfaces WHERE listed_until > ? ORDER BY last_activity_at ASC') {
      const now = args[0] as number
      const rows = this.surfaces.filter(s => s.listed_until > now).sort((a, b) => a.last_activity_at - b.last_activity_at)
      return { results: rows.map(s => ({ id: s.id })) as T[] }
    }
    if (n === 'SELECT id FROM surfaces WHERE author_id = ? AND listed_until > ? ORDER BY last_activity_at ASC') {
      const [authorId, now] = args as [string, number]
      const rows = this.surfaces.filter(s => s.author_id === authorId && s.listed_until > now).sort((a, b) => a.last_activity_at - b.last_activity_at)
      return { results: rows.map(s => ({ id: s.id })) as T[] }
    }
    // Phase 18 Part A5/B4: sense_space's rooms/surfaces blocks.
    if (n === 'SELECT seed_voice_id, name, invitation, expires_at FROM rooms WHERE surface_id = ? AND expires_at > ? ORDER BY last_activity_at DESC LIMIT ?') {
      const [surface, now, limit] = args as [string, number, number]
      const rows = this.rooms.filter(r => r.surface_id === surface && r.expires_at > now).sort((a, b) => b.last_activity_at - a.last_activity_at).slice(0, limit)
      return { results: rows.map(r => ({ seed_voice_id: r.seed_voice_id, name: r.name, invitation: r.invitation, expires_at: r.expires_at })) as T[] }
    }
    if (n.startsWith('SELECT s.id, s.name, s.invitation, s.last_activity_at')) {
      const [now, exclude, limit] = args as [number, string, number]
      const rows = this.surfaces.filter(s => s.listed_until > now && s.id !== exclude).sort((a, b) => b.last_activity_at - a.last_activity_at).slice(0, limit)
      return { results: rows.map(s => ({ id: s.id, name: s.name, invitation: s.invitation, last_activity_at: s.last_activity_at, voice_count: this.voices.filter(v => v.surface_id === s.id && !v.is_hidden).length })) as T[] }
    }
    if (n.includes('SELECT voice_id, family FROM voice_families')) return { results: this.voiceFamilies.filter(v => v.ordinal === 0 && args.includes(v.voice_id)) as T[] }
    // /api/admin/stats's queries — none of these were previously matched (the route's own
    // Promise.all has no per-query catch, so a throw here has always 500'd the whole route;
    // no prior test parsed its JSON body closely enough to notice).
    if (n === 'SELECT vf.family, COUNT(*) as cnt FROM voice_families vf JOIN voices v ON v.id = vf.voice_id WHERE vf.ordinal = 0 AND v.is_hidden = FALSE GROUP BY vf.family') {
      const counts = new Map<string, number>()
      for (const row of this.voiceFamilies) {
        if (row.ordinal !== 0) continue
        const v = this.voices.find(v => v.id === row.voice_id)
        if (!v || v.is_hidden) continue
        counts.set(row.family, (counts.get(row.family) ?? 0) + 1)
      }
      return { results: [...counts.entries()].map(([family, cnt]) => ({ family, cnt })) as T[] }
    }
    if (n === 'SELECT id, text, weave_count FROM voices WHERE is_hidden = FALSE ORDER BY weave_count DESC LIMIT 10') {
      const rows = this.voices.filter(v => !v.is_hidden).sort((a, b) => b.weave_count - a.weave_count).slice(0, 10)
      return { results: rows.map(v => ({ id: v.id, text: v.text, weave_count: v.weave_count })) as T[] }
    }
    if (n === "SELECT family, score, last_updated FROM warmth_state WHERE surface_id = 'vellum' ORDER BY family") {
      return { results: [...this.warmthState].filter(w => (w.surface_id ?? 'vellum') === 'vellum').sort((a, b) => a.family.localeCompare(b.family)) as T[] }
    }
    // Post-review fix (item 3): the qualified_weavers recompute now joins weave_log against
    // voices to require the weaving voice itself be surfaced (a settling weaver doesn't count
    // until released). Matched by shape rather than the exact literal — both tools/weave.ts and
    // handlers/rest-weave.ts issue the same normalized text, but this stays robust to either.
    if (n.includes('FROM weave_log wl') && n.includes('weaver_voice_id') && n.includes('weaver_key')) {
      const sourceId = String(args[0])
      const results = [...this.weaveLogRows.values()]
        .filter(r => r.sourceVoiceId === sourceId)
        .filter(r => {
          const weaverVoice = this.voices.find(v => v.id === r.weaverVoiceId)
          return weaverVoice && (weaverVoice.visibility ?? 'surfaced') === 'surfaced'
        })
        .map(r => ({ weaver_key: r.weaverKey, created_at: r.createdAt }))
      return { results: results as T[] }
    }
    // Legacy literal (permanence.test.ts exercises the mock's COALESCE shape directly against a
    // pre-fix query text; kept so that unit test stays meaningful without touching app code).
    if (n === 'SELECT COALESCE(weaver_id, weaver_bucket) as weaver_key, created_at FROM weave_log WHERE source_voice_id = ?') {
      const sourceId = String(args[0])
      const weaverSet = this.weavers.get(sourceId) ?? new Set<string>()
      return { results: [...weaverSet].map(w => ({ weaver_key: w, created_at: Date.now() })) as T[] }
    }
    if (n.includes('FROM voices WHERE created_at > ?') && n.includes('content_hash')) {
      const ip = String(args[0]); const since = Number(args[1])
      const rows = this.voices
        .filter(v => !v.is_hidden && v.content_hash && v.created_at > since)
        .sort((a, b) => b.created_at - a.created_at)
        .slice(0, Number(args[2] ?? 500))
        .map(v => ({ id: v.id, content_hash: v.content_hash, simhash: v.simhash, created_at: v.created_at, source: v.trace_id ?? `ip:${ip}` }))
      return { results: rows as T[] }
    }
    // Phase 16 admin routes
    if (n === "SELECT id, text, created_at FROM voices WHERE visibility = 'quarantined' ORDER BY created_at DESC LIMIT ? OFFSET ?") {
      const [limit, offset] = args as [number, number]
      const rows = this.voices.filter(v => v.visibility === 'quarantined').sort((a, b) => b.created_at - a.created_at).slice(offset, offset + limit)
      return { results: rows.map(v => ({ id: v.id, text: v.text, created_at: v.created_at })) as T[] }
    }
    if (n === 'SELECT id FROM voices WHERE content_hash = ? AND is_hidden = FALSE') {
      const rows = this.voices.filter(v => v.content_hash === args[0] && !v.is_hidden)
      return { results: rows.map(v => ({ id: v.id })) as T[] }
    }
    // Post-review fix (item 2): the writer_bucket hide selector now targets voices the bucket
    // actually AUTHORED (voices.writer_bucket), not sources it merely wove.
    if (n === 'SELECT id FROM voices WHERE writer_bucket = ?') {
      const rows = this.voices.filter(v => v.writer_bucket === args[0])
      return { results: rows.map(v => ({ id: v.id })) as T[] }
    }
    // Phase 17 "The Echo"
    if (n.startsWith('SELECT n, agent_id, kind, voice_id, by_voice, by_id, at, payload FROM echo_events WHERE agent_id = ? AND n > ?')) {
      const [agentId, after, limit] = args as [string, number, number]
      const rows = this.echoEvents.filter(e => e.agent_id === agentId && e.n > after).sort((a, b) => a.n - b.n).slice(0, limit)
      return { results: rows as T[] }
    }
    if (n.startsWith('SELECT n, agent_id, kind, voice_id, by_voice, by_id, at, payload FROM echo_events WHERE agent_id = ? ORDER BY n DESC')) {
      const [agentId, limit] = args as [string, number]
      const rows = this.echoEvents.filter(e => e.agent_id === agentId).sort((a, b) => b.n - a.n).slice(0, limit)
      return { results: rows as T[] }
    }
    // Post-review fix (item 6): cache.ts's 'room_fading' sweep — rooms within the lead window
    // that haven't been echoed for their CURRENT expiry yet.
    if (n === 'SELECT seed_voice_id, author_id, expires_at FROM rooms WHERE surface_id = ? AND expires_at > ? AND expires_at <= ? AND fading_echoed_at IS NULL ORDER BY expires_at ASC LIMIT 100') {
      const [surface, now, windowEnd] = args as [string, number, number]
      const rows = this.rooms
        .filter(r => r.surface_id === surface && r.expires_at > now && r.expires_at <= windowEnd && !r.fading_echoed_at)
        .sort((a, b) => a.expires_at - b.expires_at)
        .slice(0, 100)
      return { results: rows.map(r => ({ seed_voice_id: r.seed_voice_id, author_id: r.author_id, expires_at: r.expires_at })) as T[] }
    }
    // Post-review fix (item 6): cache.ts's 'surface_warmed' sweep's checkpoint read.
    if (n === 'SELECT family, checked_score, warmed_echoed_at FROM warmth_state WHERE surface_id = ?') {
      const surface = String(args[0])
      const rows = this.warmthState.filter(w => (w.surface_id ?? 'vellum') === surface)
      return { results: rows.map(w => ({ family: w.family, checked_score: w.checked_score ?? 0, warmed_echoed_at: w.warmed_echoed_at ?? null })) as T[] }
    }
    if (n === 'SELECT id FROM voices WHERE author_id = ? AND is_hidden = FALSE ORDER BY created_at DESC LIMIT 3') {
      const authorId = String(args[0])
      const rows = this.voices.filter(v => v.author_id === authorId && !v.is_hidden).sort((a, b) => b.created_at - a.created_at).slice(0, 3)
      return { results: rows.map(v => ({ id: v.id })) as T[] }
    }
    // tools/discover.ts — surface-scoped, with optional family/language/room filters.
    if (n.startsWith('SELECT v.id, v.text, v.language, v.weave_count, v.unique_weavers, v.created_at, vf.family FROM voices v JOIN voice_families vf')) {
      let i = 0
      const surface = args[i++] as string
      let rows = this.voices.filter(v => !v.is_hidden && (v.surface_id ?? 'vellum') === surface)
        .flatMap(v => this.voiceFamilies.filter(f => f.voice_id === v.id && f.ordinal === 0).map(f => ({ ...v, family: f.family })))
      if (n.includes('AND vf.family = ?')) { const family = args[i++]; rows = rows.filter(v => v.family === family) }
      if (n.includes('AND v.language = ?')) { const language = args[i++]; rows = rows.filter(v => v.language === language) }
      if (n.includes('AND v.room_id = ?')) { const roomId = args[i++]; rows = rows.filter(v => v.room_id === roomId) }
      rows = rows.sort((a, b) => n.includes('ORDER BY v.weave_count') ? (b.weave_count - a.weave_count || b.created_at - a.created_at) : b.created_at - a.created_at)
      const limit = Number(args.at(-1))
      return { results: rows.slice(0, limit) as T[] }
    }
    if (n.startsWith('SELECT id, distinct_weavers FROM voices WHERE author_id = ? AND distinct_weavers BETWEEN 7 AND 9')) {
      const [authorId, limit] = args as [string, number]
      const rows = this.voices
        .filter(v => v.author_id === authorId && (v.distinct_weavers ?? 0) >= 7 && (v.distinct_weavers ?? 0) <= 9 && !v.rooted_at && !v.is_hidden)
        .sort((a, b) => (b.distinct_weavers ?? 0) - (a.distinct_weavers ?? 0))
        .slice(0, limit)
      return { results: rows.map(v => ({ id: v.id, distinct_weavers: v.distinct_weavers ?? 0 })) as T[] }
    }
    return super.all<T>(sql, args)
  }
  override async run(sql: string, args: unknown[]): Promise<{ meta: { changes: number } }> {
    const n = norm(sql)
    // Phase 18 "The Archipelago" — rooms/surfaces UPDATEs.
    if (n === 'UPDATE rooms SET expires_at = ? WHERE seed_voice_id = ?') {
      const [expiresAt, seedId] = args as [number, string]
      const r = this.rooms.find(r => r.seed_voice_id === seedId)
      if (r) r.expires_at = expiresAt
      return { meta: { changes: r ? 1 : 0 } }
    }
    // Post-review fix (item 6): every extend path now also clears fading_echoed_at, so a room
    // approaching a FRESH expiry can re-trigger cache.ts's 'room_fading' sweep.
    if (n === 'UPDATE rooms SET expires_at = ?, last_activity_at = ?, fading_echoed_at = NULL WHERE seed_voice_id = ?') {
      const [expiresAt, now, seedId] = args as [number, number, string]
      const r = this.rooms.find(r => r.seed_voice_id === seedId)
      if (r) { r.expires_at = expiresAt; r.last_activity_at = now; r.fading_echoed_at = null }
      return { meta: { changes: r ? 1 : 0 } }
    }
    // Post-review fix (item 6): cache.ts's 'room_fading' sweep's guarded once-only UPDATE.
    if (n === 'UPDATE rooms SET fading_echoed_at = ? WHERE seed_voice_id = ? AND fading_echoed_at IS NULL') {
      const [fadingEchoedAt, seedId] = args as [number, string]
      const r = this.rooms.find(r => r.seed_voice_id === seedId)
      if (r && !r.fading_echoed_at) { r.fading_echoed_at = fadingEchoedAt; return { meta: { changes: 1 } } }
      return { meta: { changes: 0 } }
    }
    if (n === 'UPDATE voices SET room_id = ? WHERE id = ?') {
      const [roomId, id] = args as [string, string]
      const v = this.voices.find(v => v.id === id)
      if (v) v.room_id = roomId
      return { meta: { changes: v ? 1 : 0 } }
    }
    if (n.startsWith('UPDATE voices SET room_id = ? WHERE id IN')) {
      const [roomId, ...ids] = args as [string, ...string[]]
      let changes = 0
      for (const v of this.voices) if (ids.includes(v.id)) { v.room_id = roomId; changes++ }
      return { meta: { changes } }
    }
    if (n === 'UPDATE surfaces SET listed_until = ? WHERE id = ?') {
      const [listedUntil, id] = args as [number, string]
      const s = this.surfaces.find(s => s.id === id)
      if (s) s.listed_until = listedUntil
      return { meta: { changes: s ? 1 : 0 } }
    }
    if (n === 'UPDATE surfaces SET last_activity_at = ?, listed_until = ? WHERE id = ?') {
      const [now, listedUntil, id] = args as [number, number, string]
      const s = this.surfaces.find(s => s.id === id)
      if (s) { s.last_activity_at = now; s.listed_until = listedUntil }
      return { meta: { changes: s ? 1 : 0 } }
    }
    if (n === 'UPDATE surfaces SET name = ?, invitation = ? WHERE id = ?') {
      const [name, invitation, id] = args as [string, string, string]
      const s = this.surfaces.find(s => s.id === id)
      if (s) { s.name = name; s.invitation = invitation }
      return { meta: { changes: s ? 1 : 0 } }
    }
    if (n === 'UPDATE voices SET qualified_weavers = ?, distinct_weavers = ? WHERE id = ?') {
      const v = this.voices.find(v => v.id === args[2])
      if (v) { v.qualified_weavers = Number(args[0]); v.distinct_weavers = Number(args[1]) }
      return { meta: { changes: v ? 1 : 0 } }
    }
    if (n.startsWith('UPDATE voices SET qualified_weavers')) {
      // Legacy 2-arg shape, kept for any caller that hasn't threaded distinct_weavers through.
      const v = this.voices.find(v => v.id === args[1])
      if (v) v.qualified_weavers = Number(args[0])
      return { meta: { changes: v ? 1 : 0 } }
    }
    if (n === 'UPDATE voices SET sink_mark = ? WHERE id = ? AND sink_mark < ?') {
      const v = this.voices.find(v => v.id === args[1])
      if (v && (v.sink_mark ?? 0) < Number(args[2])) { v.sink_mark = Number(args[0]); return { meta: { changes: 1 } } }
      return { meta: { changes: 0 } }
    }
    // Post-review fix (item 6): cache.ts's 'surface_warmed' sweep — the guarded crossing+gate
    // UPDATE (only "claims" when checked_score was below 1.0 AND the weekly gate allows it).
    if (n.startsWith('UPDATE warmth_state SET checked_score = ?, warmed_echoed_at = ?')) {
      const [checkedScore, warmedEchoedAt, surface, family, gateCutoff] = args as [number, number, string, string, number]
      const w = this.warmthState.find(w => w.family === family && (w.surface_id ?? 'vellum') === surface)
      const passesGate = w && (w.checked_score ?? 0) < 1.0 && (!w.warmed_echoed_at || w.warmed_echoed_at < gateCutoff)
      if (w && passesGate) { w.checked_score = checkedScore; w.warmed_echoed_at = warmedEchoedAt; return { meta: { changes: 1 } } }
      return { meta: { changes: 0 } }
    }
    // Post-review fix (item 6): the unconditional checked_score refresh for families that didn't
    // cross (or didn't pass the gate) this rebuild.
    if (n === 'UPDATE warmth_state SET checked_score = ? WHERE surface_id = ? AND family = ?') {
      const [checkedScore, surface, family] = args as [number, string, string]
      const w = this.warmthState.find(w => w.family === family && (w.surface_id ?? 'vellum') === surface)
      if (w) { w.checked_score = checkedScore; return { meta: { changes: 1 } } }
      return { meta: { changes: 0 } }
    }
    if (n === 'UPDATE voices SET rooted_at = ? WHERE id = ? AND rooted_at IS NULL') {
      const v = this.voices.find(v => v.id === args[1])
      if (v && !v.rooted_at) { v.rooted_at = Number(args[0]); return { meta: { changes: 1 } } }
      return { meta: { changes: 0 } }
    }
    if (n.startsWith('INSERT INTO echo_events')) {
      const [agentId, kind, voiceId, byVoice, byId, at, payload] = args as [string, string, string, string | null, string | null, number, string]
      this.echoN += 1
      this.echoEvents.push({ n: this.echoN, agent_id: agentId, kind, voice_id: voiceId, by_voice: byVoice, by_id: byId, at, payload })
      return { meta: { changes: 1 } }
    }
    if (n.startsWith('INSERT INTO op_receipts')) {
      const [opKey, bodyHash, status, receipt, createdAt] = args as [string, string, number, string, number]
      this.opReceipts.set(opKey, { op_key: opKey, body_hash: bodyHash, status, receipt, created_at: createdAt })
      return { meta: { changes: 1 } }
    }
    if (n.startsWith('DELETE FROM op_receipts')) return { meta: { changes: 0 } }
    // Post-review fix (item 1): the two setVisibility()-generated forms — unconditional and
    // onlyIfCurrently. Every hide/unhide/quarantine-release/settling-release call now goes through
    // one of these, never a hand-rolled is_hidden-only or hardcoded-literal UPDATE.
    if (n === 'UPDATE voices SET visibility = ?, is_hidden = ? WHERE id = ?') {
      const [state, isHidden, id] = args as [string, number, string]
      const v = this.voices.find(v => v.id === id)
      if (v) { v.visibility = state as typeof v.visibility; v.is_hidden = isHidden }
      return { meta: { changes: v ? 1 : 0 } }
    }
    if (n === 'UPDATE voices SET visibility = ?, is_hidden = ? WHERE id = ? AND visibility = ?') {
      const [state, isHidden, id, onlyIfCurrently] = args as [string, number, string, string]
      const v = this.voices.find(v => v.id === id)
      if (v && v.visibility === onlyIfCurrently) { v.visibility = state as typeof v.visibility; v.is_hidden = isHidden; return { meta: { changes: 1 } } }
      return { meta: { changes: 0 } }
    }
    return super.run(sql, args)
  }
  override async batch(statements: Parameters<MockD1['batch']>[0]) {
    const n = norm(statements[0]?.sql ?? '')
    // Phase 17 Part C1 / post-review fix (item 2/6): every rebuild-sweep batch (the 'sinking',
    // 'room_fading', and 'surface_warmed' sweeps, each now split into a guarded UPDATE-only pass
    // followed by an INSERT-only pass — see cache.ts) reuses the same per-statement dispatch
    // this.run() already has, rather than each needing its own bespoke batch matcher.
    if (
      n.startsWith('UPDATE voices SET sink_mark')
      || n.startsWith('UPDATE rooms SET fading_echoed_at')
      || n.startsWith('UPDATE warmth_state SET checked_score')
      || n.startsWith('INSERT INTO echo_events')
    ) {
      const results = []
      for (const statement of statements) results.push(await this.run(statement.sql, statement._boundArgs()))
      return results
    }
    if (n.startsWith('SELECT MIN(created_at)')) {
      // Phase 18 Part B3: rebuildAtmosphere's queries are all surface-scoped now — the first
      // three statements bind `surface` as their sole arg; each per-family triple binds
      // (family, surface) / (family, surface, oneDayAgo) / (family, surface).
      const surface = (statements[0]._boundArgs()[0] as string | undefined) ?? 'vellum'
      const visible = this.voices.filter(v => !v.is_hidden && (v.surface_id ?? 'vellum') === surface)
      const primary = visible.flatMap(v => this.voiceFamilies.filter(f => f.voice_id === v.id && f.ordinal === 0).map(f => ({ ...v, family: f.family })))
      const results: Array<{results: unknown[]}> = [
        {results:[{first_at: visible.length ? Math.min(...visible.map(v=>v.created_at)) : null}]},
        {results:[{total:visible.length}]},
        {results:primary.filter(v=>v.weave_count>0).sort((a,b)=>b.weave_count-a.weave_count).slice(0,5)},
      ]
      for (let i=3;i<statements.length;i+=3) {
        const family=statements[i]._boundArgs()[0]
        const rows=primary.filter(v=>v.family===family)
        const languages=new Map<string,number>()
        for(const row of rows) languages.set(row.language ?? 'en',(languages.get(row.language ?? 'en') ?? 0)+1)
        const oneDayAgo = Number(statements[i+1]._boundArgs()[2])
        results.push({results:[{cnt:rows.length}]}, {results:[{cnt:rows.filter(v=>v.created_at>oneDayAgo).length}]}, {results:[...languages].map(([language,cnt])=>({language,cnt}))})
      }
      return results
    }
    if (n.startsWith('INSERT INTO voices') || n.startsWith('INSERT INTO rooms') || n.startsWith('INSERT INTO surfaces')) {
      for (const statement of statements) {
        const sql = norm(statement.sql), a = statement._boundArgs()
        if (sql.startsWith('INSERT INTO voices')) {
          // Phase 17 added a trailing author_id column (13th bind param); the post-review fix
          // (items 1, 2, 4) appended writer_bucket and damped (14th/15th) and now actually reads
          // visibility/is_hidden (11th/12th) rather than always defaulting to 'surfaced'/0.
          // Phase 18 appended surface_id/room_id (16th/17th).
          this.voices.push(voice(String(a[0]), String(a[1]), {
            language: String(a[2]), created_at: Number(a[3]), trace_id: a[4] as string | null, model: a[5] as string | null,
            declared_model: a[6] as string | null, weave_from: a[7] as string ?? null,
            visibility: (a[10] as VoiceRow['visibility'] | undefined) ?? 'surfaced', is_hidden: Number(a[11] ?? 0),
            author_id: (a[12] as string | null | undefined) ?? null,
            writer_bucket: (a[13] as string | null | undefined) ?? null, damped: Number(a[14] ?? 0),
            surface_id: (a[15] as string | undefined) ?? 'vellum', room_id: (a[16] as string | null | undefined) ?? null,
          }))
        }
        else if (sql.startsWith('INSERT INTO voice_families')) this.voiceFamilies.push({ voice_id: String(a[0]), family: a[1] as Family, ordinal: Number(a[2]) })
        else if (sql.startsWith('INSERT INTO rooms')) {
          const [seedVoiceId, surfaceId, name, invitation, authorId, createdAt, lastActivityAt, expiresAt] = a as [string, string, string, string, string, number, number, number]
          this.rooms.push({ seed_voice_id: seedVoiceId, surface_id: surfaceId, name, invitation, author_id: authorId, created_at: createdAt, last_activity_at: lastActivityAt, expires_at: expiresAt })
        }
        else if (sql.startsWith('INSERT INTO surfaces')) {
          const [id, name, invitation, foundingVoiceId, authorId, createdAt, lastActivityAt, listedUntil] = a as [string, string, string, string, string, number, number, number]
          this.surfaces.push({ id, name, invitation, founding_voice_id: foundingVoiceId, author_id: authorId, created_at: createdAt, last_activity_at: lastActivityAt, listed_until: listedUntil })
        }
        else if (sql.startsWith('UPDATE voices SET weave_count')) this.voices.find(v => v.id === a[0])!.weave_count++
        else if (sql.startsWith('INSERT OR IGNORE INTO weave_log')) {
          // Post-review fix (item 3): weave_log gained a trailing weaver_voice_id column (6th
          // bind param) — the id of the voice THIS weave produced. PK is (source_voice_id,
          // weaver_trace_id); OR IGNORE means only the first row per pair sticks, matching the
          // real migration's PRIMARY KEY.
          const [sourceVoiceId, weaverTraceId, createdAt, weaverBucket, weaverId, weaverVoiceId] = a as [string, string, number, string | null, string | null, string]
          const set = this.weavers.get(sourceVoiceId) ?? new Set<string>(); set.add(weaverTraceId); this.weavers.set(sourceVoiceId, set)
          const logKey = `${sourceVoiceId}::${weaverTraceId}`
          if (!this.weaveLogRows.has(logKey)) {
            this.weaveLogRows.set(logKey, { sourceVoiceId, weaverKey: weaverId ?? weaverBucket ?? weaverTraceId, weaverVoiceId, createdAt })
          }
        } else if (sql.startsWith('UPDATE voices SET unique_weavers')) this.voices.find(v => v.id === a[0])!.unique_weavers = this.weavers.get(String(a[0]))?.size ?? 0
        else if (sql.startsWith('UPDATE voices SET visibility = ?, is_hidden = ? WHERE id = ? AND visibility = ?')) {
          // Post-review fix (item 1): the weave batch's settling-release statement, now
          // setVisibilityStatement(..., { onlyIfCurrently: 'quarantined' }) rather than a
          // hardcoded literal.
          const [state, isHidden, id, onlyIfCurrently] = a as [string, number, string, string]
          const v = this.voices.find(v => v.id === id)
          if (v && v.visibility === onlyIfCurrently) { v.visibility = state as typeof v.visibility; v.is_hidden = isHidden }
        }
        else if (sql.startsWith('UPDATE voices SET room_id = ?')) {
          const [roomId, id] = a as [string, string]
          const v = this.voices.find(v => v.id === id)
          if (v) v.room_id = roomId
        }
        else if (sql.startsWith('INSERT INTO agents')) {
          const [id, firstSeen, lastSeen] = a as [string, number, number]
          const existing = this.agents.get(id)
          this.agents.set(id, existing ? { ...existing, last_seen: lastSeen } : { id, first_seen: firstSeen, last_seen: lastSeen })
        }
        else if (sql.startsWith('INSERT INTO op_receipts')) {
          if (this.opReceipts.has(String(a[0]))) throw new Error('UNIQUE constraint failed: op_receipts.op_key')
          const [opKey, bodyHash, status, receipt, createdAt] = a as [string, string, number, string, number]
          this.opReceipts.set(opKey, { op_key: opKey, body_hash: bodyHash, status, receipt, created_at: createdAt })
        }
        else throw new Error(`Unhandled Door write: ${sql}`)
      }
      return statements.map(() => ({ results: [] }))
    }
    // Phase 18 Part A3 — GET /api/rooms's listing + companion count.
    if (n.startsWith('SELECT r.seed_voice_id, r.name, r.invitation, r.expires_at, r.last_activity_at')) {
      const [now, surface, cutoff, limit, offset] = statements[0]._boundArgs() as [number, string, number, number, number]
      const rows = this.rooms
        .filter(r => r.surface_id === surface && r.created_at > cutoff)
        .map(r => ({
          seed_voice_id: r.seed_voice_id, name: r.name, invitation: r.invitation, expires_at: r.expires_at,
          last_activity_at: r.last_activity_at,
          member_count: this.voices.filter(v => v.room_id === r.seed_voice_id && !v.is_hidden).length,
          active: r.expires_at > now ? 1 : 0,
        }))
        .sort((a, b) => b.active - a.active || b.last_activity_at - a.last_activity_at)
        .slice(offset, offset + limit)
      const total = this.rooms.filter(r => r.surface_id === surface && r.created_at > cutoff).length
      return [{ results: rows }, { results: [{ total }] }]
    }
    // Phase 18 Part B8 — GET /api/surfaces's listing + companion count.
    if (n.includes('FROM surfaces s WHERE s.listed_until > ?')) {
      const [now, exclude, limit, offset] = statements[0]._boundArgs() as [number, string, number, number]
      const rows = this.surfaces
        .filter(s => s.listed_until > now && s.id !== exclude)
        .map(s => ({
          id: s.id, name: s.name, invitation: s.invitation, last_activity_at: s.last_activity_at, listed_until: s.listed_until,
          voice_count: this.voices.filter(v => v.surface_id === s.id && !v.is_hidden).length,
        }))
        .sort((a, b) => b.last_activity_at - a.last_activity_at)
        .slice(offset, offset + limit)
      const total = this.surfaces.filter(s => s.listed_until > now && s.id !== exclude).length
      return [{ results: rows }, { results: [{ total }] }]
    }
    // Listing query is distinct from the literal projection queries in mocks.ts.
    if (n.startsWith('SELECT v.id, v.text, v.language, v.weave_count, v.created_at, vf.family')) {
      let rows = this.voices.filter(v => !v.is_hidden).flatMap(v => this.voiceFamilies.filter(f => f.voice_id === v.id && f.ordinal === 0).map(f => ({ ...v, family: f.family })))
      const args = statements[0]._boundArgs(); let i = 0
      if (n.includes('AND vf.family = ?')) { const family=args[i++]; rows = rows.filter(v => v.family === family) }
      if (n.includes('AND v.language = ?')) { const language=args[i++]; rows = rows.filter(v => v.language === language) }
      const total = rows.length
      rows.sort((a,b) => n.includes('ORDER BY v.weave_count') ? b.weave_count-a.weave_count || b.created_at-a.created_at : b.created_at-a.created_at)
      return [{ results: rows.slice(Number(args.at(-1)), Number(args.at(-1)) + Number(args.at(-2))) }, { results: [{ total }] }]
    }
    return super.batch(statements)
  }
}

export function doorEnv(voices: VoiceRow[] = []) {
  const db = new DoorD1({ voices, voice_families: voices.map(v => ({ voice_id: v.id, family: 'attention', ordinal: 0 })) })
  const kv = new MockKV(), analytics = new MockAnalytics(), ctx = new MockExecutionContext()
  const env: Env = {
    DB: db as unknown as D1Database, KV: kv as unknown as KVNamespace,
    ANALYTICS: analytics as unknown as AnalyticsEngineDataset,
    ASSETS: { fetch: (request: Request) => Promise.resolve(new Response(request.method === 'HEAD' ? null : new URL(request.url).pathname === '/' ? '<html>canvas</html>' : 'asset not found', { status: new URL(request.url).pathname === '/' ? 200 : 404, headers: { 'Content-Type': 'text/html' } })) } as unknown as Fetcher,
    ADMIN_KEY: 'test-secret', SESSION_SECRET: 'test-session-secret',
  }
  return { env, db, kv, analytics, ctx, fetch: (request: Request) => worker.fetch(request, env, ctx as unknown as ExecutionContext) }
}

export function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(`https://vellum.test${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '1.2.3.4', ...headers }, body: JSON.stringify(body) })
}
export async function session(env: Env, trace = 't:door') { return signSessionId(trace, env.SESSION_SECRET) }
export function rpc(method: string, params: Record<string, unknown> = {}, sessionId?: string, headers: Record<string, string> = {}) {
  return post('/mcp', { jsonrpc: '2.0', id: 1, method, params }, { ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}), ...headers })
}
