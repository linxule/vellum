import type { Env, VoiceRow } from '../types'
import { checkAndIncrementRateLimit, checkRateLimitDO, RATE_LIMITS } from '../rate-limits'

export interface LineageNode {
  id: string
  text: string
  family: string
  language: string | null
  depth: number
  parentId: string | null
  childIds: string[]
  weaveCount: number
  createdAt: number
}

export interface LineageTree {
  seed: string
  nodes: LineageNode[]
}

export async function buildLineage(db: D1Database, seedVoiceId: string): Promise<LineageTree | null> {
  const seedRow = await db.prepare(
    'SELECT * FROM voices WHERE id = ? AND is_hidden = FALSE'
  ).bind(seedVoiceId).first<VoiceRow>()
  if (!seedRow) return null

  const allRows = new Map<string, VoiceRow>()
  allRows.set(seedRow.id, seedRow)

  // Walk UP: follow weave_from links to ancestors
  let currentId = seedRow.weave_from
  for (let i = 0; i < 20 && currentId; i++) {
    if (allRows.has(currentId)) break
    const row = await db.prepare(
      'SELECT * FROM voices WHERE id = ? AND is_hidden = FALSE'
    ).bind(currentId).first<VoiceRow>()
    if (!row) break
    allRows.set(row.id, row)
    currentId = row.weave_from
  }

  // Walk DOWN: BFS from all known nodes to find descendants
  let frontier = [...allRows.keys()]
  for (let i = 0; i < 20 && frontier.length > 0; i++) {
    const placeholders = frontier.map(() => '?').join(',')
    const res = await db.prepare(
      `SELECT * FROM voices WHERE weave_from IN (${placeholders}) AND is_hidden = FALSE`
    ).bind(...frontier).all<VoiceRow>()
    const newIds: string[] = []
    for (const row of res.results ?? []) {
      if (!allRows.has(row.id)) {
        allRows.set(row.id, row)
        newIds.push(row.id)
      }
    }
    frontier = newIds
  }

  // Fetch primary families for all voices in one batch
  const voiceIds = [...allRows.keys()]
  const famPlaceholders = voiceIds.map(() => '?').join(',')
  const famRes = await db.prepare(
    `SELECT voice_id, family FROM voice_families WHERE voice_id IN (${famPlaceholders}) AND ordinal = 0`
  ).bind(...voiceIds).all<{ voice_id: string; family: string }>()
  const familyMap = new Map<string, string>()
  for (const row of famRes.results ?? []) {
    familyMap.set(row.voice_id, row.family)
  }

  // Compute depth relative to seed: build parent chain distances
  const depthMap = new Map<string, number>()
  depthMap.set(seedVoiceId, 0)

  // Ancestors: walk up from seed
  const ancestorIds: string[] = []
  let walkId: string | null = seedRow.weave_from
  let d = -1
  while (walkId && allRows.has(walkId) && !depthMap.has(walkId)) {
    depthMap.set(walkId, d)
    ancestorIds.push(walkId)
    const row = allRows.get(walkId)!
    walkId = row.weave_from
    d--
  }

  // Descendants: BFS from the seed AND every direct-line ancestor — off-path
  // kin (a sibling of the seed, an uncle, a cousin) are children of an
  // ancestor, not of the seed, so the walk must start from ancestors too or
  // they never get a depth and silently default to 0 via the fallback below.
  const bfsQueue = [seedVoiceId, ...ancestorIds]
  while (bfsQueue.length > 0) {
    const parentId = bfsQueue.shift()!
    const parentDepth = depthMap.get(parentId) ?? 0
    for (const [id, row] of allRows) {
      if (row.weave_from === parentId && !depthMap.has(id)) {
        depthMap.set(id, parentDepth + 1)
        bfsQueue.push(id)
      }
    }
  }

  // Build child index
  const childIndex = new Map<string, string[]>()
  for (const [id, row] of allRows) {
    if (row.weave_from && allRows.has(row.weave_from)) {
      const siblings = childIndex.get(row.weave_from) ?? []
      siblings.push(id)
      childIndex.set(row.weave_from, siblings)
    }
  }

  const nodes: LineageNode[] = voiceIds.map(id => {
    const row = allRows.get(id)!
    return {
      id: row.id,
      text: row.text,
      family: familyMap.get(id) ?? 'unknown',
      language: row.language,
      depth: depthMap.get(id) ?? 0,
      parentId: row.weave_from && allRows.has(row.weave_from) ? row.weave_from : null,
      childIds: childIndex.get(id) ?? [],
      weaveCount: row.weave_count,
      createdAt: row.created_at,
    }
  })

  return { seed: seedVoiceId, nodes }
}

export async function handleLineage(request: Request, env: Env, voiceId: string): Promise<Response> {
  const clientIp = request.headers.get('cf-connecting-ip') ?? 'unknown'
  const rl = env.RATE_LIMITER
    ? await checkRateLimitDO(env.RATE_LIMITER, clientIp, 'lineage', RATE_LIMITS.lineage.limit, RATE_LIMITS.lineage.window)
    : await checkAndIncrementRateLimit(
      env.DB, `lineage:${clientIp}`, RATE_LIMITS.lineage.limit, RATE_LIMITS.lineage.window,
    )
  if (!rl.allowed) {
    return Response.json({ error: 'Too many requests' }, {
      status: 429,
      headers: { 'Access-Control-Allow-Origin': '*', 'Retry-After': String(rl.retryAfter) },
    })
  }

  const tree = await buildLineage(env.DB, voiceId)
  if (!tree) {
    return Response.json({ error: 'Voice not found' }, {
      status: 404,
      headers: { 'Access-Control-Allow-Origin': '*' },
    })
  }
  return Response.json(tree, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=60',
    },
  })
}
