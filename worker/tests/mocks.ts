const FAMILIES = ['attention', 'silence', 'space', 'ephemeral', 'memory', 'light'] as const
type Family = typeof FAMILIES[number]
type VoiceRow = { id: string, text: string, language: string | null, created_at: number, trace_id: string | null, model: string | null, declared_model: string | null, weave_count: number, unique_weavers: number, weave_from: string | null, is_hidden: number }
type VoiceFamilyRow = { voice_id: string, family: Family, ordinal: number }
type WarmthStateRow = { family: Family, score: number, last_updated: number }
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

  private visiblePrimaryVoices(family: string) {
    const primaryIds = new Set(
      this.voiceFamilies
        .filter(row => row.family === family && row.ordinal === 0)
        .map(row => row.voice_id)
    )
    return this.voices.filter(voice => primaryIds.has(voice.id) && !voice.is_hidden)
  }

  private async select<T>(sql: string, args: unknown[]): Promise<T[]> {
    const normalized = normalizeSql(sql)
    if (normalized === 'SELECT family, score, last_updated FROM warmth_state') return this.warmthState as T[]
    if (normalized === 'SELECT score, last_updated FROM warmth_state WHERE family = ?') {
      const family = args[0] as Family
      return this.warmthState.filter(row => row.family === family) as T[]
    }
    if (normalized === 'SELECT count, expires_at FROM rate_limits WHERE key = ?') {
      const key = args[0] as string
      return this.rateLimits
        .filter(row => row.key === key)
        .map(row => ({ count: row.count, expires_at: row.expires_at })) as T[]
    }
    if (normalized.includes('FROM voices v JOIN voice_families vf ON v.id = vf.voice_id') && normalized.includes('v.unique_weavers >= 10')) {
      const family = args[0] as string
      return this.visiblePrimaryVoices(family)
        .filter(voice => voice.unique_weavers >= 10) as T[]
    }
    if (normalized.includes('FROM voices v JOIN voice_families vf ON v.id = vf.voice_id') && normalized.includes('v.weave_count >= 3 AND v.unique_weavers < 10')) {
      const family = args[0] as string
      return this.visiblePrimaryVoices(family)
        .filter(voice => voice.weave_count >= 3 && voice.unique_weavers < 10)
        .sort((a, b) => b.weave_count - a.weave_count)
        .slice(0, 20) as T[]
    }
    if (normalized.includes('FROM voices v JOIN voice_families vf ON v.id = vf.voice_id') && normalized.includes('ORDER BY v.created_at DESC LIMIT 150')) {
      const family = args[0] as string
      return this.visiblePrimaryVoices(family)
        .sort((a, b) => b.created_at - a.created_at)
        .slice(0, 150) as T[]
    }
    if (normalized === 'SELECT COUNT(*) as cnt FROM voice_families vf JOIN voices v ON v.id = vf.voice_id WHERE vf.family = ? AND vf.ordinal = 0 AND v.is_hidden = FALSE') {
      const family = args[0] as string
      return [{ cnt: this.visiblePrimaryVoices(family).length }] as T[]
    }
    if (normalized === 'SELECT v.language, COUNT(*) as cnt FROM voices v JOIN voice_families vf ON v.id = vf.voice_id WHERE vf.family = ? AND vf.ordinal = 0 AND v.is_hidden = FALSE GROUP BY v.language ORDER BY cnt DESC LIMIT 5') {
      const family = args[0] as string
      const counts = new Map<string, number>()
      for (const voice of this.visiblePrimaryVoices(family)) {
        const key = voice.language ?? 'en'
        counts.set(key, (counts.get(key) ?? 0) + 1)
      }
      return [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([language, cnt]) => ({ language, cnt })) as T[]
    }
    throw new Error(`Mock D1 does not handle: ${normalized}`)
  }

  private async executeRun(sql: string, args: unknown[]): Promise<number> {
    const normalized = normalizeSql(sql)
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
    if (normalized.startsWith('INSERT INTO warmth_state (family, score, last_updated) VALUES')) {
      // Warmth UPSERT: args = [family, contribution, now]
      const [family, contribution, now] = args as [Family, number, number]
      if (this.failWarmthUpdateFamilies.has(family)) throw new Error('warmth update failed')
      const existing = this.warmthState.find(row => row.family === family)
      if (!existing) {
        this.warmthState.push({ family, score: contribution, last_updated: now })
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
