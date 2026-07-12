export type Env = {
  DB: D1Database
  KV: KVNamespace
  ANALYTICS: AnalyticsEngineDataset
  ASSETS: Fetcher
  ADMIN_KEY: string
  SESSION_SECRET: string
  RATE_LIMITER?: DurableObjectNamespace
}

export const FAMILIES = ['attention', 'silence', 'space', 'ephemeral', 'memory', 'light'] as const
export type Family = typeof FAMILIES[number]

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
