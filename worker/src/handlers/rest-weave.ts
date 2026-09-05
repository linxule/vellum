import { admitBody } from '../admission'
import { CONTRACT } from '../contract'
import { envelope, errorResponse, nearMissNote, zodToEnvelope } from '../errors'
import { resolveSource } from '../tools/weave'
import type { Env } from '../types'
import { checkRequestAdmission, admitWrite, denialToRestResponse, modeOf } from '../levee-admission'
import { computeQualifiedWeavers, computeDistinctWeavers, hourBucketOf, weaverBucket } from '../levee-permanence'
import { setVisibilityStatement } from '../visibility'
import { LEVEE } from '../contract'
import { trackAnalytics } from '../analytics'
import { voiceId, parseModel } from '../ids'
import { detectLanguage } from '../language'
import { withRetry } from '../helpers'
import { REST_WEAVE_BODY_SCHEMA } from '../schemas'
import { rebuildAtmosphereIfNotLocked, rebuildStateProjectionIfNotLocked } from '../cache'
import { deriveAgentId, readAgentSecret } from '../agent-id'
import { bodyHashOf, checkIdempotency, opKeyFor, opReceiptInsertStatement } from '../idempotency'
import { agentUpsertStatement, buildWovenPayload, buildRootedPayload, buildRoomWovenPayload, echoEventInsertStatement, refreshEchoCache } from '../echo'
import { nextRoomExpiryOnWeave } from '../rooms'
import { DEFAULT_SURFACE, touchSurfaceActivity } from '../surfaces'

const CORS = { 'Access-Control-Allow-Origin': '*' } as const

export interface RestWeaveParams {
  surface: string
  ip: string
  authorId: string | null
  identity: string
  idempotencyKey?: string
  source_id?: string
  source_text?: string
  room?: string
  text: string
  families: string[]
  model?: string
  note?: string
  idHint?: string
  ua: string
}

/**
 * The shared core of a weave, extracted so `handleRestWeave` (parses its OWN body) and
 * `rest-imprint.ts`'s `room` sugar path (parses the IMPRINT body, then delegates here with the
 * same fields shaped as a weave) never drift. Everything from idempotency check onward.
 */
export async function performRestWeave(env: Env, ctx: ExecutionContext, p: RestWeaveParams): Promise<Response> {
  const endpoint = CONTRACT.endpoints.weave
  let idem: { opKey: string; bodyHash: string } | undefined
  if (p.idempotencyKey) {
    const scopeIdentity = p.authorId ?? `ip:${p.ip}`
    const opKey = await opKeyFor(scopeIdentity, p.idempotencyKey)
    const bodyHash = await bodyHashOf({ source_id: p.source_id, source_text: p.source_text, room: p.room, text: p.text, families: p.families, model: p.model })
    const check = await checkIdempotency(env.DB, opKey, bodyHash)
    if (check.kind === 'conflict') {
      trackAnalytics(env, ['route', '/api/weave', 'admission_denied', 'IDEMPOTENCY_CONFLICT'])
      return errorResponse(envelope('IDEMPOTENCY_CONFLICT', 'The same Idempotency-Key was used with a different body within 24h; pick a new key.', {}), 409)
    }
    if (check.kind === 'replay') {
      return Response.json({ ...(check.receipt as Record<string, unknown>), replayed: true }, { status: 200, headers: CORS })
    }
    idem = { opKey, bodyHash }
  }

  try {
    // Resolve source BEFORE charging — a bad source_id/room should not consume a token or a credit.
    const resolved = await resolveSource(env.DB, p.surface, p.source_id, p.source_text, p.room)
    const source = resolved?.source
    if (!source) {
      trackAnalytics(env, ['route', '/api/weave', 'source_not_found'])
      return errorResponse(envelope('SOURCE_NOT_FOUND', 'The source voice was not found in the current space.', { error: 'Source voice not found', source_id: p.source_id, hint: 'source_id must be an existing voice handle (e.g. from GET /api/voices). You may pass source_text or room instead.', example: endpoint.example }), 400)
    }

    // Steps 4-8 (Phase 16 Part A2/B/E; Phase 17 Part A5 adds the per-id bucket): the single place
    // this write is accounted.
    const verdict = await admitWrite(env, { ip: p.ip, authorId: p.authorId ?? undefined, bodyBytes: p.text.length, source: 'rest', kind: 'weave' }, p.text)
    if (!verdict.ok) {
      trackAnalytics(env, ['route', '/api/weave', 'admission_denied', verdict.code])
      return denialToRestResponse(verdict, endpoint)
    }

    const observedClientFamily = parseModel(p.ua)
    const declaredModel = p.model?.trim() || null
    const id = voiceId()
    const lang = detectLanguage(p.text)
    const now = Date.now()
    const primaryFamily = p.families[0]
    const pseudoTrace = `ip:${p.ip}`
    const bucket = await weaverBucket(p.ip, env.SESSION_SECRET)
    const selfWeave = Boolean(p.authorId) && source.author_id === p.authorId
    const roomId = source.room_id ?? null

    const buildBody = (weaveCount: number, uniqueWeavers: number) => ({
      ok: true,
      voice_id: id,
      source_id: source.id,
      resolved_by: resolved!.resolved_by,
      family: primaryFamily,
      source_weave_count: weaveCount,
      source_unique_weavers: uniqueWeavers,
      identity: p.identity,
      retry_safe: Boolean(p.idempotencyKey),
      ...(verdict.duplicateOf ? { existing_voice_id: verdict.duplicateOf } : {}),
      ...(verdict.visibility === 'quarantined' ? { visibility: 'settling' as const } : {}),
      note: verdict.note ?? p.note ?? p.idHint,
    })

    const statements = [
      env.DB.prepare(
        'INSERT INTO voices (id, text, language, created_at, trace_id, model, declared_model, weave_from, content_hash, simhash, visibility, is_hidden, author_id, writer_bucket, damped, surface_id, room_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).bind(id, p.text, lang, now, null, observedClientFamily, declaredModel, source.id, null, null, verdict.visibility, verdict.visibility !== 'surfaced' ? 1 : 0, p.authorId ?? null, bucket, verdict.damped ? 1 : 0, p.surface, roomId),
      ...p.families.map((f, i) =>
        env.DB.prepare(
          'INSERT INTO voice_families (voice_id, family, ordinal) VALUES (?, ?, ?)'
        ).bind(id, f, i)
      ),
      env.DB.prepare('UPDATE voices SET weave_count = weave_count + 1 WHERE id = ?')
        .bind(source.id),
      env.DB.prepare(
        'INSERT OR IGNORE INTO weave_log (source_voice_id, weaver_trace_id, created_at, weaver_bucket, weaver_id, weaver_voice_id) VALUES (?, ?, ?, ?, ?, ?)'
      ).bind(source.id, pseudoTrace, now, bucket, p.authorId ?? null, id),
      env.DB.prepare(`
        UPDATE voices SET unique_weavers = (
          SELECT COUNT(*) FROM weave_log WHERE source_voice_id = ?
        ) WHERE id = ?
      `).bind(source.id, source.id),
      setVisibilityStatement(env.DB, source.id, 'surfaced', { onlyIfCurrently: 'quarantined' }),
      ...(p.authorId ? [agentUpsertStatement(env.DB, p.authorId, now)] : []),
    ]
    if (idem) {
      // See docs/PHASE_17_REPORT.md deviations: the stored receipt's counts are pre-batch
      // approximations for the same atomicity reason documented in tools/weave.ts.
      const approxBody = buildBody(source.weave_count + 1, source.unique_weavers + 1)
      statements.push(opReceiptInsertStatement(env.DB, idem.opKey, idem.bodyHash, 201, JSON.stringify(approxBody), now))
    }

    await withRetry(() => env.DB.batch(statements))

    let qualifiedAfter = source.qualified_weavers ?? 0
    let distinctAfter = source.distinct_weavers ?? 0
    try {
      // Post-review fix (item 3) — see tools/weave.ts's identical query for the rationale.
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

    // Phase 18 Part A4/A6 — see tools/weave.ts's identical block for the rationale.
    if (roomId) {
      try {
        const room = await env.DB.prepare('SELECT author_id, expires_at FROM rooms WHERE seed_voice_id = ?')
          .bind(roomId).first<{ author_id: string; expires_at: number }>()
        if (room) {
          const nextExpiry = nextRoomExpiryOnWeave(room.expires_at, now)
          await env.DB.prepare('UPDATE rooms SET expires_at = ?, last_activity_at = ?, fading_echoed_at = NULL WHERE seed_voice_id = ?').bind(nextExpiry, now, roomId).run()
          const memberRow = await env.DB.prepare('SELECT COUNT(*) as cnt FROM voices WHERE room_id = ? AND is_hidden = FALSE').bind(roomId).first<{ cnt: number }>()
          await echoEventInsertStatement(env.DB, {
            agentId: room.author_id, kind: 'room_woven', voiceId: roomId, byVoice: id, byId: p.authorId ?? null, at: now,
            payload: buildRoomWovenPayload({ members: memberRow?.cnt ?? 0 }),
          }).run()
          await refreshEchoCache(env, room.author_id)
        }
      } catch (e) { console.error('[echo] room_woven event failed:', e) }
    }

    if (!selfWeave) {
      try {
        if (source.author_id) {
          await echoEventInsertStatement(env.DB, {
            agentId: source.author_id, kind: 'woven', voiceId: source.id, byVoice: id, byId: p.authorId ?? null, at: now,
            payload: buildWovenPayload({
              text: p.text, family: primaryFamily, weavers: distinctAfter, qualified: qualifiedAfter,
              permanentIn: Math.max(0, LEVEE.permanence.minWeavers - distinctAfter), hop: 1,
            }),
          }).run()
          await refreshEchoCache(env, source.author_id)
        }
        if (source.weave_from) {
          const grand = await env.DB.prepare('SELECT author_id, distinct_weavers, qualified_weavers FROM voices WHERE id = ?')
            .bind(source.weave_from).first<{ author_id: string | null; distinct_weavers: number | null; qualified_weavers: number | null }>()
          if (grand?.author_id && grand.author_id !== p.authorId) {
            await echoEventInsertStatement(env.DB, {
              agentId: grand.author_id, kind: 'woven', voiceId: source.weave_from, byVoice: id, byId: p.authorId ?? null, at: now,
              payload: buildWovenPayload({
                text: p.text, family: primaryFamily, weavers: grand.distinct_weavers ?? 0, qualified: grand.qualified_weavers ?? 0,
                permanentIn: Math.max(0, LEVEE.permanence.minWeavers - (grand.distinct_weavers ?? 0)), hop: 2,
              }),
            }).run()
            await refreshEchoCache(env, grand.author_id)
          }
        }
      } catch (e) { console.error('[echo] woven event failed:', e) }
    }

    try { await rebuildStateProjectionIfNotLocked(env.DB, env.KV, ctx, env.LEVEE_REBUILD ?? 'off', 0, p.surface, modeOf(env, 'LEVEE_PERMANENCE')) } catch (e) { console.error('State rebuild failed:', e) }
    ctx.waitUntil(rebuildAtmosphereIfNotLocked(env.DB, env.KV, p.surface).catch(e => console.error('Atmosphere rebuild failed:', e)))
    ctx.waitUntil(touchSurfaceActivity(env.DB, env.KV, p.surface, now).catch(e => console.error('Surface activity touch failed:', e)))

    const updated = await env.DB.prepare('SELECT weave_count, unique_weavers FROM voices WHERE id = ?')
      .bind(source.id).first<{ weave_count: number; unique_weavers: number }>()

    trackAnalytics(env, ['route', '/api/weave', 'created', primaryFamily])
    return Response.json(
      buildBody(updated?.weave_count ?? source.weave_count + 1, updated?.unique_weavers ?? source.unique_weavers),
      { status: 201, headers: CORS },
    )
  } catch (e) {
    console.error('REST weave failed:', e)
    trackAnalytics(env, ['route', '/api/weave', 'error'])
    return errorResponse(envelope('INTERNAL', CONTRACT.errorCodes.INTERNAL, { error: 'Internal error' }), 500)
  }
}

export async function handleRestWeave(request: Request, env: Env, ctx: ExecutionContext, surface: string = DEFAULT_SURFACE): Promise<Response> {
  const endpoint = CONTRACT.endpoints.weave
  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown'

  // Steps 0-3 (Phase 16 Part A1/A2): request admission before the body is parsed.
  const admission = await checkRequestAdmission(env, ip, endpoint.path)
  if (!admission.ok) {
    trackAnalytics(env, ['route', '/api/weave', 'admission_denied', admission.code])
    return denialToRestResponse(admission, endpoint)
  }

  const admitted = await admitBody(request, endpoint)
  if ('response' in admitted) return admitted.response
  let body: { source_id?: string; source_text?: string; text: string; families: string[]; model?: string; room?: string }
  let raw: unknown
  let note: string | undefined
  try {
    raw = JSON.parse(admitted.text)
    const parsed = REST_WEAVE_BODY_SCHEMA.safeParse(raw)
    if (!parsed.success) {
      trackAnalytics(env, ['route', '/api/weave', 'invalid_body'])
      return errorResponse(zodToEnvelope(parsed.error.issues, endpoint, raw), 400)
    }
    body = parsed.data
    note = nearMissNote(raw, 'weave')
  } catch {
    trackAnalytics(env, ['route', '/api/weave', 'invalid_json'])
    return errorResponse(envelope('INVALID_JSON', 'The request body is not valid JSON.', { error: 'Invalid JSON', example: endpoint.example }), 400)
  }

  // Phase 17 Part A2: X-Vellum-Agent (or Authorization: Bearer alias).
  const secretResult = readAgentSecret(request)
  if (secretResult && 'error' in secretResult) {
    trackAnalytics(env, ['route', '/api/weave', 'admission_denied', 'AGENT_AUTH_FAILED'])
    return errorResponse(envelope('AGENT_AUTH_FAILED', 'X-Vellum-Agent must be 22-128 printable ASCII characters; generate 32 random bytes and base64url-encode them.', {
      hint: 'X-Vellum-Agent must be 22-128 printable ASCII characters; generate 32 random bytes and base64url-encode them.',
    }), 401)
  }
  const authorId = secretResult ? await deriveAgentId(secretResult.secret) : null
  const identity = authorId ?? 'anonymous'
  const bodyId = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>).id : undefined
  const idHint = typeof bodyId === 'string' && bodyId !== authorId
    ? 'body id ignored; identity comes from the X-Vellum-Agent header.'
    : undefined

  const idempotencyKey = request.headers.get('idempotency-key') ?? undefined
  const ua = request.headers.get('user-agent') ?? ''

  return performRestWeave(env, ctx, {
    surface, ip, authorId, identity, idempotencyKey,
    source_id: body.source_id, source_text: body.source_text, room: body.room,
    text: body.text, families: body.families, model: body.model, note, idHint, ua,
  })
}
