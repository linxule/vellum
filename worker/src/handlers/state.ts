import type { Env } from '../types'
import { readProjectionCache, rebuildStateProjection, rebuildStateProjectionIfNotLocked } from '../cache'
import { checkAndIncrementRateLimit, checkRateLimitDO, RATE_LIMITS } from '../rate-limits'
import { constantTimeEqual } from '../hmac'
import { trackAnalytics } from '../analytics'
import { STATE_CACHE_STALE_MS } from '../schemas'
import { DEFAULT_SURFACE } from '../surfaces'
import { modeOf } from '../levee-admission'

export async function handleState(request: Request, env: Env, ctx: ExecutionContext, surface: string = DEFAULT_SURFACE): Promise<Response> {
  const url = new URL(request.url)
  const defaultProjection = { threads: [], computed_at: Date.now(), version: 0 }

  // Per-IP rate limit: 60/60s
  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown'
  const rl = env.RATE_LIMITER
    ? await checkRateLimitDO(env.RATE_LIMITER, ip, 'state', RATE_LIMITS.state.limit, RATE_LIMITS.state.window)
    : await checkAndIncrementRateLimit(env.DB, `state:${ip}`, RATE_LIMITS.state.limit, RATE_LIMITS.state.window)
  if (!rl.allowed) {
    trackAnalytics(env, ['route', '/api/state', 'throttled'])
    return Response.json({ error: 'Rate limit exceeded' }, {
      status: 429,
      headers: { 'Access-Control-Allow-Origin': '*', 'Retry-After': String(rl.retryAfter) },
    })
  }
  // Force-refresh is expensive (rebuilds entire projection) — gate behind admin key
  const adminKey = request.headers.get('x-admin-key')
  const forceRefresh = url.searchParams.get('refresh') === '1' && adminKey !== null && constantTimeEqual(adminKey, env.ADMIN_KEY)
  let projection = await readProjectionCache(env.KV, surface)
  let analyticsState = 'hit'
  const permanenceMode = modeOf(env, 'LEVEE_PERMANENCE')

  if (!projection) {
    analyticsState = 'miss-inline'
    await rebuildStateProjection(env.DB, env.KV, 'off', surface, permanenceMode)
    projection = await readProjectionCache(env.KV, surface)
  } else if (forceRefresh) {
    analyticsState = 'force-refresh'
    const startedAt = Date.now()
    let rebuildStatus: 'locked' | 'rebuilt' | 'rebuilt-twice' | 'debounced'
    try {
      rebuildStatus = await rebuildStateProjectionIfNotLocked(env.DB, env.KV, undefined, 'off', 0, surface, permanenceMode)
      trackAnalytics(env, ['cache_rebuild', 'state', rebuildStatus], [Date.now() - startedAt])
    } catch (error) {
      trackAnalytics(env, ['cache_rebuild', 'state', 'error'], [Date.now() - startedAt])
      throw error
    }
    if (rebuildStatus === 'rebuilt' || rebuildStatus === 'rebuilt-twice') {
      projection = await readProjectionCache(env.KV, surface)
      analyticsState = 'force-refreshed'
    } else {
      // KNOWN: contention-acceptable — see PATTERNS_AND_GOTCHAS § Cache contention
      analyticsState = 'force-locked'
    }
  } else {
    const ageMs = Date.now() - projection.computed_at
    if (ageMs > STATE_CACHE_STALE_MS) {
      analyticsState = 'stale-served'
      ctx.waitUntil(
        rebuildStateProjectionIfNotLocked(env.DB, env.KV, undefined, 'off', 0, surface, permanenceMode)
          .catch(e => console.error('Background state rebuild failed:', e))
      )
    } else {
      analyticsState = 'fresh'
    }
  }

  const cacheAgeMs = projection ? Math.max(0, Date.now() - projection.computed_at) : -1
  trackAnalytics(env, ['route', '/api/state', analyticsState, forceRefresh ? 'refresh' : 'normal'], [cacheAgeMs])

  // refresh=1 must bypass browser cache entirely — otherwise retry loops
  // (after a tool result) read a stale cached response and can't find the
  // freshly-written voice until the cache expires.
  const cacheControl = forceRefresh
    ? 'no-store'
    : 'public, max-age=10'
  return Response.json(projection ?? defaultProjection, {
    headers: { 'Cache-Control': cacheControl, 'Access-Control-Allow-Origin': '*' },
  })
}
