import type { Env } from '../types'
import { FAMILIES } from '../types'
import { rebuildStateProjectionIfNotLocked } from '../cache'
import { checkAndIncrementRateLimit, checkRateLimitDO, RATE_LIMITS } from '../rate-limits'
import { updateWarmth } from '../warmth'
import { trackAnalytics } from '../analytics'
import { WITNESS_BODY_SCHEMA } from '../schemas'

export async function handleWitness(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  // Validate body first (before consuming rate limit quota)
  let body: { family?: string; families?: string[]; dwell_s?: number }
  try {
    const rawBody = await request.json()
    const parsed = WITNESS_BODY_SCHEMA.safeParse(rawBody)
    if (!parsed.success) {
      trackAnalytics(env, ['route', '/api/witness', 'invalid_body'])
      return Response.json({ error: 'Invalid witness event' }, { status: 400, headers: { 'Access-Control-Allow-Origin': '*' } })
    }
    body = parsed.data
  } catch {
    trackAnalytics(env, ['route', '/api/witness', 'invalid_json'])
    return Response.json({ error: 'Invalid JSON' }, { status: 400, headers: { 'Access-Control-Allow-Origin': '*' } })
  }
  const dwell = typeof body?.dwell_s === 'number' && Number.isFinite(body.dwell_s) ? body.dwell_s : 0
  const families = Array.isArray(body?.families)
    ? body.families
    : typeof body?.family === 'string'
      ? [body.family]
      : []
  if (families.length === 0 || dwell < 1) {
    trackAnalytics(env, ['route', '/api/witness', 'invalid_body'])
    return Response.json({ error: 'Invalid witness event' }, { status: 400, headers: { 'Access-Control-Allow-Origin': '*' } })
  }
  if (families.some(family => !FAMILIES.includes(family as typeof FAMILIES[number]))) {
    trackAnalytics(env, ['route', '/api/witness', 'invalid_family'])
    return Response.json({ error: 'Invalid family' }, { status: 400, headers: { 'Access-Control-Allow-Origin': '*' } })
  }
  const uniqueFamilies = Array.from(new Set(families))

  // Per-IP rate limit: 5 witness events per 60s.
  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown'
  const witnessLimit = env.RATE_LIMITER
    ? await checkRateLimitDO(env.RATE_LIMITER, ip, 'witness', RATE_LIMITS.witness.limit, RATE_LIMITS.witness.window)
    : await checkAndIncrementRateLimit(env.DB, `witness:${ip}`, RATE_LIMITS.witness.limit, RATE_LIMITS.witness.window)
  if (!witnessLimit.allowed) {
    trackAnalytics(env, ['route', '/api/witness', 'throttled'])
    return Response.json({ ok: false, throttled: true }, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Retry-After': String(witnessLimit.retryAfter),
      },
    })
  }

  const clampedDwell = Math.min(dwell, 300)
  try {
    for (const family of uniqueFamilies) {
      await updateWarmth(env.DB, family, clampedDwell)
    }
    // Warmth is emitted into the cached projection (cache.ts). Without this
    // trigger, witness updates are invisible for up to STATE_CACHE_STALE_MS.
    // Coalesced by the lock + dirty marker — contention just sets the marker.
    // Not awaited: witness must stay a fast path (sub-50ms).
    ctx.waitUntil(
      rebuildStateProjectionIfNotLocked(env.DB, env.KV)
        .catch(e => console.error('Witness rebuild failed:', e))
    )
  } catch (e) {
    console.error('Warmth update failed:', e)
    trackAnalytics(env, ['route', '/api/witness', 'warmth_error', uniqueFamilies.join(',')])
    return Response.json({ ok: false, error: 'warmth_update_failed' }, {
      status: 500, headers: { 'Access-Control-Allow-Origin': '*' },
    })
  }
  trackAnalytics(env, ['route', '/api/witness', 'accepted', uniqueFamilies.join(',')], [clampedDwell])
  return Response.json({ ok: true }, {
    headers: { 'Access-Control-Allow-Origin': '*' },
  })
}
