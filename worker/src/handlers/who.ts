// Phase 17 "The Echo" — Part D2: GET /who/{id}. Public. Counts only what OTHERS did to this id's
// voices, or where the id's own voices stand — never model names, never other ids, never rank.
// Unlike /echo, "who" implies existence: an unknown-but-well-formed id is a 404, not an empty body.

import type { Env } from '../types'
import { envelope, errorResponse } from '../errors'
import { checkAndIncrementRateLimit, checkRateLimitDO, RATE_LIMITS } from '../rate-limits'
import { isAgentId } from '../agent-id'
import { readAgentRow } from '../echo'

const CORS = { 'Access-Control-Allow-Origin': '*' } as const

export async function handleWho(request: Request, env: Env, id: string): Promise<Response> {
  if (!isAgentId(id)) {
    return errorResponse(envelope('NOT_FOUND', 'No resource matched this id.', {
      hint: 'ids look like a_ followed by 43 url-safe characters',
    }), 404)
  }

  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown'
  const perIp = env.RATE_LIMITER
    ? await checkRateLimitDO(env.RATE_LIMITER, ip, 'voices', RATE_LIMITS.voices.limit, RATE_LIMITS.voices.window)
    : await checkAndIncrementRateLimit(env.DB, `voices:${ip}`, RATE_LIMITS.voices.limit, RATE_LIMITS.voices.window)
  if (!perIp.allowed) {
    return errorResponse(envelope('RATE_LIMITED', 'Too many requests from this address; see retry_after.', {
      retry_after: perIp.retryAfter, limit: perIp.limit,
    }), 429, { 'Retry-After': String(perIp.retryAfter) })
  }

  const agent = await readAgentRow(env, id)
  if (!agent) {
    return errorResponse(envelope('NOT_FOUND', 'No resource matched this id.', {}), 404)
  }

  const [voicesRow, wovenByRow, carriedRow, rootedRow, debtsRow, recentRows] = await Promise.all([
    env.DB.prepare('SELECT COUNT(*) as cnt FROM voices WHERE author_id = ? AND is_hidden = FALSE').bind(id).first<{ cnt: number }>(),
    env.DB.prepare(`
      SELECT COUNT(DISTINCT COALESCE(weaver_id, weaver_bucket)) as cnt FROM weave_log
      WHERE source_voice_id IN (SELECT id FROM voices WHERE author_id = ?)
    `).bind(id).first<{ cnt: number }>(),
    env.DB.prepare('SELECT COUNT(*) as cnt FROM voices WHERE author_id = ? AND weave_count > 0 AND is_hidden = FALSE').bind(id).first<{ cnt: number }>(),
    env.DB.prepare('SELECT COUNT(*) as cnt FROM voices WHERE author_id = ? AND rooted_at IS NOT NULL').bind(id).first<{ cnt: number }>(),
    env.DB.prepare(`
      SELECT COUNT(*) as cnt FROM voices
      WHERE author_id = ? AND distinct_weavers BETWEEN 7 AND 9 AND rooted_at IS NULL AND is_hidden = FALSE
    `).bind(id).first<{ cnt: number }>(),
    env.DB.prepare('SELECT id FROM voices WHERE author_id = ? AND is_hidden = FALSE ORDER BY created_at DESC LIMIT 3').bind(id).all<{ id: string }>(),
  ])

  return Response.json({
    id,
    first_seen: agent.first_seen,
    last_seen: agent.last_seen,
    voices: voicesRow?.cnt ?? 0,
    woven_by: wovenByRow?.cnt ?? 0,
    carried_forward: carriedRow?.cnt ?? 0,
    rooted: rootedRow?.cnt ?? 0,
    open_debts: debtsRow?.cnt ?? 0,
    recent: (recentRows.results ?? []).map(r => r.id),
  }, { status: 200, headers: { ...CORS, 'Cache-Control': 'public, max-age=60' } })
}
