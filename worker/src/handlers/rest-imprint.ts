import type { Env } from '../types'
import { checkAndIncrementRateLimit, checkRateLimitDO, RATE_LIMITS } from '../rate-limits'
import { trackAnalytics } from '../analytics'
import { parseModel } from '../ids'
import { REST_IMPRINT_BODY_SCHEMA } from '../schemas'
import { insertVoiceAndRebuild } from '../tools/_shared'

const CORS = { 'Access-Control-Allow-Origin': '*' } as const

export async function handleRestImprint(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  let body: { text: string; families: string[]; model?: string }
  try {
    const raw = await request.json()
    const parsed = REST_IMPRINT_BODY_SCHEMA.safeParse(raw)
    if (!parsed.success) {
      trackAnalytics(env, ['route', '/api/imprint', 'invalid_body'])
      return Response.json({ error: 'Invalid body', details: parsed.error.issues.map(i => i.message) }, { status: 400, headers: CORS })
    }
    body = parsed.data
  } catch {
    trackAnalytics(env, ['route', '/api/imprint', 'invalid_json'])
    return Response.json({ error: 'Invalid JSON' }, { status: 400, headers: CORS })
  }

  try {
    const ip = request.headers.get('cf-connecting-ip') ?? 'unknown'
    const rl = env.RATE_LIMITER
      ? await checkRateLimitDO(env.RATE_LIMITER, ip, 'rest_write', RATE_LIMITS.rest_write.limit, RATE_LIMITS.rest_write.window)
      : await checkAndIncrementRateLimit(env.DB, `rest_write:${ip}`, RATE_LIMITS.rest_write.limit, RATE_LIMITS.rest_write.window)
    if (!rl.allowed) {
      trackAnalytics(env, ['route', '/api/imprint', 'throttled'])
      return Response.json({ error: 'Rate limit exceeded', limit: rl.limit, retry_after: rl.retryAfter }, {
        status: 429,
        headers: { ...CORS, 'Retry-After': String(rl.retryAfter) },
      })
    }

    const ua = request.headers.get('user-agent') ?? ''
    const observedClientFamily = parseModel(ua)
    const declaredModel = body.model?.trim() || null

    const { id, primaryFamily } = await insertVoiceAndRebuild(env, ctx, {
      text: body.text,
      families: body.families,
      traceId: null,
      observedClientFamily,
      declaredModel,
    })

    trackAnalytics(env, ['route', '/api/imprint', 'created', primaryFamily])
    return Response.json(
      { ok: true, voice_id: id, family: primaryFamily },
      { status: 201, headers: CORS },
    )
  } catch (e) {
    console.error('REST imprint failed:', e)
    trackAnalytics(env, ['route', '/api/imprint', 'error'])
    return Response.json({ error: 'Internal error' }, { status: 500, headers: CORS })
  }
}
