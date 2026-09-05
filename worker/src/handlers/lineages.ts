import { z } from 'zod'
import type { Env } from '../types'
import { checkAndIncrementRateLimit, checkRateLimitDO, RATE_LIMITS } from '../rate-limits'
import { DEFAULT_SURFACE } from '../surfaces'

const QUERY_SCHEMA = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().min(0).default(0),
})

export async function handleLineages(request: Request, env: Env, surface: string = DEFAULT_SURFACE): Promise<Response> {
  const clientIp = request.headers.get('cf-connecting-ip') ?? 'unknown'
  const rl = env.RATE_LIMITER
    ? await checkRateLimitDO(env.RATE_LIMITER, clientIp, 'lineages', RATE_LIMITS.lineages.limit, RATE_LIMITS.lineages.window)
    : await checkAndIncrementRateLimit(
      env.DB, `lineages:${clientIp}`, RATE_LIMITS.lineages.limit, RATE_LIMITS.lineages.window,
    )
  if (!rl.allowed) {
    return Response.json({ error: 'Too many requests' }, {
      status: 429,
      headers: { 'Access-Control-Allow-Origin': '*', 'Retry-After': String(rl.retryAfter) },
    })
  }

  const url = new URL(request.url)
  const params = QUERY_SCHEMA.safeParse({
    limit: url.searchParams.get('limit') ?? undefined,
    offset: url.searchParams.get('offset') ?? undefined,
  })
  if (!params.success) {
    return Response.json(
      { error: 'Invalid parameters', details: params.error.issues.map(i => i.message) },
      { status: 400, headers: { 'Access-Control-Allow-Origin': '*' } },
    )
  }

  const { limit, offset } = params.data

  const [dataRes, countRes] = await env.DB.batch([
    env.DB.prepare(`
      SELECT v.id, v.text, v.language, v.weave_count, v.unique_weavers, v.created_at, vf.family,
        (SELECT COUNT(*) FROM voices d WHERE d.weave_from = v.id AND d.is_hidden = FALSE) AS descendant_count
      FROM voices v
      JOIN voice_families vf ON v.id = vf.voice_id
      WHERE vf.ordinal = 0 AND v.is_hidden = FALSE AND v.surface_id = ? AND v.weave_count > 0
      ORDER BY v.weave_count DESC, v.created_at DESC
      LIMIT ? OFFSET ?
    `).bind(surface, limit, offset),
    env.DB.prepare(`
      SELECT COUNT(*) as total FROM voices v
      JOIN voice_families vf ON v.id = vf.voice_id
      WHERE vf.ordinal = 0 AND v.is_hidden = FALSE AND v.surface_id = ? AND v.weave_count > 0
    `).bind(surface),
  ])

  const rows = (dataRes.results ?? []) as Array<{
    id: string; text: string; language: string | null; weave_count: number
    unique_weavers: number; created_at: number; family: string; descendant_count: number
  }>
  const total = ((countRes.results ?? [])[0] as { total: number } | undefined)?.total ?? 0

  const lineages = rows.map(r => ({
    seed_id: r.id,
    text: r.text,
    family: r.family,
    language: r.language ?? 'en',
    weave_count: r.weave_count,
    unique_weavers: r.unique_weavers,
    descendant_count: r.descendant_count,
    created_at: r.created_at,
  }))

  return Response.json(
    { lineages, pagination: { offset, limit, total } },
    { headers: { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=60' } },
  )
}
