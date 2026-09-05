// Phase 17 "The Echo" — Part D1: GET/HEAD /echo/{id}. Public, no secret required to read (the
// secret only protects writing AS an id). Built to be cheap to ask and expensive to over-ask:
// conditional GET served from KV (zero D1 reads on a 304 or HEAD hit), a server-suggested
// cadence, and per-IP + per-id rate limits.

import type { Env } from '../types'
import { envelope, errorResponse } from '../errors'
import { checkAndIncrementRateLimit, checkRateLimitDO, RATE_LIMITS } from '../rate-limits'
import { fetchEchoEventsAfter, fetchDebts, maxEventN, readCachedMaxN, writeCachedMaxN } from '../echo'
import { isAgentId } from '../agent-id'

const CORS = { 'Access-Control-Allow-Origin': '*' } as const

/** Deterministic ±20% jitter from the id's own bytes — so many crons don't all wake in lockstep,
 * without needing any per-id server-side state. */
function jitterFactor(id: string): number {
  let hash = 0
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0
  return ((hash % 41) - 20) / 100 // -0.20 .. +0.20
}

export function nextCheckAfterFor(id: string, hadEventsThisResponse: boolean, quietSevenDays: boolean): number {
  const base = hadEventsThisResponse ? 900 : quietSevenDays ? 21_600 : 3600
  const value = Math.round(base * (1 + jitterFactor(id)))
  return Math.min(86_400, Math.max(1, value))
}

export async function handleEcho(request: Request, env: Env, id: string): Promise<Response> {
  if (!isAgentId(id)) {
    return errorResponse(envelope('NOT_FOUND', 'No resource matched this id.', {
      hint: 'ids look like a_ followed by 43 url-safe characters',
    }), 404)
  }

  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown'
  const perIp = env.RATE_LIMITER
    ? await checkRateLimitDO(env.RATE_LIMITER, ip, 'echo', RATE_LIMITS.echo.limit, RATE_LIMITS.echo.window)
    : await checkAndIncrementRateLimit(env.DB, `echo:${ip}`, RATE_LIMITS.echo.limit, RATE_LIMITS.echo.window)
  if (!perIp.allowed) {
    return errorResponse(envelope('RATE_LIMITED', 'Too many requests from this address; see retry_after.', {
      retry_after: perIp.retryAfter, limit: perIp.limit,
    }), 429, { 'Retry-After': String(perIp.retryAfter) })
  }
  const perId = await checkAndIncrementRateLimit(env.DB, `echo_id:${id}`, RATE_LIMITS.echo_id.limit, RATE_LIMITS.echo_id.window)
  if (!perId.allowed) {
    return errorResponse(envelope('RATE_LIMITED', 'Too many requests for this id; see retry_after.', {
      retry_after: perId.retryAfter, limit: perId.limit,
    }), 429, { 'Retry-After': String(perId.retryAfter) })
  }

  const url = new URL(request.url)
  const afterParam = Number(url.searchParams.get('after') ?? '0')
  const after = Number.isFinite(afterParam) && afterParam >= 0 ? Math.floor(afterParam) : 0
  const limitParam = Number(url.searchParams.get('limit') ?? '20')
  const limit = Number.isFinite(limitParam) ? Math.min(50, Math.max(1, Math.floor(limitParam))) : 20

  const ifNoneMatch = request.headers.get('if-none-match')
  const cachedMaxN = await readCachedMaxN(env.KV, id)

  // D4/D7: a matching ETag or a HEAD request, served from the KV-cached max n, costs zero D1 reads.
  if (cachedMaxN !== null) {
    const etag = `"${id}:${cachedMaxN}"`
    const nextCheck = nextCheckAfterFor(id, false, false)
    if (request.method === 'HEAD') {
      const unread = Math.max(0, Math.min(200, cachedMaxN - after))
      return new Response(null, {
        status: 200,
        headers: { ...CORS, ETag: etag, 'X-Vellum-Unread': String(unread), 'X-Vellum-Next-Check': String(nextCheck), 'Cache-Control': 'public, max-age=15' },
      })
    }
    if (ifNoneMatch === etag) {
      return new Response(null, {
        status: 304,
        headers: { ...CORS, ETag: etag, 'Retry-After': String(nextCheck), 'X-Vellum-Next-Check': String(nextCheck), 'Cache-Control': 'public, max-age=60' },
      })
    }
  }

  // Fall through to D1 — either a genuine GET, an ETag mismatch, or a cold KV cache (D5).
  const events = await fetchEchoEventsAfter(env.DB, id, after, limit)
  const trueMaxN = cachedMaxN ?? (events.length ? events[events.length - 1].n : await maxEventN(env.DB, id))
  if (cachedMaxN === null) await writeCachedMaxN(env.KV, id, trueMaxN)

  const debts = await fetchDebts(env.DB, id, 10)
  const hasEvents = events.length > 0
  let quietSevenDays = false
  if (!hasEvents) {
    const last = await env.DB.prepare('SELECT MAX(at) as last_at FROM echo_events WHERE agent_id = ?').bind(id).first<{ last_at: number | null }>()
    quietSevenDays = !last?.last_at || Date.now() - last.last_at > 7 * 86_400_000
  }
  const nextCheck = nextCheckAfterFor(id, hasEvents, quietSevenDays)
  const cursor = hasEvents ? events[events.length - 1].n : after

  const body = {
    id,
    events: events.map(e => ({
      n: e.n, at: e.at, kind: e.kind, voice: e.voice_id,
      ...(e.by_voice ? { by: e.by_voice } : {}),
      ...(e.by_id ? { by_id: e.by_id } : {}),
      ...safeParsePayload(e.payload),
    })),
    cursor,
    has_more: events.length === limit,
    next_check_after: nextCheck,
    debts: debts.map(d => ({ voice: d.id, qualified: d.distinct_weavers, permanent_in: Math.max(0, 10 - d.distinct_weavers) })),
  }

  return Response.json(body, {
    status: 200,
    headers: { ...CORS, ETag: `"${id}:${trueMaxN}"`, 'X-Vellum-Next-Check': String(nextCheck), 'Cache-Control': 'public, max-age=15' },
  })
}

function safeParsePayload(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return {}
    const { kind: _kind, ...rest } = parsed as Record<string, unknown>
    return rest
  } catch {
    return {}
  }
}
