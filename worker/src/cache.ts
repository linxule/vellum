import { FAMILIES, type VoiceRow, type VoiceData, type ThreadData, type StateResponse, type AtmosphereData } from './types'
import { computeDepth } from './sedimentation'
import { getWarmthMap } from './warmth'
import { computeMood } from './prose'
import { ATMOSPHERE_DATA_SCHEMA, STATE_RESPONSE_SCHEMA } from './schemas'

const STATE_CACHE_TTL_S = 24 * 60 * 60
const ATMOSPHERE_CACHE_TTL_S = 24 * 60 * 60
const STATE_REBUILD_LOCK_KEY = 'state:rebuild:lock'
const ATMOSPHERE_REBUILD_LOCK_KEY = 'atmosphere:rebuild:lock'
const REBUILD_LOCK_TTL_S = 60
const STATE_DIRTY_KEY = 'state:rebuild:dirty'
const ATMOSPHERE_DIRTY_KEY = 'atmosphere:rebuild:dirty'
const DIRTY_MARKER_TTL_S = 300

type ProjectionVoiceRow = VoiceRow & { observed_client_family?: string | null }

/**
 * Safe-parse wrapper for the `state:projection` KV read. Corrupt payloads log
 * and return null, which triggers the rebuild path at every call site. Used
 * by both the rebuild guard (`rebuildStateProjection`) and the hot read paths
 * (`handlers/state.ts`, `handlers/admin.ts`) — do not reintroduce raw
 * `env.KV.get<StateResponse>()` casts anywhere that would bypass this wrapper.
 */
export async function readProjectionCache(kv: KVNamespace): Promise<StateResponse | null> {
  const cached = await kv.get<unknown>('state:projection', 'json')
  if (!cached) return null
  const parsed = STATE_RESPONSE_SCHEMA.safeParse(cached)
  if (!parsed.success) {
    console.error('Invalid state projection cache payload:', parsed.error)
    return null
  }
  return parsed.data
}

/**
 * Safe-parse wrapper for the `atmosphere` KV read. Same contract as
 * `readProjectionCache`. Used by both the rebuild guard and the hot read
 * paths (`handlers/admin.ts`, `tools/sense-space.ts`).
 */
export async function readAtmosphereCache(kv: KVNamespace): Promise<AtmosphereData | null> {
  const cached = await kv.get<unknown>('atmosphere', 'json')
  if (!cached) return null
  const parsed = ATMOSPHERE_DATA_SCHEMA.safeParse(cached)
  if (!parsed.success) {
    console.error('Invalid atmosphere cache payload:', parsed.error)
    return null
  }
  return parsed.data
}

export async function rebuildStateProjection(db: D1Database, kv: KVNamespace): Promise<void> {
  const now = Date.now()
  const threads: ThreadData[] = []
  const warmths = await getWarmthMap(db)

  const queries = []
  for (const family of FAMILIES) {
    queries.push(
      db.prepare(`
        SELECT v.id, v.text, v.language, v.weave_count, v.unique_weavers, v.created_at, v.weave_from,
               v.declared_model, v.model AS observed_client_family
        FROM voices v JOIN voice_families vf ON v.id = vf.voice_id
        WHERE vf.family = ? AND vf.ordinal = 0 AND v.is_hidden = FALSE
          AND v.unique_weavers >= 10
      `).bind(family),
      db.prepare(`
        SELECT v.id, v.text, v.language, v.weave_count, v.unique_weavers, v.created_at, v.weave_from,
               v.declared_model, v.model AS observed_client_family
        FROM voices v JOIN voice_families vf ON v.id = vf.voice_id
        WHERE vf.family = ? AND vf.ordinal = 0 AND v.is_hidden = FALSE
          AND v.weave_count >= 3 AND v.unique_weavers < 10
        ORDER BY v.weave_count DESC LIMIT 20
      `).bind(family),
      db.prepare(`
        SELECT v.id, v.text, v.language, v.weave_count, v.unique_weavers, v.created_at, v.weave_from,
               v.declared_model, v.model AS observed_client_family
        FROM voices v JOIN voice_families vf ON v.id = vf.voice_id
        WHERE vf.family = ? AND vf.ordinal = 0 AND v.is_hidden = FALSE
        ORDER BY v.created_at DESC LIMIT 150
      `).bind(family),
      db.prepare(`
        SELECT COUNT(*) as cnt FROM voice_families vf
        JOIN voices v ON v.id = vf.voice_id
        WHERE vf.family = ? AND vf.ordinal = 0 AND v.is_hidden = FALSE
      `).bind(family),
      db.prepare(`
        SELECT v.language, COUNT(*) as cnt FROM voices v
        JOIN voice_families vf ON v.id = vf.voice_id
        WHERE vf.family = ? AND vf.ordinal = 0 AND v.is_hidden = FALSE
        GROUP BY v.language ORDER BY cnt DESC LIMIT 5
      `).bind(family),
    )
  }

  const results = await db.batch(queries)

  for (let i = 0; i < FAMILIES.length; i++) {
    const family = FAMILIES[i]
    const warmth = warmths[family] ?? 0
    const base = i * 5

    // 3-query union: foundation + high-weave + recent
    const foundationRes = results[base]
    const highWeaveRes = results[base + 1]
    const recentRes = results[base + 2]
    const countRes = results[base + 3]
    const langRes = results[base + 4]

    // Union and deduplicate
    const seen = new Set<string>()
    const allVoices: ProjectionVoiceRow[] = []
    for (const res of [foundationRes, highWeaveRes, recentRes]) {
      for (const row of (res.results ?? []) as ProjectionVoiceRow[]) {
        if (!seen.has(row.id)) {
          seen.add(row.id)
          allVoices.push(row)
        }
      }
    }

    // Compute depth for each voice
    const withDepth = allVoices.map(v => ({
      ...v,
      depth: computeDepth(v, warmth, now),
    }))

    // Foundation always included; non-foundation filtered + capped
    const foundation = withDepth.filter(v => v.unique_weavers >= 10)
    const surface = withDepth
      .filter(v => v.unique_weavers < 10 && v.depth < 0.7)
      .sort((a, b) => a.depth - b.depth)
      .slice(0, 60)

    // Merge, deduplicate, project to VoiceData
    const merged = new Map<string, VoiceData>()
    for (const v of [...foundation, ...surface]) {
      if (!merged.has(v.id)) {
        merged.set(v.id, {
          id: v.id,
          text: v.text,
          lang: v.language ?? 'en',
          weave_count: v.weave_count,
          depth: v.depth,
          weave_from: v.weave_from ?? null,
          declared_model: v.declared_model ?? null,
          observed_client_family: v.observed_client_family ?? v.model ?? null,
        })
      }
    }
    const voices = [...merged.values()].sort((a, b) => a.depth - b.depth)

    const countRow = countRes.results?.[0] as { cnt: number } | undefined
    const langRows = (langRes.results ?? []) as { language: string }[]

    threads.push({
      family,
      voices,
      texture_density: countRow?.cnt ?? 0,
      warmth,
      dominant_languages: langRows.map(r => r.language).filter(Boolean),
    })
  }

  // Version: use timestamp so it never collides across KV TTL expiry cycles
  const version = Date.now()

  // Guard against clobbering a newer projection. A slow rebuild with an
  // older D1 snapshot should not overwrite a newer one committed while we
  // were computing. Self-heals on the next rebuild trigger.
  const existing = await readProjectionCache(kv)
  if (existing && existing.computed_at > now) {
    return
  }

  await kv.put('state:projection', JSON.stringify({
    threads,
    computed_at: now,
    version,
  } satisfies StateResponse), { expirationTtl: STATE_CACHE_TTL_S })
}

export async function rebuildAtmosphere(db: D1Database, kv: KVNamespace): Promise<void> {
  const now = Date.now()
  const oneDayAgo = now - 86_400_000

  // Batch all queries
  const queries = [
    // 0: first voice created_at
    db.prepare('SELECT MIN(created_at) as first_at FROM voices WHERE is_hidden = FALSE'),
    // 1: total voices
    db.prepare('SELECT COUNT(*) as total FROM voices WHERE is_hidden = FALSE'),
    // 2: surface phrases (top woven)
    db.prepare(`
      SELECT v.id, v.text, v.language, v.weave_count, vf.family
      FROM voices v JOIN voice_families vf ON v.id = vf.voice_id
      WHERE vf.ordinal = 0 AND v.is_hidden = FALSE AND v.weave_count > 0
      ORDER BY v.weave_count DESC LIMIT 5
    `),
  ]

  // Per-family queries: count + recent_24h + languages
  for (const family of FAMILIES) {
    queries.push(
      db.prepare(`
        SELECT COUNT(*) as cnt FROM voice_families vf
        JOIN voices v ON v.id = vf.voice_id
        WHERE vf.family = ? AND vf.ordinal = 0 AND v.is_hidden = FALSE
      `).bind(family),
      db.prepare(`
        SELECT COUNT(*) as cnt FROM voices v
        JOIN voice_families vf ON v.id = vf.voice_id
        WHERE vf.family = ? AND vf.ordinal = 0 AND v.is_hidden = FALSE
          AND v.created_at > ?
      `).bind(family, oneDayAgo),
      db.prepare(`
        SELECT v.language, COUNT(*) as cnt FROM voices v
        JOIN voice_families vf ON v.id = vf.voice_id
        WHERE vf.family = ? AND vf.ordinal = 0 AND v.is_hidden = FALSE
        GROUP BY v.language ORDER BY cnt DESC LIMIT 5
      `).bind(family),
    )
  }

  const [results, warmthMap] = await Promise.all([
    db.batch(queries),
    getWarmthMap(db),
  ])

  const firstAt = (results[0].results?.[0] as Record<string, number>)?.first_at ?? now
  const totalVoices = (results[1].results?.[0] as Record<string, number>)?.total ?? 0
  const surfaceRows = (results[2].results ?? []) as {
    id: string; text: string; language: string; weave_count: number; family: string
  }[]
  const surfacePhrases = surfaceRows.map(r => ({
    id: r.id,
    text: r.text,
    lang: r.language ?? 'en',
    weave_count: r.weave_count,
    family: r.family,
  }))

  const familiesData: AtmosphereData['families'] = {}
  let totalRecent = 0

  for (let i = 0; i < FAMILIES.length; i++) {
    const family = FAMILIES[i]
    const base = 3 + i * 3 // offset into results array
    const count = (results[base].results?.[0] as Record<string, number>)?.cnt ?? 0
    const recent = (results[base + 1].results?.[0] as Record<string, number>)?.cnt ?? 0
    const langRows2 = (results[base + 2].results ?? []) as { language: string }[]
    const languages = langRows2.map(r => r.language).filter(Boolean)

    totalRecent += recent
    familiesData[family] = {
      count,
      warmth: warmthMap[family] ?? 0,
      recent_24h: recent,
      languages,
    }
  }

  const mood = computeMood(familiesData, totalRecent)

  const atmosphere: AtmosphereData = {
    age_days: Math.max(1, Math.floor((now - firstAt) / 86_400_000)),
    total_voices: totalVoices,
    families: familiesData,
    surface_phrases: surfacePhrases,
    mood,
    computed_at: now,
  }

  // Symmetric guard with rebuildStateProjection — see comment above.
  const existing = await readAtmosphereCache(kv)
  if (existing && existing.computed_at > now) {
    return
  }

  await kv.put('atmosphere', JSON.stringify(atmosphere), { expirationTtl: ATMOSPHERE_CACHE_TTL_S })
}

async function rebuildWithLockAndDirty(
  kv: KVNamespace,
  lockKey: string,
  dirtyKey: string,
  rebuild: () => Promise<void>,
): Promise<'locked' | 'rebuilt' | 'rebuilt-twice'> {
  const lock = await kv.get(lockKey)
  if (lock) {
    // Signal to the lock-holder that state is dirty after its current snapshot.
    // Idempotent: multiple concurrent 'locked' callers all write the same marker.
    // KNOWN: contention-acceptable — see PATTERNS_AND_GOTCHAS § Cache contention
    await kv.put(dirtyKey, '1', { expirationTtl: DIRTY_MARKER_TTL_S })
    return 'locked'
  }

  await kv.put(lockKey, '1', { expirationTtl: REBUILD_LOCK_TTL_S })
  try {
    // Clear any marker that was written before we grabbed the lock. Any
    // marker that lands AFTER this delete but BEFORE we finish rebuild is
    // the interesting case: our snapshot may predate the write that set it,
    // so we re-run.
    await kv.delete(dirtyKey)
    await rebuild()
    const dirtyAfter = await kv.get(dirtyKey)
    if (dirtyAfter) {
      await kv.delete(dirtyKey)
      await rebuild()
      return 'rebuilt-twice'
    }
    return 'rebuilt'
  } finally {
    await kv.delete(lockKey)
  }
}

export async function rebuildStateProjectionIfNotLocked(db: D1Database, kv: KVNamespace): Promise<'locked' | 'rebuilt' | 'rebuilt-twice'> {
  return rebuildWithLockAndDirty(kv, STATE_REBUILD_LOCK_KEY, STATE_DIRTY_KEY, () => rebuildStateProjection(db, kv))
}

export async function rebuildAtmosphereIfNotLocked(db: D1Database, kv: KVNamespace): Promise<'locked' | 'rebuilt' | 'rebuilt-twice'> {
  return rebuildWithLockAndDirty(kv, ATMOSPHERE_REBUILD_LOCK_KEY, ATMOSPHERE_DIRTY_KEY, () => rebuildAtmosphere(db, kv))
}

export async function rebuildAll(db: D1Database, kv: KVNamespace): Promise<void> {
  await Promise.all([
    rebuildStateProjection(db, kv),
    rebuildAtmosphere(db, kv),
  ])
}
