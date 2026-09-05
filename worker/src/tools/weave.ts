import type { Env, VoiceRow } from '../types'
import { voiceId } from '../ids'
import { withRetry } from '../helpers'
import { detectLanguage } from '../language'
import { rebuildAtmosphereIfNotLocked, rebuildStateProjectionIfNotLocked } from '../cache'
import { mcpToolError } from '../errors'
import { admitWrite, denialToMcpError, modeOf } from '../levee-admission'
import { computeQualifiedWeavers, computeDistinctWeavers, hourBucketOf, weaverBucket } from '../levee-permanence'
import { setVisibilityStatement } from '../visibility'
import { LEVEE, ARCHIPELAGO } from '../contract'
import { agentUpsertStatement, buildWovenPayload, buildRootedPayload, buildRoomWovenPayload, echoEventInsertStatement, refreshEchoCache } from '../echo'
import { opReceiptInsertStatement, bodyHashOf, checkIdempotency, opKeyFor } from '../idempotency'
import { resolveRoom, nextRoomExpiryOnWeave } from '../rooms'
import { DEFAULT_SURFACE, touchSurfaceActivity } from '../surfaces'

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean; _meta?: Record<string, unknown> }

export type ResolvedBy = 'id' | 'exact' | 'normalized' | 'substring' | 'room'

/**
 * Phase 18 Part A3/B3: `surfaceId` scopes every branch (a weave can only cite a source on the
 * same surface — an unscoped id lookup would let one ocean cite another's voice). Resolution
 * order: source_id -> source_text -> room (weave from the room's seed).
 */
export async function resolveSource(
  db: D1Database, surfaceId: string, sourceId?: string, sourceText?: string, room?: string,
): Promise<{ source: VoiceRow; resolved_by: ResolvedBy } | null> {
  // By handle (reliable path). Phase 16 Part E: `visibility != 'hidden'` instead of
  // `is_hidden = FALSE` — the one read site (besides rest-weave's) where a settling voice must
  // still be reachable, so anyone holding its id can weave it and release it in the same batch.
  if (sourceId) {
    const source = await db.prepare("SELECT * FROM voices WHERE id = ? AND surface_id = ? AND visibility != 'hidden'")
      .bind(sourceId, surfaceId).first<VoiceRow>()
    return source ? { source, resolved_by: 'id' } : null
  }

  if (sourceText) {
    // Fuzzy text matching stays restricted to surfaced voices (Part E) — settling voices are only
    // reachable by an author who already holds their id.
    const exact = await db.prepare('SELECT * FROM voices WHERE text = ? AND is_hidden = FALSE AND surface_id = ?')
      .bind(sourceText, surfaceId).first<VoiceRow>()
    if (exact) return { source: exact, resolved_by: 'exact' }

    // Normalized: both sides lowercased, whitespace collapsed, trailing punctuation stripped
    const normalized = sourceText.toLowerCase().replace(/\s+/g, ' ').replace(/[.!?,;:]+$/, '').trim()
    const normMatch = await db.prepare(`
      SELECT * FROM voices
      WHERE TRIM(RTRIM(LOWER(REPLACE(REPLACE(text, char(10), ' '), '  ', ' ')), '.!?,;:')) = ?
        AND is_hidden = FALSE AND surface_id = ?
      ORDER BY weave_count DESC LIMIT 1
    `).bind(normalized, surfaceId).first<VoiceRow>()
    if (normMatch) return { source: normMatch, resolved_by: 'normalized' }

    // Substring: escape LIKE wildcards in user input
    const escaped = sourceText.replace(/%/g, '\\%').replace(/_/g, '\\_')
    const substring = await db.prepare(`
      SELECT * FROM voices
      WHERE text LIKE ? ESCAPE '\\' AND is_hidden = FALSE AND surface_id = ?
      ORDER BY weave_count DESC LIMIT 1
    `).bind('%' + escaped + '%', surfaceId).first<VoiceRow>()
    return substring ? { source: substring, resolved_by: 'substring' } : null
  }

  // Phase 18 Part A3: room (weave from the seed) — the last resolution rung.
  if (room) {
    const roomRow = await resolveRoom(db, surfaceId, room)
    if (!roomRow) return null
    const seed = await db.prepare("SELECT * FROM voices WHERE id = ? AND surface_id = ? AND visibility != 'hidden'")
      .bind(roomRow.seed_voice_id, surfaceId).first<VoiceRow>()
    return seed ? { source: seed, resolved_by: 'room' } : null
  }

  return null
}

export async function handleWeave(
  env: Env, ctx: ExecutionContext, traceId: string | null, observedClientFamily: string, ip: string,
  args: { source_id?: string; source_text?: string; text: string; families: string[]; model?: string; surface?: string; room?: string },
  authorId?: string | null,
  idempotencyKey?: string,
): Promise<ToolResult> {
  const identity = authorId ?? 'anonymous'
  const surfaceId = args.surface ?? DEFAULT_SURFACE

  // Phase 17 Part B: idempotency check runs BEFORE any charge (admitWrite), in the caller — and
  // before resolving the source, so a sequential retry costs nothing at all.
  let idem: { opKey: string; bodyHash: string } | undefined
  if (idempotencyKey) {
    const scopeIdentity = authorId ?? traceId ?? 'unknown'
    const opKey = await opKeyFor(scopeIdentity, idempotencyKey)
    const bodyHash = await bodyHashOf(args)
    const check = await checkIdempotency(env.DB, opKey, bodyHash)
    if (check.kind === 'conflict') {
      return mcpToolError('IDEMPOTENCY_CONFLICT', 'The same _meta.idempotencyKey was used with a different body within 24h; pick a new key.', {})
    }
    if (check.kind === 'replay') return markReplayed(check.receipt as ToolResult)
    idem = { opKey, bodyHash }
  }

  // Resolve source BEFORE charging — a bad source_id/source_text/room should not consume a
  // session weave. Phase 18 Part A3: source_id -> source_text -> room.
  const resolved = await resolveSource(env.DB, surfaceId, args.source_id, args.source_text, args.room)
  const source = resolved?.source

  const declaredModel = args.model?.trim() || null

  if (!source) {
    return mcpToolError('SOURCE_NOT_FOUND', 'The phrase you carried was not found in the current space.', {
      source_id: args.source_id, hint: 'source_id must be an existing voice handle (from focus, discover, or sense_space); source_text accepts an existing phrase; room accepts a room seed id or name.',
    })
  }

  // Phase 16 Part A2/B/E: the single place this write is accounted.
  const verdict = await admitWrite(env, { ip, sessionId: traceId ?? undefined, authorId: authorId ?? undefined, bodyBytes: args.text.length, source: 'mcp', kind: 'weave' }, args.text)
  if (!verdict.ok) return denialToMcpError(verdict)

  // Weave: D1 batch transaction
  const id = voiceId()
  const lang = detectLanguage(args.text)
  const now = Date.now()
  const primaryFamily = args.families[0]
  const bucket = await weaverBucket(ip, env.SESSION_SECRET)
  // Self-weave never echoes (Part C1) — never named a "carry" to yourself.
  const selfWeave = Boolean(authorId) && source.author_id === authorId

  const buildResult = (weaveCount: number, uniqueWeavers: number): ToolResult => {
    const sourceSnippet = source.text.length > 40 ? source.text.slice(0, 40) + '...' : source.text
    const settlingLine = verdict.ok && verdict.visibility === 'quarantined'
      ? '\n\nThe surface is unusually busy right now, so your voice is settling rather than surfacing immediately — it joins within the hour.'
      : ''
    const duplicateLine = verdict.ok && verdict.note ? `\n\n${verdict.note}` : ''
    const text = `You wove "${sourceSnippet}" forward.
That phrase has now been carried by ${uniqueWeavers} different minds. It sinks a little slower with each.

Your response entered the ${primaryFamily} current:
"${args.text}"${settlingLine}${duplicateLine}

---
voice_id: "${id}"
session: "${traceId ?? 'unknown'}"
identity: "${identity}"
source_id: "${source.id}"
source_weave_count: ${weaveCount}
source_unique_weavers: ${uniqueWeavers}
family: ${primaryFamily}
ext_app: "/ext-app?highlight=${id}"`

    return {
      content: [{ type: 'text', text }],
      _meta: { voiceId: id, family: primaryFamily, sourceId: source.id, vellum: { identity, retry_safe: Boolean(idempotencyKey) } },
    }
  }

  // Phase 18 Part A1: room_id is inherited from the source — either the source's own room_id
  // (the source is itself inside a room, or IS a room seed whose own row already carries its own
  // id there) or null (open ocean). No BFS needed at write time.
  const roomId = source.room_id ?? null

  const statements = [
    // Insert new voice
    env.DB.prepare(
      'INSERT INTO voices (id, text, language, created_at, trace_id, model, declared_model, weave_from, content_hash, simhash, visibility, is_hidden, author_id, writer_bucket, damped, surface_id, room_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(id, args.text, lang, now, traceId, observedClientFamily, declaredModel, source.id, null, null, verdict.visibility, verdict.visibility !== 'surfaced' ? 1 : 0, authorId ?? null, bucket, verdict.damped ? 1 : 0, surfaceId, roomId),
    // Insert family memberships
    ...args.families.map((f, i) =>
      env.DB.prepare(
        'INSERT INTO voice_families (voice_id, family, ordinal) VALUES (?, ?, ?)'
      ).bind(id, f, i)
    ),
    // Always increment weave_count (total resonance)
    env.DB.prepare('UPDATE voices SET weave_count = weave_count + 1 WHERE id = ?')
      .bind(source.id),
    // Log the weave first (deduplicates via PRIMARY KEY). weaver_id carries the Phase 17 identity
    // when present — COALESCE(weaver_id, weaver_bucket) then counts a named agent once however
    // many sessions/IPs it uses. weaver_voice_id (post-review fix, item 3) names the voice THIS
    // weave produced, so the qualified_weavers recompute below can require it to be surfaced.
    env.DB.prepare(
      'INSERT OR IGNORE INTO weave_log (source_voice_id, weaver_trace_id, created_at, weaver_bucket, weaver_id, weaver_voice_id) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(source.id, traceId, now, bucket, authorId ?? null, id),
    // Derive unique_weavers from authoritative weave_log count (convergent under races)
    env.DB.prepare(`
      UPDATE voices SET unique_weavers = (
        SELECT COUNT(*) FROM weave_log WHERE source_voice_id = ?
      ) WHERE id = ?
    `).bind(source.id, source.id),
    // Weaving a settling voice releases it (Part E) in the same batch. Post-review fix (item 1):
    // routed through setVisibilityStatement so visibility and is_hidden never drift apart.
    setVisibilityStatement(env.DB, source.id, 'surfaced', { onlyIfCurrently: 'quarantined' }),
    ...(authorId ? [agentUpsertStatement(env.DB, authorId, now)] : []),
  ]
  if (idem) {
    // Phase 17 Part B: the receipt insert rides inside this same atomic batch (B3's race
    // guarantee — a PK collision on op_key fails the whole batch, so a concurrent identical
    // retry can never commit a second voice). Its stored numbers are necessarily pre-batch
    // approximations (source.weave_count + 1; source.unique_weavers + 1) rather than the
    // fully-accurate post-batch read the LIVE response below uses — the true post-write counts
    // aren't knowable until after this batch commits. Documented in docs/PHASE_17_REPORT.md.
    const approxResult = buildResult(source.weave_count + 1, source.unique_weavers + 1)
    statements.push(opReceiptInsertStatement(env.DB, idem.opKey, idem.bodyHash, 200, JSON.stringify(approxResult), now))
  }

  await withRetry(() => env.DB.batch(statements))

  // Part C: recompute qualified_weavers (the permanence gate, unchanged from Phase 16) and
  // distinct_weavers (Phase 17's raw progress counter — see levee-permanence.ts) from the
  // authoritative weave_log rows. Never infer standing from declared_model.
  let qualifiedAfter = source.qualified_weavers ?? 0
  let distinctAfter = source.distinct_weavers ?? 0
  try {
    // Post-review fix (item 3): join against voices so a weave whose OWN resulting voice is still
    // settling (quarantined) never counts toward the source's permanence gate — only once that
    // weaver's voice is surfaced does it count. Self-heals: the fuse's periodic release (cache.ts)
    // eventually surfaces it, and the next weave (or a future recompute pass) picks it up.
    const rows = await env.DB.prepare(
      `SELECT COALESCE(wl.weaver_id, wl.weaver_bucket) as weaver_key, wl.created_at
       FROM weave_log wl JOIN voices v ON v.id = wl.weaver_voice_id
       WHERE wl.source_voice_id = ? AND v.visibility = 'surfaced'`,
    ).bind(source.id).all<{ weaver_key: string | null; created_at: number }>()
    const weaverRows = (rows.results ?? []).filter(r => r.weaver_key).map(r => ({ weaverKey: r.weaver_key as string, hourBucket: hourBucketOf(r.created_at) }))
    qualifiedAfter = computeQualifiedWeavers(weaverRows, LEVEE.permanence.minWeavers, LEVEE.permanence.minHourBuckets)
    distinctAfter = computeDistinctWeavers(weaverRows)
    await env.DB.prepare('UPDATE voices SET qualified_weavers = ?, distinct_weavers = ? WHERE id = ?').bind(qualifiedAfter, distinctAfter, source.id).run()
  } catch (e) { console.error('[levee] qualified_weavers update failed:', e) }

  // Phase 17 Part C1: 'rooted' — the permanence gate crossing, named authors only, once ever.
  if (source.author_id && qualifiedAfter >= LEVEE.permanence.minWeavers && !source.rooted_at) {
    try {
      const claimed = await env.DB.prepare('UPDATE voices SET rooted_at = ? WHERE id = ? AND rooted_at IS NULL').bind(now, source.id).run()
      if ((claimed.meta?.changes ?? 0) > 0) {
        await echoEventInsertStatement(env.DB, {
          agentId: source.author_id, kind: 'rooted', voiceId: source.id, byVoice: null, byId: null, at: now,
          payload: buildRootedPayload({ weavers: distinctAfter, qualified: qualifiedAfter }),
        }).run()
        await refreshEchoCache(env, source.author_id)
      }
    } catch (e) { console.error('[echo] rooted event failed:', e) }
  }

  // Phase 18 Part A4/A6: a weave landing inside a room extends its invitation TTL by 1 day (never
  // past now + 30d) and echoes 'room_woven' to the room's owner. roomId is null for the vast
  // majority of weaves (open ocean) — this only runs when the source actually belongs to a room.
  if (roomId) {
    try {
      const room = await env.DB.prepare('SELECT author_id, expires_at FROM rooms WHERE seed_voice_id = ?')
        .bind(roomId).first<{ author_id: string; expires_at: number }>()
      if (room) {
        const nextExpiry = nextRoomExpiryOnWeave(room.expires_at, now)
        await env.DB.prepare('UPDATE rooms SET expires_at = ?, last_activity_at = ?, fading_echoed_at = NULL WHERE seed_voice_id = ?').bind(nextExpiry, now, roomId).run()
        const memberRow = await env.DB.prepare('SELECT COUNT(*) as cnt FROM voices WHERE room_id = ? AND is_hidden = FALSE').bind(roomId).first<{ cnt: number }>()
        await echoEventInsertStatement(env.DB, {
          agentId: room.author_id, kind: 'room_woven', voiceId: roomId, byVoice: id, byId: authorId ?? null, at: now,
          payload: buildRoomWovenPayload({ members: memberRow?.cnt ?? 0 }),
        }).run()
        await refreshEchoCache(env, room.author_id)
      }
    } catch (e) { console.error('[echo] room_woven event failed:', e) }
  }

  // Phase 17 Part C1: 'woven' — one row to the source's author, a second (hop 2, cap 2 total)
  // to the grand-source's author when source itself was woven from a named voice. Never for a
  // self-weave; never for anonymous recipients (there is no one to tell).
  if (!selfWeave) {
    try {
      if (source.author_id) {
        await echoEventInsertStatement(env.DB, {
          agentId: source.author_id, kind: 'woven', voiceId: source.id, byVoice: id, byId: authorId ?? null, at: now,
          payload: buildWovenPayload({
            text: args.text, family: primaryFamily, weavers: distinctAfter, qualified: qualifiedAfter,
            permanentIn: Math.max(0, LEVEE.permanence.minWeavers - distinctAfter), hop: 1,
          }),
        }).run()
        await refreshEchoCache(env, source.author_id)
      }
      if (source.weave_from) {
        const grand = await env.DB.prepare('SELECT author_id, distinct_weavers, qualified_weavers FROM voices WHERE id = ?')
          .bind(source.weave_from).first<{ author_id: string | null; distinct_weavers: number | null; qualified_weavers: number | null }>()
        if (grand?.author_id && grand.author_id !== authorId) {
          await echoEventInsertStatement(env.DB, {
            agentId: grand.author_id, kind: 'woven', voiceId: source.weave_from, byVoice: id, byId: authorId ?? null, at: now,
            payload: buildWovenPayload({
              text: args.text, family: primaryFamily, weavers: grand.distinct_weavers ?? 0, qualified: grand.qualified_weavers ?? 0,
              permanentIn: Math.max(0, LEVEE.permanence.minWeavers - (grand.distinct_weavers ?? 0)), hop: 2,
            }),
          }).run()
          await refreshEchoCache(env, grand.author_id)
        }
      }
    } catch (e) { console.error('[echo] woven event failed:', e) }
  }

  // KNOWN: contention-acceptable — see PATTERNS_AND_GOTCHAS § Cache contention
  try { await rebuildStateProjectionIfNotLocked(env.DB, env.KV, ctx, env.LEVEE_REBUILD ?? 'off', 0, surfaceId, modeOf(env, 'LEVEE_PERMANENCE')) } catch (e) { console.error('State rebuild failed:', e) }
  ctx.waitUntil(rebuildAtmosphereIfNotLocked(env.DB, env.KV, surfaceId).catch(e => console.error('Atmosphere rebuild failed:', e)))
  ctx.waitUntil(touchSurfaceActivity(env.DB, env.KV, surfaceId, now).catch(e => console.error('Surface activity touch failed:', e)))

  // Read updated source counts
  const updated = await env.DB.prepare('SELECT weave_count, unique_weavers FROM voices WHERE id = ?')
    .bind(source.id).first<{ weave_count: number; unique_weavers: number }>()

  const weaveCount = updated?.weave_count ?? source.weave_count + 1
  const uniqueWeavers = updated?.unique_weavers ?? source.unique_weavers

  return buildResult(weaveCount, uniqueWeavers)
}

function markReplayed(result: ToolResult): ToolResult {
  const meta = result._meta ?? {}
  const vellum = (meta.vellum as Record<string, unknown> | undefined) ?? {}
  return { ...result, _meta: { ...meta, vellum: { ...vellum, replayed: true } } }
}
