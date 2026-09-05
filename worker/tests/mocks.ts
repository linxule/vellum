const FAMILIES = ['attention', 'silence', 'space', 'ephemeral', 'memory', 'light'] as const
type Family = typeof FAMILIES[number]
type VoiceRow = { id: string, text: string, language: string | null, created_at: number, trace_id: string | null, model: string | null, declared_model: string | null, weave_count: number, unique_weavers: number, weave_from: string | null, is_hidden: number, qualified_weavers?: number, permanence_source?: 'legacy' | 'earned', visibility?: 'surfaced' | 'quarantined' | 'hidden', damped?: number, author_id?: string | null, sink_mark?: number, rooted_at?: number | null, distinct_weavers?: number, writer_bucket?: string | null, surface_id?: string, room_id?: string | null }
type VoiceFamilyRow = { voice_id: string, family: Family, ordinal: number }
type WarmthStateRow = { family: Family, score: number, last_updated: number, surface_id?: string, checked_score?: number, warmed_echoed_at?: number | null }
type RateLimitRow = { key: string, count: number, window_start: number, expires_at: number }
type Seed = { voices?: VoiceRow[], voice_families?: VoiceFamilyRow[], warmth_state?: WarmthStateRow[], rate_limits?: RateLimitRow[] }
const normalizeSql = (sql: string) => sql.replace(/\s+/g, ' ').trim()

export class MockKV {
  private store = new Map<string, { value: string, expiresAt: number | null }>()
  private delays = new Map<string, number>()
  injectDelay(key: string, ms: number) { this.delays.set(key, ms) }

  async get<T>(key: string, type?: 'json'): Promise<T | null> {
    await this.delayFor(key)
    const entry = this.read(key)
    if (!entry) return null
    return type === 'json' ? JSON.parse(entry.value) as T : entry.value as T
  }

  async put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void> {
    await this.delayFor(key)
    const expiresAt = opts?.expirationTtl ? Date.now() + opts.expirationTtl * 1000 : null
    this.store.set(key, { value, expiresAt })
  }

  async delete(key: string): Promise<void> {
    await this.delayFor(key)
    this.store.delete(key)
  }

  _getRaw(key: string): string | null {
    return this.read(key)?.value ?? null
  }

  _getAll() { return new Map(this.store) }

  private read(key: string) {
    const entry = this.store.get(key)
    if (!entry) return null
    if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
      this.store.delete(key)
      return null
    }
    return entry
  }

  private async delayFor(key: string) {
    const ms = this.delays.get(key)
    if (ms) await Bun.sleep(ms)
  }
}

export class MockAnalytics {
  points: Array<{ blobs: Array<string | null>, doubles: number[], indexes: string[] }> = []
  writeDataPoint(point: { blobs: Array<string | null>, doubles?: number[], indexes: string[] }) {
    this.points.push({
      blobs: point.blobs,
      doubles: point.doubles ?? [],
      indexes: point.indexes,
    })
  }
}

export class MockExecutionContext {
  private pending: Promise<unknown>[] = []
  waitUntilCalls = 0
  waitUntil(promise: Promise<unknown>) {
    this.waitUntilCalls += 1
    this.pending.push(promise)
  }

  async drain() {
    while (this.pending.length > 0) {
      const batch = this.pending.splice(0)
      await Promise.all(batch)
    }
  }
}

class MockStatement {
  private args: unknown[] = []
  constructor(private db: MockD1, readonly sql: string) {}
  bind(...args: unknown[]) { this.args = args; return this }
  first<T>(): Promise<T | null> { return this.db.first<T>(this.sql, this.args) }
  all<T>(): Promise<{ results: T[] }> { return this.db.all<T>(this.sql, this.args) }
  run(): Promise<{ meta: { changes: number } }> { return this.db.run(this.sql, this.args) }
  _boundArgs() { return this.args }
}

export class MockD1 {
  voices: VoiceRow[]
  voiceFamilies: VoiceFamilyRow[]
  warmthState: WarmthStateRow[]
  rateLimits: RateLimitRow[]
  projectionRebuildCount = 0
  failWarmthUpdateFamilies = new Set<Family>()
  constructor(seed: Seed = {}) {
    this.voices = seed.voices ? [...seed.voices] : []
    this.voiceFamilies = seed.voice_families ? [...seed.voice_families] : []
    this.warmthState = seed.warmth_state
      ? [...seed.warmth_state]
      : FAMILIES.map(family => ({ family, score: 0, last_updated: 0 }))
    this.rateLimits = seed.rate_limits ? [...seed.rate_limits] : []
  }

  prepare(sql: string) { return new MockStatement(this, sql) }

  async batch(statements: MockStatement[]) {
    if (statements[0] && normalizeSql(statements[0].sql).includes('SELECT v.id, v.text, v.language, v.weave_count')) {
      this.projectionRebuildCount += 1
    }
    return Promise.all(statements.map(statement => this.executeBatch(statement.sql, statement._boundArgs())))
  }

  async first<T>(sql: string, args: unknown[]): Promise<T | null> {
    const rows = await this.select<T>(sql, args)
    return rows[0] ?? null
  }
  async all<T>(sql: string, args: unknown[]) { return { results: await this.select<T>(sql, args) } }
  async run(sql: string, args: unknown[]) { return { meta: { changes: await this.executeRun(sql, args) } } }

  private async executeBatch(sql: string, args: unknown[]) {
    const normalized = normalizeSql(sql)
    if (normalized.startsWith('SELECT ')) {
      return { results: await this.select(normalized, args) }
    }
    return { meta: { changes: await this.executeRun(normalized, args) } }
  }

  private visiblePrimaryVoices(family: string, surface = 'vellum') {
    const primaryIds = new Set(
      this.voiceFamilies
        .filter(row => row.family === family && row.ordinal === 0)
        .map(row => row.voice_id)
    )
    return this.voices.filter(voice => primaryIds.has(voice.id) && !voice.is_hidden && (voice.surface_id ?? 'vellum') === surface)
  }

  private async select<T>(sql: string, args: unknown[]): Promise<T[]> {
    const normalized = normalizeSql(sql)
    // Phase 18 Part B3: warmth_state's PRIMARY KEY became (surface_id, family).
    if (normalized === 'SELECT family, score, last_updated FROM warmth_state WHERE surface_id = ?') {
      const surface = args[0] as string
      return this.warmthState.filter(row => (row.surface_id ?? 'vellum') === surface) as T[]
    }
    if (normalized === 'SELECT score, last_updated FROM warmth_state WHERE family = ? AND surface_id = ?') {
      const [family, surface] = args as [Family, string]
      return this.warmthState.filter(row => row.family === family && (row.surface_id ?? 'vellum') === surface) as T[]
    }
    if (normalized === 'SELECT count, expires_at FROM rate_limits WHERE key = ?') {
      const key = args[0] as string
      return this.rateLimits
        .filter(row => row.key === key)
        .map(row => ({ count: row.count, expires_at: row.expires_at })) as T[]
    }
    // Phase 16 post-16 SQL (docs/PHASE_16_SPEC.md Part D3) — foundation is earned permanence
    // (qualified_weavers >= 10) or grandfathered legacy voices, capped at 40/family. Phase 18
    // Part B3 added `AND v.surface_id = ?` (args[1]) — additive, no-op for single-surface tests.
    if (normalized.includes('FROM voices v JOIN voice_families vf ON v.id = vf.voice_id') && normalized.includes("v.qualified_weavers >= 10 OR v.permanence_source = 'legacy'") && normalized.includes('LIMIT 40')) {
      const [family, surface] = args as [string, string]
      const isPermanent = (voice: VoiceRow) => (voice.qualified_weavers ?? 0) >= 10 || voice.permanence_source === 'legacy'
      return this.visiblePrimaryVoices(family, surface)
        .filter(isPermanent)
        .sort((a, b) => (b.qualified_weavers ?? 0) - (a.qualified_weavers ?? 0) || b.created_at - a.created_at)
        .slice(0, 40) as T[]
    }
    if (normalized.includes('FROM voices v JOIN voice_families vf ON v.id = vf.voice_id') && normalized.includes('v.weave_count >= 3') && normalized.includes("NOT (v.qualified_weavers >= 10 OR v.permanence_source = 'legacy')")) {
      const [family, surface] = args as [string, string]
      const isPermanent = (voice: VoiceRow) => (voice.qualified_weavers ?? 0) >= 10 || voice.permanence_source === 'legacy'
      return this.visiblePrimaryVoices(family, surface)
        .filter(voice => voice.weave_count >= 3 && !isPermanent(voice))
        .sort((a, b) => b.weave_count - a.weave_count)
        .slice(0, 20) as T[]
    }
    if (normalized.includes('FROM voices v JOIN voice_families vf ON v.id = vf.voice_id') && normalized.includes('ORDER BY v.created_at DESC LIMIT 150')) {
      const [family, surface] = args as [string, string]
      return this.visiblePrimaryVoices(family, surface)
        .sort((a, b) => b.created_at - a.created_at)
        .slice(0, 150) as T[]
    }
    if (normalized === 'SELECT COUNT(*) as cnt FROM voice_families vf JOIN voices v ON v.id = vf.voice_id WHERE vf.family = ? AND vf.ordinal = 0 AND v.is_hidden = FALSE AND v.surface_id = ?') {
      const [family, surface] = args as [string, string]
      return [{ cnt: this.visiblePrimaryVoices(family, surface).length }] as T[]
    }
    if (normalized === 'SELECT v.language, COUNT(*) as cnt FROM voices v JOIN voice_families vf ON v.id = vf.voice_id WHERE vf.family = ? AND vf.ordinal = 0 AND v.is_hidden = FALSE AND v.surface_id = ? GROUP BY v.language ORDER BY cnt DESC LIMIT 5') {
      const [family, surface] = args as [string, string]
      const counts = new Map<string, number>()
      for (const voice of this.visiblePrimaryVoices(family, surface)) {
        const key = voice.language ?? 'en'
        counts.set(key, (counts.get(key) ?? 0) + 1)
      }
      return [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([language, cnt]) => ({ language, cnt })) as T[]
    }
    // Post-review fix (item 6): cache.ts's 'room_fading' sweep now runs on EVERY rebuild, but this
    // base mock (used directly by many test files via makeTestEnv, no DoorD1 layered on) has no
    // concept of rooms at all — that's a Phase 18/DoorD1-only addition. The correct answer for a
    // rooms-less world is simply "no room is fading."
    if (normalized.startsWith('SELECT seed_voice_id, author_id, expires_at FROM rooms')) {
      return [] as T[]
    }
    throw new Error(`Mock D1 does not handle: ${normalized}`)
  }

  private async executeRun(sql: string, args: unknown[]): Promise<number> {
    const normalized = normalizeSql(sql)
    // Phase 17 Part B: op_receipts retention, piggybacked on every rebuildStateProjection call.
    // No seed here ever populates op_receipts, so this is always a no-op.
    if (normalized.startsWith('DELETE FROM op_receipts')) return 0
    // Phase 16 Part E: quarantine release, head of rebuildStateProjection. No seed here ever sets
    // visibility = 'quarantined' (the fuse is off), so this is always a no-op — kept as an
    // explicit match rather than falling through to the generic throw below.
    if (normalized.startsWith("UPDATE voices SET visibility = 'surfaced', is_hidden = FALSE WHERE visibility = 'quarantined'")) {
      const cutoff = args[0] as number
      let changes = 0
      for (const v of this.voices) {
        if (v.visibility === 'quarantined' && ((v.damped ?? 0) === 0 || v.created_at < cutoff)) {
          v.visibility = 'surfaced'; v.is_hidden = 0; changes++
        }
      }
      return changes
    }
    if (normalized.startsWith('INSERT INTO rate_limits')) {
      const [key, now, expiresAt, check1] = args as [string, number, number, number]
      const existing = this.rateLimits.find(row => row.key === key)
      if (!existing) {
        this.rateLimits.push({ key, count: 1, window_start: now, expires_at: expiresAt })
      } else if (existing.expires_at <= check1) {
        existing.count = 1
        existing.window_start = now
        existing.expires_at = expiresAt
      } else {
        existing.count += 1
      }
      return 1
    }
    if (normalized.startsWith('INSERT INTO warmth_state (surface_id, family, score, last_updated) VALUES')) {
      // Warmth UPSERT: args = [surface, family, contribution, now] — PRIMARY KEY (surface_id, family).
      const [surface, family, contribution, now] = args as [string, Family, number, number]
      if (this.failWarmthUpdateFamilies.has(family)) throw new Error('warmth update failed')
      const existing = this.warmthState.find(row => row.family === family && (row.surface_id ?? 'vellum') === surface)
      if (!existing) {
        this.warmthState.push({ surface_id: surface, family, score: contribution, last_updated: now })
      } else {
        const elapsed = (now - existing.last_updated) / 3_600_000
        existing.score = existing.score * Math.exp(-0.029 * elapsed) + contribution
        existing.last_updated = now
      }
      return 1
    }
    throw new Error(`Mock D1 does not handle: ${normalized}`)
  }
}

export function makeTestEnv(seed: Seed = {}) {
  const db = new MockD1(seed)
  const kv = new MockKV()
  const analytics = new MockAnalytics()
  const env = {
    DB: db as unknown as D1Database,
    KV: kv as unknown as KVNamespace,
    ANALYTICS: analytics as unknown as AnalyticsEngineDataset,
    ASSETS: { fetch: () => { throw new Error('ASSETS.fetch not implemented in tests') } } as unknown as Fetcher,
    ADMIN_KEY: 'test-secret',
    SESSION_SECRET: 'test-session-secret',
    ENVIRONMENT: 'test',
  }
  return { env, db, kv, analytics }
}
