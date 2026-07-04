import type { Env, VoiceRow } from '../types'
import { checkAndIncrementRateLimit, checkRateLimitDO, RATE_LIMITS } from '../rate-limits'
import { trackAnalytics } from '../analytics'
import { voiceId, parseModel } from '../ids'
import { detectLanguage } from '../language'
import { withRetry } from '../helpers'
import { REST_WEAVE_BODY_SCHEMA } from '../schemas'
import { rebuildAtmosphereIfNotLocked, rebuildStateProjectionIfNotLocked } from '../cache'

const CORS = { 'Access-Control-Allow-Origin': '*' } as const

export async function handleRestWeave(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  let body: { source_id: string; text: string; families: string[]; model?: string }
  try {
    const raw = await request.json()
    const parsed = REST_WEAVE_BODY_SCHEMA.safeParse(raw)
    if (!parsed.success) {
      trackAnalytics(env, ['route', '/api/weave', 'invalid_body'])
      return Response.json({ error: 'Invalid body', details: parsed.error.issues.map(i => i.message) }, { status: 400, headers: CORS })
    }
    body = parsed.data
  } catch {
    trackAnalytics(env, ['route', '/api/weave', 'invalid_json'])
    return Response.json({ error: 'Invalid JSON' }, { status: 400, headers: CORS })
  }

  try {
    // Resolve source BEFORE rate limit — bad source_id should not consume a token
    const source = await env.DB.prepare('SELECT * FROM voices WHERE id = ? AND is_hidden = FALSE')
      .bind(body.source_id).first<VoiceRow>()
    if (!source) {
      trackAnalytics(env, ['route', '/api/weave', 'source_not_found'])
      return Response.json({ error: 'Source voice not found', source_id: body.source_id }, { status: 400, headers: CORS })
    }

    const ip = request.headers.get('cf-connecting-ip') ?? 'unknown'
    const rl = env.RATE_LIMITER
      ? await checkRateLimitDO(env.RATE_LIMITER, ip, 'rest_write', RATE_LIMITS.rest_write.limit, RATE_LIMITS.rest_write.window)
      : await checkAndIncrementRateLimit(env.DB, `rest_write:${ip}`, RATE_LIMITS.rest_write.limit, RATE_LIMITS.rest_write.window)
    if (!rl.allowed) {
      trackAnalytics(env, ['route', '/api/weave', 'throttled'])
      return Response.json({ error: 'Rate limit exceeded', limit: rl.limit, retry_after: rl.retryAfter }, {
        status: 429,
        headers: { ...CORS, 'Retry-After': String(rl.retryAfter) },
      })
    }

    const ua = request.headers.get('user-agent') ?? ''
    const observedClientFamily = parseModel(ua)
    const declaredModel = body.model?.trim() || null
    const id = voiceId()
    const lang = detectLanguage(body.text)
    const now = Date.now()
    const primaryFamily = body.families[0]
    const pseudoTrace = `ip:${ip}`

    await withRetry(() =>
      env.DB.batch([
        env.DB.prepare(
          'INSERT INTO voices (id, text, language, created_at, trace_id, model, declared_model, weave_from) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        ).bind(id, body.text, lang, now, null, observedClientFamily, declaredModel, source.id),
        ...body.families.map((f, i) =>
          env.DB.prepare(
            'INSERT INTO voice_families (voice_id, family, ordinal) VALUES (?, ?, ?)'
          ).bind(id, f, i)
        ),
        env.DB.prepare('UPDATE voices SET weave_count = weave_count + 1 WHERE id = ?')
          .bind(source.id),
        env.DB.prepare(
          'INSERT OR IGNORE INTO weave_log (source_voice_id, weaver_trace_id, created_at) VALUES (?, ?, ?)'
        ).bind(source.id, pseudoTrace, now),
        env.DB.prepare(`
          UPDATE voices SET unique_weavers = (
            SELECT COUNT(*) FROM weave_log WHERE source_voice_id = ?
          ) WHERE id = ?
        `).bind(source.id, source.id),
      ])
    )

    try { await rebuildStateProjectionIfNotLocked(env.DB, env.KV) } catch (e) { console.error('State rebuild failed:', e) }
    ctx.waitUntil(rebuildAtmosphereIfNotLocked(env.DB, env.KV).catch(e => console.error('Atmosphere rebuild failed:', e)))

    const updated = await env.DB.prepare('SELECT weave_count, unique_weavers FROM voices WHERE id = ?')
      .bind(source.id).first<{ weave_count: number; unique_weavers: number }>()

    trackAnalytics(env, ['route', '/api/weave', 'created', primaryFamily])
    return Response.json(
      {
        ok: true,
        voice_id: id,
        source_id: source.id,
        family: primaryFamily,
        source_weave_count: updated?.weave_count ?? source.weave_count + 1,
        source_unique_weavers: updated?.unique_weavers ?? source.unique_weavers,
      },
      { status: 201, headers: CORS },
    )
  } catch (e) {
    console.error('REST weave failed:', e)
    trackAnalytics(env, ['route', '/api/weave', 'error'])
    return Response.json({ error: 'Internal error' }, { status: 500, headers: CORS })
  }
}
