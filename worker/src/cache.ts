import { FAMILIES, type VoiceRow, type VoiceData, type ThreadData, type StateResponse, type AtmosphereData, type LeveeMode } from './types'
import { computeDepth } from './sedimentation'
import { isPermanent } from './levee-permanence'
import { releaseQuarantineStatement } from './visibility'
import { getWarmthMap, getWarmthCheckpoints } from './warmth'
import { computeMood } from './prose'
import { ATMOSPHERE_DATA_SCHEMA, STATE_RESPONSE_SCHEMA } from './schemas'
import { LEVEE, ARCHIPELAGO } from './contract'
import { nextSinkMark, SINK_THRESHOLDS } from './sinking'
import { buildSinkingPayload, buildRoomFadingPayload, buildSurfaceWarmedPayload, echoEventInsertStatement, refreshEchoCache } from './echo'
import { opReceiptSweepStatement } from './idempotency'
import { DEFAULT_SURFACE } from './surfaces'

const STATE_CACHE_TTL_S = 24 * 60 * 60
const ATMOSPHERE_CACHE_TTL_S = 24 * 60 * 60
const REBUILD_LOCK_TTL_S = 60
const DIRTY_MARKER_TTL_S = 300

// Phase 18 Part B3: per-surface KV keys. The default surface keeps the LEGACY unsuffixed key — no
// KV migration, no cold miss on deploy, and /api/state stays byte-identical for every existing
// caller (S6). A non-default surface gets its own suffixed namespace.
function projectionKey(surface: string): string {
  return surface === DEFAULT_SURFACE ? 'state:projection' : `state:projection:${surface}`
}
function atmosphereKey(surface: string): string {
  return surface === DEFAULT_SURFACE ? 'atmosphere' : `atmosphere:${surface}`
}
function stateLockKey(surface: string): string {
  return surface === DEFAULT_SURFACE ? 'state:rebuild:lock' : `state:rebuild:lock:${surface}`
}
function stateDirtyKey(surface: string): string {
  return surface === DEFAULT_SURFACE ? 'state:rebuild:dirty' : `state:rebuild:dirty:${surface}`
}
function atmosphereLockKey(surface: string): string {
  return surface === DEFAULT_SURFACE ? 'atmosphere:rebuild:lock' : `atmosphere:rebuild:lock:${surface}`
}
function atmosphereDirtyKey(surface: string): string {
  return surface === DEFAULT_SURFACE ? 'atmosphere:rebuild:dirty' : `atmosphere:rebuild:dirty:${surface}`
}

type ProjectionVoiceRow = VoiceRow & { observed_client_family?: string | null }

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Safe-parse wrapper for the `state:projection` KV read (per-surface key — see `projectionKey`).
 * Corrupt payloads log and return null, which triggers the rebuild path at every call site. Used
 * by both the rebuild guard (`rebuildStateProjection`) and the hot read paths
 * (`handlers/state.ts`, `handlers/admin.ts`) — do not reintroduce raw
 * `env.KV.get<StateResponse>()` casts anywhere that would bypass this wrapper.
 */
export async function readProjectionCache(kv: KVNamespace, surface: string = DEFAULT_SURFACE): Promise<StateResponse | null> {
  const cached = await kv.get<unknown>(projectionKey(surface), 'json')
  if (!cached) return null
  const parsed = STATE_RESPONSE_SCHEMA.safeParse(cached)
  if (!parsed.success) {
    console.error('Invalid state projection cache payload:', parsed.error)
    return null
  }
  return parsed.data
}

/**
 * Safe-parse wrapper for the `atmosphere` KV read (per-surface key — see `atmosphereKey`). Same
 * contract as `readProjectionCache`. Used by both the rebuild guard and the hot read paths
 * (`handlers/admin.ts`, `tools/sense-space.ts`).
 */
export async function readAtmosphereCache(kv: KVNamespace, surface: string = DEFAULT_SURFACE): Promise<AtmosphereData | null> {
  const cached = await kv.get<unknown>(atmosphereKey(surface), 'json')
  if (!cached) return null
  const parsed = ATMOSPHERE_DATA_SCHEMA.safeParse(cached)
  if (!parsed.success) {
    console.error('Invalid atmosphere cache payload:', parsed.error)
    return null
  }
  return parsed.data
}

/**
 * Phase 16 Part D2: drop the deepest non-foundation voices (highest depth = least resistant to
 * sinking) until the serialized payload is under budget. A foundation voice (depth floor 0.1) is
 * never dropped — its guaranteed slot is the one thing D2 protects.
 */
export function trimProjectionToBudget(threads: ThreadData[], maxBytes: number): { threads: ThreadData[]; trimmed: number } {
  let trimmed = 0
  const working = threads.map(t => ({ ...t, voices: [...t.voices] }))
  const size = () => new TextEncoder().encode(JSON.stringify(working)).length
  while (size() > maxBytes) {
    let worst: { familyIndex: number; voiceIndex: number; depth: number } | undefined
    for (let fi = 0; fi < working.length; fi++) {
      for (let vi = 0; vi < working[fi].voices.length; vi++) {
        const v = working[fi].voices[vi]
        if (v.depth <= 0.1) continue // never drop a foundation voice
        if (!worst || v.depth > worst.depth) worst = { familyIndex: fi, voiceIndex: vi, depth: v.depth }
      }
    }
    if (!worst) break // nothing left to trim (everything is foundation) — accept the size
    working[worst.familyIndex].voices.splice(worst.voiceIndex, 1)
    trimmed++
  }
  return { threads: working, trimmed }
}

export async function rebuildStateProjection(db: D1Database, kv: KVNamespace, rebuildMode: LeveeMode = 'off', surface: string = DEFAULT_SURFACE, permanenceMode: LeveeMode = 'off'): Promise<void> {
  const now = Date.now()

  // Phase 16 Part E: release runs first, as one indexed UPDATE, free when nothing is
  // quarantined (partial index on visibility='quarantined'). With the fuse off this never
  // matches any row. Inside the same try/catch every write path already wraps rebuilds in.
  // Phase 18: unscoped by surface deliberately — a quarantined voice releases regardless of which
  // ocean it's on; the fuse (Part C5) treats every surface alike.
  // Post-review fix (item 2): routed through visibility.ts's releaseQuarantineStatement so that
  // module stays the single writer of visibility/is_hidden, instead of hand-rolling the same UPDATE
  // here.
  try {
    await releaseQuarantineStatement(db, LEVEE.fuse.quarantineMaxAgeMs, now).run()
  } catch (e) { console.error('[levee] quarantine release failed:', e) }

  const threads: ThreadData[] = []
  const warmths = await getWarmthMap(db, surface)
  // Phase 17 Part C1: 'sinking' echo candidates, collected across every family this rebuild
  // touches. A voice's primary family (vf.ordinal = 0) is unique, so no voice appears twice here.
  const sinkCandidates: { id: string; authorId: string; sinkMark: number; depth: number; createdAt: number; uniqueWeavers: number }[] = []

  const queries = []
  for (const family of FAMILIES) {
    queries.push(
      // Foundation: earned permanence (qualified_weavers >= 10) or grandfathered legacy voices.
      // Post-16 SQL — see docs/PHASE_16_SPEC.md Part D3; keep worker/tests/mocks.ts in sync with
      // this literal text, not with the spec's own citation (it goes stale after this lands).
      // Phase 18 Part B3: gains `AND v.surface_id = ?` — additive, live post-17 text otherwise.
      db.prepare(`
        SELECT v.id, v.text, v.language, v.weave_count, v.unique_weavers, v.qualified_weavers,
               v.permanence_source, v.created_at, v.weave_from,
               v.declared_model, v.model AS observed_client_family,
               v.author_id, v.sink_mark
        FROM voices v JOIN voice_families vf ON v.id = vf.voice_id
        WHERE vf.family = ? AND vf.ordinal = 0 AND v.is_hidden = FALSE AND v.surface_id = ?
          AND (v.qualified_weavers >= 10 OR v.permanence_source = 'legacy')
        ORDER BY v.qualified_weavers DESC, v.created_at DESC
        LIMIT ${LEVEE.foundationCap}
      `).bind(family, surface),
      db.prepare(`
        SELECT v.id, v.text, v.language, v.weave_count, v.unique_weavers, v.qualified_weavers,
               v.permanence_source, v.created_at, v.weave_from,
               v.declared_model, v.model AS observed_client_family,
               v.author_id, v.sink_mark
        FROM voices v JOIN voice_families vf ON v.id = vf.voice_id
        WHERE vf.family = ? AND vf.ordinal = 0 AND v.is_hidden = FALSE AND v.surface_id = ?
          AND v.weave_count >= 3
          AND NOT (v.qualified_weavers >= 10 OR v.permanence_source = 'legacy')
        ORDER BY v.weave_count DESC LIMIT 20
      `).bind(family, surface),
      db.prepare(`
        SELECT v.id, v.text, v.language, v.weave_count, v.unique_weavers, v.qualified_weavers,
               v.permanence_source, v.created_at, v.weave_from,
               v.declared_model, v.model AS observed_client_family,
               v.author_id, v.sink_mark
        FROM voices v JOIN voice_families vf ON v.id = vf.voice_id
        WHERE vf.family = ? AND vf.ordinal = 0 AND v.is_hidden = FALSE AND v.surface_id = ?
        ORDER BY v.created_at DESC LIMIT 150
      `).bind(family, surface),
      db.prepare(`
        SELECT COUNT(*) as cnt FROM voice_families vf
        JOIN voices v ON v.id = vf.voice_id
        WHERE vf.family = ? AND vf.ordinal = 0 AND v.is_hidden = FALSE AND v.surface_id = ?
      `).bind(family, surface),
      db.prepare(`
        SELECT v.language, COUNT(*) as cnt FROM voices v
        JOIN voice_families vf ON v.id = vf.voice_id
        WHERE vf.family = ? AND vf.ordinal = 0 AND v.is_hidden = FALSE AND v.surface_id = ?
        GROUP BY v.language ORDER BY cnt DESC LIMIT 5
      `).bind(family, surface),
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
      depth: computeDepth(v, warmth, now, permanenceMode),
    }))

    // Phase 17 Part C1: named voices only (there is no one to tell for an anonymous one).
    for (const v of withDepth) {
      if (!v.author_id) continue
      sinkCandidates.push({ id: v.id, authorId: v.author_id, sinkMark: v.sink_mark ?? 0, depth: v.depth, createdAt: v.created_at, uniqueWeavers: v.unique_weavers })
    }

    // Foundation always included; non-foundation filtered + capped. Same LEVEE_PERMANENCE gate as
    // computeDepth above: 'on' reads the weighted qualified_weavers/permanence_source rule,
    // 'off'/'shadow' falls back to the pre-Phase-16 unique_weavers >= 10 rule — kept consistent
    // with the depth floor computeDepth already applied to these same rows a few lines up.
    const isFoundation = (v: { qualified_weavers?: number; permanence_source?: 'legacy' | 'earned'; unique_weavers: number }) =>
      permanenceMode === 'on'
        ? isPermanent({ qualified_weavers: v.qualified_weavers ?? 0, permanence_source: v.permanence_source })
        : v.unique_weavers >= 10
    const foundation = withDepth.filter(isFoundation)
    const surface = withDepth
      .filter(v => !isFoundation(v) && v.depth < 0.7)
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

  // Phase 17 Part C1: emit 'sinking' echoes for voices newly crossing 0.5/0.7/0.9, bounded at
  // 200 marks per rebuild (oldest first — the rest catch up next rebuild). Never blocks the
  // projection write; a failure here is logged and the KV put below still happens.
  try {
    const toMark = sinkCandidates
      .map(c => ({ ...c, newMark: nextSinkMark(c.sinkMark, c.depth) }))
      .filter((c): c is typeof c & { newMark: number } => c.newMark !== null)
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(0, 200)
    if (toMark.length > 0) {
      // Post-review fix (item 2): the UPDATE's own `WHERE sink_mark < ?` guard was already
      // race-safe, but the paired echo INSERT used to ride the SAME batch unconditionally — two
      // concurrent rebuilds racing the same voice's crossing would both have their UPDATE
      // resolved correctly (only one actually raises sink_mark), yet BOTH would still insert a
      // 'sinking' echo, duplicating it in the loser's mailbox. Split into two passes: batch the
      // guarded UPDATEs first, then insert an echo only for the ones whose UPDATE actually
      // matched (`meta.changes > 0`) — same pattern tools/weave.ts's 'rooted' echo already uses.
      const updateResults = await db.batch(
        toMark.map(c => db.prepare('UPDATE voices SET sink_mark = ? WHERE id = ? AND sink_mark < ?').bind(c.newMark, c.id, c.newMark)),
      )
      const claimed = toMark.filter((_, i) => (updateResults[i]?.meta?.changes ?? 0) > 0)
      if (claimed.length > 0) {
        await db.batch(claimed.map(c => echoEventInsertStatement(db, {
          agentId: c.authorId, kind: 'sinking', voiceId: c.id, byVoice: null, byId: null, at: now,
          payload: buildSinkingPayload({ depth: c.depth, threshold: SINK_THRESHOLDS[c.newMark - 1], weavers: c.uniqueWeavers }),
        })))
        for (const agentId of new Set(claimed.map(c => c.authorId))) await refreshEchoCache({ DB: db, KV: kv }, agentId)
      }
    }
  } catch (e) { console.error('[echo] sinking sweep failed:', e) }

  // Post-review fix (item 6, Phase 18 gap): 'room_fading' — owner echo, 48h before a room's
  // expires_at, riding this same rebuild-time sweep (docs/PHASE_18_REPORT.md deviation #5). A room
  // in this window that hasn't been echoed yet gets one, guarded like 'sinking' above: the UPDATE
  // wins the race, the echo only fires for rooms whose UPDATE actually matched. Re-extending a
  // room past the lead window (weave/extend) resets `fading_echoed_at` to NULL — see rooms.ts —
  // so a room that later approaches expiry again re-triggers this.
  try {
    const fadingWindow = await db.prepare(
      `SELECT seed_voice_id, author_id, expires_at FROM rooms
       WHERE surface_id = ? AND expires_at > ? AND expires_at <= ? AND fading_echoed_at IS NULL
       ORDER BY expires_at ASC LIMIT 100`,
    ).bind(surface, now, now + ARCHIPELAGO.room.fadingEchoLeadMs).all<{ seed_voice_id: string; author_id: string; expires_at: number }>()
    const fadingCandidates = fadingWindow.results ?? []
    if (fadingCandidates.length > 0) {
      const updateResults = await db.batch(
        fadingCandidates.map(r => db.prepare('UPDATE rooms SET fading_echoed_at = ? WHERE seed_voice_id = ? AND fading_echoed_at IS NULL').bind(now, r.seed_voice_id)),
      )
      const claimed = fadingCandidates.filter((_, i) => (updateResults[i]?.meta?.changes ?? 0) > 0)
      if (claimed.length > 0) {
        await db.batch(claimed.map(r => echoEventInsertStatement(db, {
          agentId: r.author_id, kind: 'room_fading', voiceId: r.seed_voice_id, byVoice: null, byId: null, at: now,
          payload: buildRoomFadingPayload({ expiresAt: r.expires_at }),
        })))
        for (const agentId of new Set(claimed.map(r => r.author_id))) await refreshEchoCache({ DB: db, KV: kv }, agentId)
      }
    }
  } catch (e) { console.error('[echo] room_fading sweep failed:', e) }

  // Post-review fix (item 6, Phase 18 gap): 'surface_warmed' — owner echo when any current on
  // their surface crosses warmth 1.0 from below, gated to once per current per week
  // (docs/PHASE_18_REPORT.md deviation #5). No-op for the default ocean, matching
  // surfaces.ts's touchSurfaceActivity: 'vellum' has no owner in the sense this feature targets.
  // Guarded like 'sinking'/'room_fading' above: the crossing+gate UPDATE only "claims" a family
  // when both conditions hold; every other family still gets its checked_score refreshed
  // (unconditionally) so the next rebuild compares against the right baseline.
  if (surface !== DEFAULT_SURFACE) {
    try {
      const checkpoints = await getWarmthCheckpoints(db, surface)
      const gateMs = 7 * 24 * 3600 * 1000
      const crossing = FAMILIES.filter(family => {
        const cp = checkpoints[family]
        return (warmths[family] ?? 0) >= 1.0 && cp.checkedScore < 1.0 && (cp.warmedEchoedAt === null || now - cp.warmedEchoedAt > gateMs)
      })
      const steady = FAMILIES.filter(family => !crossing.includes(family))
      const warmthUpdates = [
        ...crossing.map(family => db.prepare(
          `UPDATE warmth_state SET checked_score = ?, warmed_echoed_at = ?
           WHERE surface_id = ? AND family = ? AND checked_score < 1.0 AND (warmed_echoed_at IS NULL OR warmed_echoed_at < ?)`,
        ).bind(warmths[family] ?? 0, now, surface, family, now - gateMs)),
        ...steady.map(family => db.prepare(
          'UPDATE warmth_state SET checked_score = ? WHERE surface_id = ? AND family = ?',
        ).bind(warmths[family] ?? 0, surface, family)),
      ]
      if (warmthUpdates.length > 0) {
        const results = await db.batch(warmthUpdates)
        const claimedFamilies = crossing.filter((_, i) => (results[i]?.meta?.changes ?? 0) > 0)
        if (claimedFamilies.length > 0) {
          const surfaceRow = await db.prepare('SELECT author_id FROM surfaces WHERE id = ?').bind(surface).first<{ author_id: string }>()
          if (surfaceRow?.author_id) {
            await db.batch(claimedFamilies.map(family => echoEventInsertStatement(db, {
              agentId: surfaceRow.author_id, kind: 'surface_warmed', voiceId: '', byVoice: null, byId: null, at: now,
              payload: buildSurfaceWarmedPayload({ family }),
            })))
            await refreshEchoCache({ DB: db, KV: kv }, surfaceRow.author_id)
          }
        }
      }
    } catch (e) { console.error('[echo] surface_warmed sweep failed:', e) }
  }

  // Phase 17 Part B: op_receipts retention, piggybacked on the same pulse that already runs here.
  // A single statement via .run() (not .batch()) — cheaper, and keeps this from ever appearing in
  // the batch-dispatch path every existing rebuild test already exercises.
  try { await opReceiptSweepStatement(db, now).run() } catch (e) { console.error('[echo] op_receipts sweep failed:', e) }

  // Phase 16 Part D2: bound the serialized payload. A no-op in the common case.
  let finalThreads = threads
  if (rebuildMode !== 'off') {
    const { threads: trimmedThreads, trimmed } = trimProjectionToBudget(threads, LEVEE.projectionMaxBytes)
    finalThreads = trimmedThreads
    if (trimmed > 0) console.warn(`[levee] projection trimmed ${trimmed} voices to stay under ${LEVEE.projectionMaxBytes} bytes`)
  }

  // Version: use timestamp so it never collides across KV TTL expiry cycles
  const version = Date.now()

  // Guard against clobbering a newer projection. A slow rebuild with an
  // older D1 snapshot should not overwrite a newer one committed while we
  // were computing. Self-heals on the next rebuild trigger.
  const existing = await readProjectionCache(kv, surface)
  if (existing && existing.computed_at > now) {
    return
  }

  // Phase 18 Part B5: `surface` is additive and present ONLY for a non-default surface — the
  // default ocean's projection stays byte-identical to pre-Phase-18 (S6).
  let surfaceField: StateResponse['surface']
  if (surface !== DEFAULT_SURFACE) {
    const row = await db.prepare('SELECT id, name, invitation FROM surfaces WHERE id = ?').bind(surface).first<{ id: string; name: string; invitation: string }>()
    if (row) surfaceField = { slug: row.id, name: row.name, invitation: row.invitation }
  }

  await kv.put(projectionKey(surface), JSON.stringify({
    threads: finalThreads,
    computed_at: now,
    version,
    ...(surfaceField ? { surface: surfaceField } : {}),
  } satisfies StateResponse), { expirationTtl: STATE_CACHE_TTL_S })
}

export async function rebuildAtmosphere(db: D1Database, kv: KVNamespace, surface: string = DEFAULT_SURFACE): Promise<void> {
  const now = Date.now()
  const oneDayAgo = now - 86_400_000

  // Batch all queries — Phase 18 Part B3: every one gains `AND v.surface_id = ?` (no-op for the
  // default surface, since every pre-Phase-18 voice is 'vellum' via the migration's DEFAULT).
  const queries = [
    // 0: first voice created_at
    db.prepare('SELECT MIN(created_at) as first_at FROM voices WHERE is_hidden = FALSE AND surface_id = ?').bind(surface),
    // 1: total voices
    db.prepare('SELECT COUNT(*) as total FROM voices WHERE is_hidden = FALSE AND surface_id = ?').bind(surface),
    // 2: surface phrases (top woven)
    db.prepare(`
      SELECT v.id, v.text, v.language, v.weave_count, vf.family
      FROM voices v JOIN voice_families vf ON v.id = vf.voice_id
      WHERE vf.ordinal = 0 AND v.is_hidden = FALSE AND v.surface_id = ? AND v.weave_count > 0
      ORDER BY v.weave_count DESC LIMIT 5
    `).bind(surface),
  ]

  // Per-family queries: count + recent_24h + languages
  for (const family of FAMILIES) {
    queries.push(
      db.prepare(`
        SELECT COUNT(*) as cnt FROM voice_families vf
        JOIN voices v ON v.id = vf.voice_id
        WHERE vf.family = ? AND vf.ordinal = 0 AND v.is_hidden = FALSE AND v.surface_id = ?
      `).bind(family, surface),
      db.prepare(`
        SELECT COUNT(*) as cnt FROM voices v
        JOIN voice_families vf ON v.id = vf.voice_id
        WHERE vf.family = ? AND vf.ordinal = 0 AND v.is_hidden = FALSE AND v.surface_id = ?
          AND v.created_at > ?
      `).bind(family, surface, oneDayAgo),
      db.prepare(`
        SELECT v.language, COUNT(*) as cnt FROM voices v
        JOIN voice_families vf ON v.id = vf.voice_id
        WHERE vf.family = ? AND vf.ordinal = 0 AND v.is_hidden = FALSE AND v.surface_id = ?
        GROUP BY v.language ORDER BY cnt DESC LIMIT 5
      `).bind(family, surface),
    )
  }

  const [results, warmthMap] = await Promise.all([
    db.batch(queries),
    getWarmthMap(db, surface),
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
  const existing = await readAtmosphereCache(kv, surface)
  if (existing && existing.computed_at > now) {
    return
  }

  await kv.put(atmosphereKey(surface), JSON.stringify(atmosphere), { expirationTtl: ATMOSPHERE_CACHE_TTL_S })
}

async function rebuildWithLockAndDirty(
  kv: KVNamespace,
  lockKey: string,
  dirtyKey: string,
  rebuild: () => Promise<void>,
  debounce?: { readComputedAt: () => Promise<number | null>; mode: LeveeMode },
): Promise<'locked' | 'rebuilt' | 'rebuilt-twice' | 'debounced'> {
  // Phase 16 Part D1: debounce BEFORE the lock — a burst of writers inside REBUILD_MIN_INTERVAL_MS
  // all mark dirty and return without taking the lock at all, rather than serializing on it.
  if (debounce && debounce.mode !== 'off') {
    const computedAt = await debounce.readComputedAt()
    if (computedAt !== null && Date.now() - computedAt < LEVEE.rebuildMinIntervalMs) {
      // KNOWN: contention-acceptable — see PATTERNS_AND_GOTCHAS § Cache contention
      await kv.put(dirtyKey, '1', { expirationTtl: DIRTY_MARKER_TTL_S })
      return 'debounced'
    }
  }

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

// Post-review fix (item 7): a bound on the retry chain below. Without one, a real degenerate
// storm (a rebuild landing every ~rebuildMinIntervalMs forever) would keep rescheduling forever.
const MAX_DEBOUNCE_RETRIES = 5

/**
 * Phase 16 Part D1: when debounced, schedules exactly one delayed retry via ctx.waitUntil — N
 * debounced writers wake, one takes the lock, the rest re-mark (the existing dirty-marker
 * machinery already dedups this). Without the delayed retry the last write of a burst would sit
 * unprojected until the next stale read (up to 10 minutes later, handlers/state.ts).
 *
 * Post-review fix (item 7): the retry used to call itself with `ctx: undefined`, so if THAT retry
 * itself woke up still inside a fresh debounce window (e.g. another writer's rebuild had just
 * refreshed computed_at while this one slept), `result === 'debounced' && ctx` was false and no
 * further retry was ever scheduled — the dirty marker could then sit unprojected for up to the
 * full stale-read window. The retry now threads the real `ctx` through every level, bounded by
 * `attempt` (internal-only parameter; external callers never pass it) at `MAX_DEBOUNCE_RETRIES`.
 */
export async function rebuildStateProjectionIfNotLocked(
  db: D1Database, kv: KVNamespace, ctx?: ExecutionContext, rebuildMode: LeveeMode = 'off', attempt = 0,
  surface: string = DEFAULT_SURFACE, permanenceMode: LeveeMode = 'off',
): Promise<'locked' | 'rebuilt' | 'rebuilt-twice' | 'debounced'> {
  const result = await rebuildWithLockAndDirty(
    kv, stateLockKey(surface), stateDirtyKey(surface),
    () => rebuildStateProjection(db, kv, rebuildMode, surface, permanenceMode),
    { readComputedAt: async () => (await readProjectionCache(kv, surface))?.computed_at ?? null, mode: rebuildMode },
  )
  if (result === 'debounced' && ctx) {
    if (attempt < MAX_DEBOUNCE_RETRIES) {
      ctx.waitUntil(
        sleep(LEVEE.rebuildMinIntervalMs).then(async () => {
          const stillDirty = await kv.get(stateDirtyKey(surface))
          if (stillDirty) await rebuildStateProjectionIfNotLocked(db, kv, ctx, rebuildMode, attempt + 1, surface, permanenceMode)
        }).catch(e => console.error('[levee] debounced state retry failed:', e)),
      )
    } else {
      console.warn(`[levee] debounced state rebuild hit its retry cap (${MAX_DEBOUNCE_RETRIES}); leaving the dirty marker for the next read-triggered rebuild`)
    }
  }
  return result
}

export async function rebuildAtmosphereIfNotLocked(db: D1Database, kv: KVNamespace, surface: string = DEFAULT_SURFACE): Promise<'locked' | 'rebuilt' | 'rebuilt-twice' | 'debounced'> {
  return rebuildWithLockAndDirty(kv, atmosphereLockKey(surface), atmosphereDirtyKey(surface), () => rebuildAtmosphere(db, kv, surface))
}

export async function rebuildAll(db: D1Database, kv: KVNamespace, surface: string = DEFAULT_SURFACE, permanenceMode: LeveeMode = 'off'): Promise<void> {
  await Promise.all([
    rebuildStateProjection(db, kv, 'off', surface, permanenceMode),
    rebuildAtmosphere(db, kv, surface),
  ])
}
