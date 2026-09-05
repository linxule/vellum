import { admitBody } from '../admission'
import { CONTRACT } from '../contract'
import { envelope, errorResponse, zodToEnvelope } from '../errors'
import type { Env } from '../types'
import { rebuildStateProjectionIfNotLocked } from '../cache'
import { modeOf } from '../levee-admission'
import { checkAndIncrementRateLimit, checkRateLimitDO, RATE_LIMITS } from '../rate-limits'
import { updateWarmth } from '../warmth'
import { trackAnalytics } from '../analytics'
import { WITNESS_BODY_SCHEMA } from '../schemas'
import { DEFAULT_SURFACE } from '../surfaces'

export async function handleWitness(request: Request, env: Env, ctx: ExecutionContext, surface: string = DEFAULT_SURFACE): Promise<Response> {
  const endpoint = CONTRACT.endpoints.witness
  const admitted = await admitBody(request, endpoint)
  if ('response' in admitted) return admitted.response
  // Validate body first (before consuming rate limit quota)
  let body: { family?: string; families?: string[]; dwell_s?: number }
  try {
    const rawBody: unknown = JSON.parse(admitted.text)
    const parsed = WITNESS_BODY_SCHEMA.safeParse(rawBody)
    if (!parsed.success) {
      const fault = zodToEnvelope(parsed.error.issues, endpoint, rawBody)
      const invalidFamily = parsed.error.issues.some(i => i.code === 'invalid_enum_value')
      fault.error = invalidFamily ? 'Invalid family' : 'Invalid witness event'
      trackAnalytics(env, ['route', '/api/witness', invalidFamily ? 'invalid_family' : 'invalid_body'])
      return errorResponse(fault, 400)
    }
    body = parsed.data
  } catch {
    trackAnalytics(env, ['route', '/api/witness', 'invalid_json'])
    return errorResponse(envelope('INVALID_JSON', 'The request body is not valid JSON.', { error: 'Invalid JSON', example: endpoint.example }), 400)
  }
  const dwell = typeof body?.dwell_s === 'number' && Number.isFinite(body.dwell_s) ? body.dwell_s : 0
  const families = Array.isArray(body?.families)
    ? body.families
    : typeof body?.family === 'string'
      ? [body.family]
      : []
  if (families.length === 0 || dwell < 1) {
    trackAnalytics(env, ['route', '/api/witness', 'invalid_body'])
    return errorResponse(envelope('VALIDATION', families.length === 0 ? endpoint.constraint : 'dwell_s must be at least 1 second.', { error: 'Invalid witness event', field: families.length === 0 ? 'families' : 'dwell_s', valid_values: families.length === 0 ? [...CONTRACT.families] : undefined, example: endpoint.example }), 400)
  }
  const uniqueFamilies = Array.from(new Set(families))

  // Per-IP rate limit: 5 witness events per 60s.
  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown'
  try {
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

  } catch (error) {
    console.error('Witness rate limit failed:', error)
    trackAnalytics(env, ['route', '/api/witness', 'warmth_error', uniqueFamilies.join(',')])
    return errorResponse(envelope('INTERNAL', CONTRACT.errorCodes.INTERNAL, { error: 'warmth_update_failed' }), 500)
  }

  const clampedDwell = Math.min(dwell, 300)
  try {
    for (const family of uniqueFamilies) {
      await updateWarmth(env.DB, family, clampedDwell, surface)
    }
    // Warmth is emitted into the cached projection (cache.ts). Without this
    // trigger, witness updates are invisible for up to STATE_CACHE_STALE_MS.
    // Coalesced by the lock + dirty marker — contention just sets the marker.
    // Not awaited: witness must stay a fast path (sub-50ms).
    ctx.waitUntil(
      rebuildStateProjectionIfNotLocked(env.DB, env.KV, undefined, 'off', 0, surface, modeOf(env, 'LEVEE_PERMANENCE'))
        .catch(e => console.error('Witness rebuild failed:', e))
    )
  } catch (e) {
    console.error('Warmth update failed:', e)
    trackAnalytics(env, ['route', '/api/witness', 'warmth_error', uniqueFamilies.join(',')])
    return errorResponse(envelope('INTERNAL', CONTRACT.errorCodes.INTERNAL, { error: 'warmth_update_failed' }), 500)
  }
  trackAnalytics(env, ['route', '/api/witness', 'accepted', uniqueFamilies.join(',')], [clampedDwell])
  return Response.json({ ok: true }, {
    headers: { 'Access-Control-Allow-Origin': '*' },
  })
}
