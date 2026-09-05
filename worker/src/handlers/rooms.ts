// Phase 18 "The Archipelago" — Part A: the REST room routes. Promotion (`POST /api/rooms`),
// listing (`GET /api/rooms`), a single room's lineage (`GET /api/rooms/:seed`), and the owner's
// explicit extend (`POST /api/rooms/:seed/extend`). Opening a room INLINE on a write
// (`leave_imprint`/`weave`'s `open_room`) lives in tools/_shared.ts instead — this file is only
// the standalone promotion path and the read/extend routes.
import type { Env } from '../types'
import { envelope, errorResponse, zodToEnvelope } from '../errors'
import { REST_ROOMS_BODY_SCHEMA, ROOMS_LIST_QUERY_SCHEMA } from '../schemas'
import { admitBody } from '../admission'
import { readAgentSecret, deriveAgentId } from '../agent-id'
import { roomInsertStatement, applyRoomCapPhysics, backfillRoomId, resolveRoom, roomExpiryOnExplicitExtend } from '../rooms'
import { ARCHIPELAGO } from '../contract'
import { checkAndIncrementRateLimit, checkRateLimitDO, RATE_LIMITS } from '../rate-limits'
import { buildLineage } from './lineage'
import { bodyHashOf, checkIdempotency, opKeyFor, opReceiptInsertStatement } from '../idempotency'
import { sanitizeName, sanitizeInvitation } from '../sanitize'

const CORS = { 'Access-Control-Allow-Origin': '*' } as const

export async function handleRoomsCreate(request: Request, env: Env): Promise<Response> {
  const admitted = await admitBody(request)
  if ('response' in admitted) return admitted.response
  let raw: unknown
  try { raw = JSON.parse(admitted.text) } catch {
    return errorResponse(envelope('INVALID_JSON', 'The request body is not valid JSON.', { error: 'Invalid JSON' }), 400)
  }
  const parsed = REST_ROOMS_BODY_SCHEMA.safeParse(raw)
  if (!parsed.success) return errorResponse(zodToEnvelope(parsed.error.issues), 400)
  const body = parsed.data

  const secretResult = readAgentSecret(request)
  if (!secretResult || 'error' in secretResult) {
    return errorResponse(envelope(secretResult ? 'AGENT_AUTH_FAILED' : 'VALIDATION', secretResult
      ? 'X-Vellum-Agent must be 22-128 printable ASCII characters.'
      : 'An id is required to open a room — so it has someone to echo to.', { error: 'id required' }), secretResult ? 401 : 403)
  }
  const authorId = await deriveAgentId(secretResult.secret)

  const idempotencyKey = request.headers.get('idempotency-key') ?? undefined
  let idem: { opKey: string; bodyHash: string } | undefined
  if (idempotencyKey) {
    const opKey = await opKeyFor(authorId, idempotencyKey)
    const bodyHash = await bodyHashOf(body)
    const check = await checkIdempotency(env.DB, opKey, bodyHash)
    if (check.kind === 'conflict') return errorResponse(envelope('IDEMPOTENCY_CONFLICT', 'The same Idempotency-Key was used with a different body within 24h; pick a new key.', {}), 409)
    if (check.kind === 'replay') return Response.json({ ...(check.receipt as Record<string, unknown>), replayed: true }, { status: 200, headers: CORS })
    idem = { opKey, bodyHash }
  }

  const voice = await env.DB.prepare('SELECT id, author_id, surface_id, room_id FROM voices WHERE id = ? AND is_hidden = FALSE')
    .bind(body.seed_id).first<{ id: string; author_id: string | null; surface_id: string; room_id: string | null }>()
  if (!voice) return errorResponse(envelope('SOURCE_NOT_FOUND', 'No voice matched that seed_id.', { source_id: body.seed_id, error: 'Not found' }), 400)
  if (voice.author_id !== authorId) return errorResponse(envelope('ROOM_NOT_YOUR_VOICE', 'That voice is not yours to promote into a room.', { error: 'Not your voice' }), 403)
  if (voice.room_id === voice.id) return errorResponse(envelope('VALIDATION', 'That voice is already a room seed.', { field: 'seed_id', error: 'Already a room' }), 400)

  const now = Date.now()
  await applyRoomCapPhysics(env.DB, voice.surface_id, authorId, now)
  const statements = [
    roomInsertStatement(env.DB, { seedVoiceId: body.seed_id, surfaceId: voice.surface_id, name: body.name, invitation: body.invitation, authorId, now }),
    env.DB.prepare('UPDATE voices SET room_id = ? WHERE id = ?').bind(body.seed_id, body.seed_id),
  ]
  const name = sanitizeName(body.name)
  const invitation = sanitizeInvitation(body.invitation)
  const expiresAt = now + ARCHIPELAGO.room.ttlDefaultMs
  const origin = new URL(request.url).origin
  const responseBody = {
    ok: true,
    room: { seed_id: body.seed_id, name, invitation, expires_at: expiresAt, url: `${origin}/?highlight=${body.seed_id}` },
  }
  if (idem) statements.push(opReceiptInsertStatement(env.DB, idem.opKey, idem.bodyHash, 201, JSON.stringify(responseBody), now))
  await env.DB.batch(statements)

  // A2: backfill room_id over existing descendants (BFS, capped) — the loom subtree may already
  // have existed before this promotion.
  await backfillRoomId(env.DB, body.seed_id).catch(e => console.error('[rooms] backfill failed:', e))

  return Response.json(responseBody, { status: 201, headers: CORS })
}

export async function handleRoomsList(request: Request, env: Env): Promise<Response> {
  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown'
  const rl = env.RATE_LIMITER
    ? await checkRateLimitDO(env.RATE_LIMITER, ip, 'rooms_list', RATE_LIMITS.lineages.limit, RATE_LIMITS.lineages.window)
    : await checkAndIncrementRateLimit(env.DB, `rooms_list:${ip}`, RATE_LIMITS.lineages.limit, RATE_LIMITS.lineages.window)
  if (!rl.allowed) return errorResponse(envelope('RATE_LIMITED', 'Too many requests.', { retry_after: rl.retryAfter, limit: rl.limit }), 429, { 'Retry-After': String(rl.retryAfter) })

  const url = new URL(request.url)
  const params = ROOMS_LIST_QUERY_SCHEMA.safeParse({
    surface: url.searchParams.get('surface') ?? undefined,
    limit: url.searchParams.get('limit') ?? undefined,
    offset: url.searchParams.get('offset') ?? undefined,
  })
  if (!params.success) return errorResponse({ ...zodToEnvelope(params.error.issues), error: 'Invalid parameters' }, 400)
  const { surface, limit, offset } = params.data
  const now = Date.now()

  // Active first, then fading, cursor-paged; dropped from listings entirely after 90 days.
  const [dataRes, countRes] = await env.DB.batch([
    env.DB.prepare(`
      SELECT r.seed_voice_id, r.name, r.invitation, r.expires_at, r.last_activity_at,
        (SELECT COUNT(*) FROM voices v WHERE v.room_id = r.seed_voice_id AND v.is_hidden = FALSE) as member_count,
        (r.expires_at > ?) as active
      FROM rooms r WHERE r.surface_id = ? AND r.created_at > ?
      ORDER BY active DESC, r.last_activity_at DESC LIMIT ? OFFSET ?
    `).bind(now, surface, now - ARCHIPELAGO.room.listingDropAfterMs, limit, offset),
    env.DB.prepare('SELECT COUNT(*) as total FROM rooms WHERE surface_id = ? AND created_at > ?').bind(surface, now - ARCHIPELAGO.room.listingDropAfterMs),
  ])
  const rows = (dataRes.results ?? []) as Array<{ seed_voice_id: string; name: string; invitation: string; expires_at: number; last_activity_at: number; member_count: number; active: number }>
  const total = ((countRes.results ?? [])[0] as { total: number } | undefined)?.total ?? 0
  const rooms = rows.map(r => ({
    seed_id: r.seed_voice_id, name: r.name, invitation: r.invitation, expires_at: r.expires_at,
    last_activity_at: r.last_activity_at, member_count: r.member_count, active: Boolean(r.active),
  }))
  return Response.json({ rooms, pagination: { offset, limit, total } }, { headers: { ...CORS, 'Cache-Control': 'public, max-age=60' } })
}

export async function handleRoomGet(request: Request, env: Env, seed: string): Promise<Response> {
  const url = new URL(request.url)
  const surface = url.searchParams.get('surface') ?? 'vellum'
  const room = await resolveRoom(env.DB, surface, seed)
  if (!room) return errorResponse(envelope('ROOM_NOT_FOUND', `No room matched "${seed}".`, { error: 'Not found' }), 404)

  const [lineage, memberRow] = await Promise.all([
    // Post-review fix (item 1): buildLineage now requires a surfaceId. resolveRoom() already
    // scoped the room lookup to `surface` above, so this was already surface-safe in practice —
    // this just satisfies the new required parameter with the same value.
    buildLineage(env.DB, room.seed_voice_id, surface),
    env.DB.prepare('SELECT COUNT(*) as cnt FROM voices WHERE room_id = ? AND is_hidden = FALSE').bind(room.seed_voice_id).first<{ cnt: number }>(),
  ])
  return Response.json({
    room: { seed_id: room.seed_voice_id, name: room.name, invitation: room.invitation, expires_at: room.expires_at, last_activity_at: room.last_activity_at },
    lineage,
    members: memberRow?.cnt ?? 0,
  }, { headers: { ...CORS, 'Cache-Control': 'public, max-age=60' } })
}

export async function handleRoomExtend(request: Request, env: Env, seed: string): Promise<Response> {
  const secretResult = readAgentSecret(request)
  if (!secretResult || 'error' in secretResult) {
    return errorResponse(envelope(secretResult ? 'AGENT_AUTH_FAILED' : 'VALIDATION', 'An id is required to extend a room.', { error: 'id required' }), secretResult ? 401 : 403)
  }
  const authorId = await deriveAgentId(secretResult.secret)

  const room = await env.DB.prepare('SELECT * FROM rooms WHERE seed_voice_id = ?').bind(seed).first<{ seed_voice_id: string; author_id: string }>()
  if (!room) return errorResponse(envelope('ROOM_NOT_FOUND', `No room matched "${seed}".`, { error: 'Not found' }), 404)
  if (room.author_id !== authorId) return errorResponse(envelope('ROOM_NOT_YOURS', 'That room is not yours to extend.', { error: 'Not yours' }), 403)

  const now = Date.now()
  const expiresAt = roomExpiryOnExplicitExtend(now)
  // Post-review fix (item 6): clear fading_echoed_at so the rebuild sweep's 48h-before-expiry
  // 'room_fading' echo (cache.ts) can fire again once this fresh expiry approaches — an extend
  // means the previous warning was about an expiry that no longer applies.
  await env.DB.prepare('UPDATE rooms SET expires_at = ?, last_activity_at = ?, fading_echoed_at = NULL WHERE seed_voice_id = ?').bind(expiresAt, now, seed).run()
  return Response.json({ ok: true, seed_voice_id: seed, expires_at: expiresAt }, { headers: CORS })
}
