import { admitBody } from '../admission'
import { methodNotAllowed } from '../discovery'
import type { Env } from '../types'
import { readAtmosphereCache, readProjectionCache, rebuildAll } from '../cache'
import { getWarmthMap } from '../warmth'
import { constantTimeEqual } from '../hmac'
import { ADMIN_FUSE_BODY_SCHEMA, ADMIN_HIDE_BULK_BODY_SCHEMA, ADMIN_OVERLOAD_BODY_SCHEMA, ADMIN_QUARANTINE_RELEASE_BODY_SCHEMA, ADMIN_UNHIDE_BODY_SCHEMA, STATE_CACHE_STALE_MS } from '../schemas'
import { envelope, errorResponse } from '../errors'
import { setOverload, setFuseMode, modeOf } from '../levee-admission'
import { setVisibility } from '../visibility'
import { LEVEE } from '../contract'
import { DEFAULT_SURFACE } from '../surfaces'

function adminJsonError(code: 'UNAUTHORIZED' | 'VALIDATION', message: string, status: number): Response {
  const r = errorResponse(envelope(code, message, { error: message }), status)
  r.headers.delete('Access-Control-Allow-Origin') // admin routes carry no CORS
  return r
}

export async function handleAdmin(request: Request, env: Env, url: URL): Promise<Response> {
  const admitted = request.method === 'POST' ? await admitBody(request) : null
  if (admitted && 'response' in admitted) {
    admitted.response.headers.delete('Access-Control-Allow-Origin')
    return admitted.response
  }
  const key = request.headers.get('x-admin-key')
  if (!key || !constantTimeEqual(key, env.ADMIN_KEY)) {
    return adminJsonError('UNAUTHORIZED', 'The admin key is missing or wrong.', 401)
  }

  const path = url.pathname.replace('/api/admin/', '')

  const wrongMethod = methodNotAllowed(request)
  if (wrongMethod) {
    wrongMethod.headers.delete('Access-Control-Allow-Origin')
    return wrongMethod
  }

  if (path === 'stats' && request.method === 'GET') {
    const [totalRes, familyRes, recentRes, topWovenRes, warmthRows, projection, atmosphere, hourAll, minuteAll, attempts, settlingRes, dampedRes, mirrorMismatchRes] = await Promise.all([
      env.DB.prepare('SELECT COUNT(*) as cnt FROM voices WHERE is_hidden = FALSE').first<{ cnt: number }>(),
      env.DB.prepare(`
        SELECT vf.family, COUNT(*) as cnt
        FROM voice_families vf JOIN voices v ON v.id = vf.voice_id
        WHERE vf.ordinal = 0 AND v.is_hidden = FALSE
        GROUP BY vf.family
      `).all(),
      env.DB.prepare(`
        SELECT COUNT(*) as cnt FROM voices
        WHERE is_hidden = FALSE AND created_at > ?
      `).bind(Date.now() - 86_400_000).first<{ cnt: number }>(),
      env.DB.prepare(`
        SELECT id, text, weave_count FROM voices
        WHERE is_hidden = FALSE ORDER BY weave_count DESC LIMIT 10
      `).all(),
      // Phase 18: warmth_state's PRIMARY KEY became (surface_id, family) — admin stats stays
      // scoped to the default ocean, matching the rest of this route's global-infra scope.
      env.DB.prepare(`
        SELECT family, score, last_updated
        FROM warmth_state
        WHERE surface_id = 'vellum'
        ORDER BY family
      `).all(),
      readProjectionCache(env.KV),
      readAtmosphereCache(env.KV),
      env.DB.prepare('SELECT count FROM rate_limits WHERE key = ?').bind('levee:hour:all').first<{ count: number }>(),
      env.DB.prepare('SELECT count FROM rate_limits WHERE key = ?').bind('levee:minute:all').first<{ count: number }>(),
      env.DB.prepare('SELECT count FROM rate_limits WHERE key = ?').bind('levee:attempts:hour').first<{ count: number }>(),
      env.DB.prepare("SELECT COUNT(*) as cnt FROM voices WHERE visibility = 'quarantined'").first<{ cnt: number }>().catch(() => null),
      env.DB.prepare('SELECT COUNT(*) as cnt FROM voices WHERE damped = 1').first<{ cnt: number }>().catch(() => null),
      // is_hidden === (visibility != 'surfaced') invariant — should always read 0.
      env.DB.prepare("SELECT COUNT(*) as cnt FROM voices WHERE is_hidden != (visibility != 'surfaced')").first<{ cnt: number }>().catch(() => null),
    ])
    const warmth = await getWarmthMap(env.DB)
    const now = Date.now()
    const fuseEngagedRaw = await env.KV.get('levee:fuse:engaged')
    const overload = await env.KV.get<{ until: number; reason: string }>('levee:overload', 'json')
    const projectionBytes = projection ? new TextEncoder().encode(JSON.stringify(projection)).length : 0
    return Response.json({
      total_voices: totalRes?.cnt ?? 0,
      per_family: familyRes.results,
      recent_24h: recentRes?.cnt ?? 0,
      top_woven: topWovenRes.results,
      warmth_rows: (warmthRows.results ?? []).map(row => ({
        ...(row as Record<string, unknown>),
        current: warmth[(row as { family: string }).family] ?? 0,
      })),
      cache: {
        state_projection: {
          exists: Boolean(projection),
          computed_at: projection?.computed_at ?? null,
          age_ms: projection ? Math.max(0, now - projection.computed_at) : null,
          stale_after_ms: STATE_CACHE_STALE_MS,
        },
        atmosphere: {
          exists: Boolean(atmosphere),
          computed_at: atmosphere?.computed_at ?? null,
          age_ms: atmosphere ? Math.max(0, now - atmosphere.computed_at) : null,
        },
      },
      // Phase 16 "The Levee" — infrastructure observability. See docs/OBSERVABILITY.md.
      levee: {
        global_hour_count: hourAll?.count ?? 0,
        global_minute_count: minuteAll?.count ?? 0,
        write_attempts_hour: attempts?.count ?? 0,
        fuse_engaged: fuseEngagedRaw === '1',
        settling_count: settlingRes?.cnt ?? 0,
        damped_count: dampedRes?.cnt ?? 0,
        overload_until: overload && overload.until > now ? overload.until : null,
        projection_bytes: projectionBytes,
        visibility_mirror_mismatches: mirrorMismatchRes?.cnt ?? 0,
      },
      analytics: {
        dataset: 'vellum_usage',
        note: 'Route, cache, witness, and MCP tool events are written to Workers Analytics Engine for external daily-budget queries.',
      },
    })
  }

  if (path === 'hide' && request.method === 'POST') {
    let rawBody: unknown
    try {
      rawBody = JSON.parse(admitted && 'text' in admitted ? admitted.text : '')
    } catch {
      return adminJsonError('VALIDATION', 'The request body is not valid JSON.', 400)
    }
    // Single-key body {voice_id} stays valid on its own — it's also a one-selector bulk body.
    const bulk = ADMIN_HIDE_BULK_BODY_SCHEMA.safeParse(rawBody)
    if (!bulk.success) {
      return adminJsonError('VALIDATION', bulk.error.issues[0]?.message ?? 'voice_id, content_hash, or writer_bucket required.', 400)
    }
    let voiceIds: string[] = []
    if (bulk.data.content_hash) {
      const rows = await env.DB.prepare('SELECT id FROM voices WHERE content_hash = ? AND is_hidden = FALSE').bind(bulk.data.content_hash).all<{ id: string }>()
      voiceIds = (rows.results ?? []).map(r => r.id)
    } else if (bulk.data.writer_bucket) {
      // Post-review fix (item 2 closes the Phase 16 report's admitted gap here): voices now carry
      // writer_bucket (the author-side counterpart to weave_log.weaver_bucket), so this selector
      // hides voices the bucket actually AUTHORED, not merely voices it has woven.
      const rows = await env.DB.prepare('SELECT id FROM voices WHERE writer_bucket = ?').bind(bulk.data.writer_bucket).all<{ id: string }>()
      voiceIds = (rows.results ?? []).map(r => r.id)
    } else {
      voiceIds = [bulk.data.voice_id!]
    }
    if (voiceIds.length > 0) {
      // Post-review fix (item 1): routed through setVisibility so visibility is set to 'hidden'
      // alongside is_hidden — previously only is_hidden was written, so visibility stayed
      // 'surfaced' and resolveSource's `visibility != 'hidden'` check kept letting the voice
      // resolve by id. Sequential .run() calls (not .batch()) — see docs/PHASE_16_REPORT.md
      // deviation 8 for why (the test double's batch() path bypasses per-statement run()).
      for (const id of voiceIds) await setVisibility(env.DB, id, 'hidden')
      await rebuildAll(env.DB, env.KV, DEFAULT_SURFACE, modeOf(env, 'LEVEE_PERMANENCE'))
    }
    return Response.json({ ok: true, hidden_count: voiceIds.length, voice_ids: voiceIds })
  }

  if (path === 'unhide' && request.method === 'POST') {
    let rawBody: unknown
    try { rawBody = JSON.parse(admitted && 'text' in admitted ? admitted.text : '') } catch { return adminJsonError('VALIDATION', 'The request body is not valid JSON.', 400) }
    const parsed = ADMIN_UNHIDE_BODY_SCHEMA.safeParse(rawBody)
    if (!parsed.success) return adminJsonError('VALIDATION', 'voice_id required.', 400)
    await setVisibility(env.DB, parsed.data.voice_id, 'surfaced')
    await rebuildAll(env.DB, env.KV, DEFAULT_SURFACE, modeOf(env, 'LEVEE_PERMANENCE'))
    return Response.json({ ok: true, voice_id: parsed.data.voice_id })
  }

  if (path === 'quarantine' && request.method === 'GET') {
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 20))
    const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0)
    const rows = await env.DB.prepare(
      "SELECT id, text, created_at FROM voices WHERE visibility = 'quarantined' ORDER BY created_at DESC LIMIT ? OFFSET ?",
    ).bind(limit, offset).all()
    return Response.json({ voices: rows.results ?? [] })
  }

  if (path === 'quarantine/release' && request.method === 'POST') {
    let rawBody: unknown
    try { rawBody = JSON.parse(admitted && 'text' in admitted ? admitted.text : '') } catch { return adminJsonError('VALIDATION', 'The request body is not valid JSON.', 400) }
    const parsed = ADMIN_QUARANTINE_RELEASE_BODY_SCHEMA.safeParse(rawBody)
    if (!parsed.success) return adminJsonError('VALIDATION', 'voice_id required.', 400)
    await setVisibility(env.DB, parsed.data.voice_id, 'surfaced', { onlyIfCurrently: 'quarantined' })
    await rebuildAll(env.DB, env.KV, DEFAULT_SURFACE, modeOf(env, 'LEVEE_PERMANENCE'))
    return Response.json({ ok: true, voice_id: parsed.data.voice_id })
  }

  if (path === 'overload' && request.method === 'POST') {
    let rawBody: unknown
    try { rawBody = JSON.parse(admitted && 'text' in admitted ? admitted.text : '') } catch { return adminJsonError('VALIDATION', 'The request body is not valid JSON.', 400) }
    const parsed = ADMIN_OVERLOAD_BODY_SCHEMA.safeParse(rawBody)
    if (!parsed.success) return adminJsonError('VALIDATION', 'on (boolean) required; ttl_s optional.', 400)
    await setOverload(env.KV, parsed.data.on, parsed.data.ttl_s ?? LEVEE.overload.durationS, 'manual admin toggle')
    return Response.json({ ok: true, on: parsed.data.on })
  }

  // Post-review fix (item 6): toggles the dormant quarantine fuse without a deploy, mirroring the
  // overload route above.
  if (path === 'fuse' && request.method === 'POST') {
    let rawBody: unknown
    try { rawBody = JSON.parse(admitted && 'text' in admitted ? admitted.text : '') } catch { return adminJsonError('VALIDATION', 'The request body is not valid JSON.', 400) }
    const parsed = ADMIN_FUSE_BODY_SCHEMA.safeParse(rawBody)
    if (!parsed.success) return adminJsonError('VALIDATION', "mode must be one of 'off', 'shadow', 'on'.", 400)
    await setFuseMode(env.KV, parsed.data.mode)
    return Response.json({ ok: true, mode: parsed.data.mode })
  }

  if (path === 'recent' && request.method === 'GET') {
    const result = await env.DB.prepare(`
      SELECT v.id, v.text, v.language, v.trace_id, v.model, v.weave_count, v.created_at,
        GROUP_CONCAT(vf.family) as families
      FROM voices v
      LEFT JOIN voice_families vf ON v.id = vf.voice_id
      WHERE v.is_hidden = FALSE
      GROUP BY v.id
      ORDER BY v.created_at DESC LIMIT 50
    `).all()
    return Response.json(result.results)
  }

  return Response.json({ error: 'Not found' }, { status: 404 })
}
