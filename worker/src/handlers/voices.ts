import { CONTRACT, SORT_VALUES } from '../contract'
import { envelope, errorResponse, zodToEnvelope } from '../errors'
import { getWarmthMap, sortByWarmth } from '../warmth'
import { z } from 'zod'
import type { Env, VoiceRow } from '../types'
import { FAMILIES } from '../types'
import { checkAndIncrementRateLimit, checkRateLimitDO, RATE_LIMITS } from '../rate-limits'
import { DEFAULT_SURFACE } from '../surfaces'

const familyEnum = z.enum(FAMILIES as unknown as [string, ...string[]])

const QUERY_SCHEMA = z.object({
  family: familyEnum.optional(),
  lang: z.string().max(10).optional(),
  sort: z.enum(SORT_VALUES).default('age'),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().min(0).default(0),
})

export async function handleVoices(request: Request, env: Env, surface: string = DEFAULT_SURFACE): Promise<Response> {
  try {
    const clientIp = request.headers.get('cf-connecting-ip') ?? 'unknown'
    const rl = env.RATE_LIMITER
      ? await checkRateLimitDO(env.RATE_LIMITER, clientIp, 'voices', RATE_LIMITS.voices.limit, RATE_LIMITS.voices.window)
      : await checkAndIncrementRateLimit(
        env.DB, `voices:${clientIp}`, RATE_LIMITS.voices.limit, RATE_LIMITS.voices.window,
      )
    if (!rl.allowed) {
      return errorResponse(envelope('RATE_LIMITED', 'The per-IP voice-listing quota is exhausted.', { error: 'Too many requests', limit: rl.limit, retry_after: rl.retryAfter }), 429, { 'Retry-After': String(rl.retryAfter) })
    }

    const url = new URL(request.url)
    const params = QUERY_SCHEMA.safeParse({
      family: url.searchParams.get('family') ?? undefined,
      lang: url.searchParams.get('lang') ?? undefined,
      sort: url.searchParams.get('sort') ?? undefined,
      limit: url.searchParams.get('limit') ?? undefined,
      offset: url.searchParams.get('offset') ?? undefined,
    })
    if (!params.success) {
      return errorResponse({ ...zodToEnvelope(params.error.issues), error: 'Invalid parameters' }, 400)
    }

    const { family, lang, sort, limit, offset } = params.data
    const now = Date.now()

    // Build query
    let sql = `SELECT v.id, v.text, v.language, v.weave_count, v.created_at, vf.family
      FROM voices v JOIN voice_families vf ON v.id = vf.voice_id
      WHERE vf.ordinal = 0 AND v.is_hidden = FALSE AND v.surface_id = ?`
    let countSql = `SELECT COUNT(*) as total
      FROM voices v JOIN voice_families vf ON v.id = vf.voice_id
      WHERE vf.ordinal = 0 AND v.is_hidden = FALSE AND v.surface_id = ?`
    const binds: (string | number)[] = [surface]
    const countBinds: (string | number)[] = [surface]

    if (family) {
      sql += ' AND vf.family = ?'
      countSql += ' AND vf.family = ?'
      binds.push(family)
      countBinds.push(family)
    }
    if (lang) {
      sql += ' AND v.language = ?'
      countSql += ' AND v.language = ?'
      binds.push(lang)
      countBinds.push(lang)
    }

    if (sort === 'weaves') sql += ' ORDER BY v.weave_count DESC, v.created_at DESC'
    else sql += ' ORDER BY v.created_at DESC'

    sql += ' LIMIT ? OFFSET ?'
    binds.push(limit, offset)

    const [dataRes, countRes] = await env.DB.batch([
      env.DB.prepare(sql).bind(...binds),
      env.DB.prepare(countSql).bind(...countBinds),
    ])

    const rows = (dataRes.results ?? []) as Array<VoiceRow & { family: string }>
    if (sort === 'warmth') sortByWarmth(rows, new Map(Object.entries(await getWarmthMap(env.DB, surface))))
    const total = ((countRes.results ?? [])[0] as { total: number } | undefined)?.total ?? 0

    const voices = rows.map(v => ({
      id: v.id,
      text: v.text,
      lang: v.language ?? 'en',
      family: v.family,
      weave_count: v.weave_count,
      age_h: Math.round((now - v.created_at) / 3_600_000),
      created_at: v.created_at,
    }))

    return Response.json(
      { voices, pagination: { offset, limit, total }, sort },
      { headers: { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=30' } },
    )
  } catch (error) {
    console.error('Voice listing failed:', error)
    return errorResponse(envelope('INTERNAL', CONTRACT.errorCodes.INTERNAL, { error: 'Internal error' }), 500)
  }
}
