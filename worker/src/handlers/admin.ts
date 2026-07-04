import type { Env } from '../types'
import { readAtmosphereCache, readProjectionCache, rebuildAll } from '../cache'
import { getWarmthMap } from '../warmth'
import { constantTimeEqual } from '../hmac'
import { ADMIN_HIDE_BODY_SCHEMA, STATE_CACHE_STALE_MS } from '../schemas'

export async function handleAdmin(request: Request, env: Env, url: URL): Promise<Response> {
  const key = request.headers.get('x-admin-key')
  if (!key || !constantTimeEqual(key, env.ADMIN_KEY)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const path = url.pathname.replace('/api/admin/', '')

  if (path === 'stats' && request.method === 'GET') {
    const [totalRes, familyRes, recentRes, topWovenRes, warmthRows, projection, atmosphere] = await Promise.all([
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
      env.DB.prepare(`
        SELECT family, score, last_updated
        FROM warmth_state
        ORDER BY family
      `).all(),
      readProjectionCache(env.KV),
      readAtmosphereCache(env.KV),
    ])
    const warmth = await getWarmthMap(env.DB)
    const now = Date.now()
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
      analytics: {
        dataset: 'vellum_usage',
        note: 'Route, cache, witness, and MCP tool events are written to Workers Analytics Engine for external daily-budget queries.',
      },
    })
  }

  if (path === 'hide' && request.method === 'POST') {
    let rawBody: unknown
    try {
      rawBody = await request.json()
    } catch {
      return Response.json({ error: 'Invalid JSON' }, { status: 400 })
    }
    const parsed = ADMIN_HIDE_BODY_SCHEMA.safeParse(rawBody)
    if (!parsed.success) {
      return Response.json({ error: 'voice_id required' }, { status: 400 })
    }
    await env.DB.prepare('UPDATE voices SET is_hidden = TRUE WHERE id = ?').bind(parsed.data.voice_id).run()
    await rebuildAll(env.DB, env.KV)
    return Response.json({ ok: true, voice_id: parsed.data.voice_id })
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
