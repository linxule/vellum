/** Phase 16: `off` (default) / `shadow` (compute, count, emit, never enforce) / `on`. */
export type LeveeMode = 'off' | 'shadow' | 'on'

export type Env = {
  DB: D1Database
  KV: KVNamespace
  ANALYTICS: AnalyticsEngineDataset
  ASSETS: Fetcher
  ADMIN_KEY: string
  SESSION_SECRET: string
  RATE_LIMITER?: DurableObjectNamespace
  /** Phase 15: observational only; never rejects an Origin. */
  MCP_ORIGIN_LOG_ONLY?: string
  /** Phase 16 rollout flags — env var is the fallback default; KV (`levee:*`) can override without a deploy. */
  LEVEE_ADMISSION?: LeveeMode
  LEVEE_REBUILD?: LeveeMode
  LEVEE_CEILING?: LeveeMode
  LEVEE_DEDUPE?: LeveeMode
  LEVEE_PERMANENCE?: LeveeMode
  /** Defaults `off` and is expected to stay off; see docs/PHASE_16_SPEC.md Part E. */
  LEVEE_FUSE?: LeveeMode
  /** Phase 18 Part B rollout: `POST /api/surfaces` (surface creation) is gated behind this for one
   * deploy while S5-S14 are smoked against a hand-inserted test surface, per docs/PHASE_18_SPEC.md
   * D3. Unset/anything but '1' → creation returns 403 OCEAN_CREATION_DISABLED. Rooms are unaffected
   * (additive from their own first deploy). */
  SURFACES_OPEN?: string
}

export const FAMILIES = ['attention', 'silence', 'space', 'ephemeral', 'memory', 'light'] as const
export type Family = typeof FAMILIES[number]

/** Phase 16 "The Levee" Part E. `visibility` and `is_hidden` are a strict mirror
 * (is_hidden = visibility != 'surfaced'); the ONLY writer of either is `setVisibility()`
 * (see `visibility.ts`) — see docs/PHASE_16_REPORT.md "Post-review fixes". */
export type VisibilityState = 'surfaced' | 'quarantined' | 'hidden'

// D1 row shapes

export interface VoiceRow {
  id: string
  text: string
  language: string | null
  created_at: number
  trace_id: string | null
  model: string | null
  declared_model: string | null
  weave_count: number
  unique_weavers: number
  weave_from: string | null
  is_hidden: number // SQLite boolean
  // Phase 16 "The Levee"
  content_hash?: string | null
  simhash?: string | null
  damped?: number // SQLite boolean
  qualified_weavers?: number
  permanence_source?: 'legacy' | 'earned'
  visibility?: VisibilityState
  /** Post-Phase-16-review fix — the author-side counterpart to weave_log.weaver_bucket (which
   * only names weavers OF a source, never the author of one). Same salted /24-or-/48 network hash
   * (levee-permanence.ts's weaverBucket), set on every insert. Lets the fuse's returning-writer
   * check and admin's writer_bucket hide selector recognize an anonymous REST author, who carries
   * no trace_id at all. */
  writer_bucket?: string | null
  // Phase 17 "The Echo"
  author_id?: string | null // 'a_' + base64url(sha256(secret)); NULL = anonymous
  sink_mark?: number // highest sinking threshold echoed (0|1|2|3)
  rooted_at?: number | null // set once when 'rooted' is echoed
  /** Raw distinct-weaver-identity count (COALESCE(weaver_id, weaver_bucket)), regardless of the
   * hour-bucket gate. Not in the Phase 17 spec's migration — added because qualified_weavers
   * cannot express partial progress (see docs/PHASE_17_REPORT.md deviations); used only for
   * debts/permanent_in/echo-payload narrative numbers, never for the permanence gate itself. */
  distinct_weavers?: number
  // Phase 18 "The Archipelago"
  /** Denormalized nearest-room seed id; NULL = open ocean (not in any room). Inherited at write
   * time from the source's room_id (or the source's own id when the source IS a room seed). */
  room_id?: string | null
  /** Which ocean this voice belongs to. Defaults 'vellum' (the default ocean); every pre-Phase-18
   * row is implicitly 'vellum' via the migration's column DEFAULT. */
  surface_id?: string
}

/** Phase 18 Part A1 — a room is a voice with a name and an invitation. */
export interface RoomRow {
  seed_voice_id: string
  surface_id: string
  name: string
  invitation: string
  author_id: string
  created_at: number
  last_activity_at: number
  expires_at: number
}

/** Phase 18 Part B1 — a parallel ocean: its own voices, warmth, projection cache, canvas URL. */
export interface SurfaceRow {
  id: string
  name: string
  invitation: string
  founding_voice_id: string
  author_id: string
  created_at: number
  last_activity_at: number
  listed_until: number
}

// API / KV shapes

export interface VoiceData {
  id: string
  text: string
  lang: string
  weave_count: number
  depth: number
  weave_from: string | null
  declared_model: string | null
  observed_client_family: string | null
}

export interface ThreadData {
  family: string
  voices: VoiceData[]
  texture_density: number
  warmth: number
  dominant_languages: string[]
}

export interface StateResponse {
  threads: ThreadData[]
  computed_at: number
  version: number
  /** Phase 18 Part B5 — additive, optional: present only for a non-default surface. The default
   * ocean's /api/state stays byte-identical to pre-Phase-18 (S6). */
  surface?: { slug: string; name: string; invitation: string }
}

export interface AtmosphereData {
  age_days: number
  total_voices: number
  families: Record<string, {
    count: number
    warmth: number
    recent_24h: number
    languages: string[]
  }>
  surface_phrases: {
    id: string
    text: string
    lang: string
    weave_count: number
    family: string
  }[]
  mood: string
  computed_at: number
}

export interface WarmthEntry {
  score: number
  last_updated: number
}

export interface WarmthRow extends WarmthEntry {
  family: string
}

export interface SessionState {
  imprints: number
  weaves: number
  witnesses: number
  lineages: number
  last_action: number
}

// Focus voice (includes aging flag)
export interface FocusVoice {
  id: string
  text: string
  lang: string
  age_h: number
  weave_count: number
  aging?: boolean
}
