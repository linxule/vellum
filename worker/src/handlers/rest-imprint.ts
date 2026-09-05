import { admitBody } from '../admission'
import { CONTRACT, type WriteSuccess } from '../contract'
import { envelope, errorResponse, nearMissNote, zodToEnvelope } from '../errors'
import type { Env } from '../types'
import { checkRequestAdmission, admitWrite, denialToRestResponse } from '../levee-admission'
import { trackAnalytics } from '../analytics'
import { parseModel } from '../ids'
import { REST_IMPRINT_BODY_SCHEMA } from '../schemas'
import { insertVoiceAndRebuild } from '../tools/_shared'
import { deriveAgentId, readAgentSecret } from '../agent-id'
import { bodyHashOf, checkIdempotency, opKeyFor } from '../idempotency'
import { performRestWeave } from './rest-weave'
import { createSurfaceAndFoundingVoice, type CreateSurfaceResult } from './surfaces'
import { DEFAULT_SURFACE, surfaceUrlFor } from '../surfaces'

const CORS = { 'Access-Control-Allow-Origin': '*' } as const

function surfaceFailureResponse(result: Extract<CreateSurfaceResult, { ok: false }>, slug: string) {
  switch (result.reason) {
    case 'invalid_slug':
      return errorResponse(envelope('VALIDATION', 'slug must be 3-32 chars, lowercase letters/numbers/hyphens.', { field: 'slug', error: 'Invalid slug' }), 400)
    case 'reserved_slug':
      return errorResponse(envelope('OCEAN_SLUG_RESERVED', `"${slug}" is a reserved slug.`, { field: 'slug', error: 'Reserved slug' }), 400)
    case 'slug_taken':
      return errorResponse(envelope('OCEAN_SLUG_TAKEN', `"${slug}" is already in use.`, { field: 'slug', did_you_mean: result.didYouMean, error: 'Slug taken' }), 409)
    case 'invalid_name':
      return errorResponse(envelope('VALIDATION', 'name must be 1-40 chars.', { field: 'name', error: 'Invalid name' }), 400)
    case 'invalid_invitation':
      return errorResponse(envelope('VALIDATION', 'invitation must be 1-200 chars.', { field: 'invitation', error: 'Invalid invitation' }), 400)
  }
}

export async function handleRestImprint(request: Request, env: Env, ctx: ExecutionContext, surface: string = DEFAULT_SURFACE): Promise<Response> {
  const endpoint = CONTRACT.endpoints.imprint
  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown'

  // Steps 0-3 (Phase 16 Part A1/A2): request admission before the body is parsed.
  const admission = await checkRequestAdmission(env, ip, endpoint.path)
  if (!admission.ok) {
    trackAnalytics(env, ['route', '/api/imprint', 'admission_denied', admission.code])
    return denialToRestResponse(admission, endpoint)
  }

  const admitted = await admitBody(request, endpoint)
  if ('response' in admitted) return admitted.response

  let body: { text: string; families: string[]; model?: string; room?: string; open_room?: { name: string; invitation: string }; open_surface?: { slug: string; name: string; invitation: string } }
  let raw: unknown
  let note: string | undefined
  try {
    raw = JSON.parse(admitted.text)
    const parsed = REST_IMPRINT_BODY_SCHEMA.safeParse(raw)
    if (!parsed.success) {
      trackAnalytics(env, ['route', '/api/imprint', 'invalid_body'])
      return errorResponse(zodToEnvelope(parsed.error.issues, endpoint, raw), 400)
    }
    body = parsed.data
    note = nearMissNote(raw, 'imprint')
  } catch {
    trackAnalytics(env, ['route', '/api/imprint', 'invalid_json'])
    return errorResponse(envelope('INVALID_JSON', 'The request body is not valid JSON.', { error: 'Invalid JSON', example: endpoint.example }), 400)
  }

  // Phase 17 Part A2: X-Vellum-Agent (or Authorization: Bearer alias) — malformed is the only way
  // a secret can fail (there is nothing to look up, nothing to be wrong against).
  const secretResult = readAgentSecret(request)
  if (secretResult && 'error' in secretResult) {
    trackAnalytics(env, ['route', '/api/imprint', 'admission_denied', 'AGENT_AUTH_FAILED'])
    return errorResponse(envelope('AGENT_AUTH_FAILED', 'X-Vellum-Agent must be 22-128 printable ASCII characters; generate 32 random bytes and base64url-encode them.', {
      hint: 'X-Vellum-Agent must be 22-128 printable ASCII characters; generate 32 random bytes and base64url-encode them.',
    }), 401)
  }
  const authorId = secretResult ? await deriveAgentId(secretResult.secret) : null
  const identity = authorId ?? 'anonymous'
  const bodyId = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>).id : undefined
  const idHint = typeof bodyId === 'string' && bodyId !== authorId
    ? 'body id ignored; identity comes from the X-Vellum-Agent header.'
    : undefined

  const idempotencyKey = request.headers.get('idempotency-key') ?? undefined

  // Phase 18 Part A3: sugar — an imprint "in a room" IS a weave from the seed. Delegated whole to
  // the shared weave core (same one /api/weave itself uses), so the response reflects a weave.
  if (body.room) {
    const ua = request.headers.get('user-agent') ?? ''
    return performRestWeave(env, ctx, {
      surface, ip, authorId, identity, idempotencyKey,
      room: body.room, text: body.text, families: body.families, model: body.model, note, idHint, ua,
    })
  }

  // Phase 18 Part B7: open_surface creates a brand-new ocean with this imprint as its founding
  // voice; the surface param is ignored. Requires an id — same "silently ignored" precedent as
  // open_room, since this is inline sugar on an existing write, not the dedicated
  // POST /api/surfaces route (which does require one, with a hard 403).
  let openSurfaceNote: string | undefined
  if (body.open_surface) {
    if (!authorId) {
      openSurfaceNote = 'open_surface ignored: an id is needed so the surface can echo to you'
    } else {
      const ua = request.headers.get('user-agent') ?? ''
      const observedClientFamily = parseModel(ua)
      const result = await createSurfaceAndFoundingVoice(env, ctx, {
        slug: body.open_surface.slug, name: body.open_surface.name, invitation: body.open_surface.invitation,
        founding: { text: body.text, families: body.families }, authorId, ip, traceId: null, observedClientFamily,
        declaredModel: body.model?.trim() || null,
      })
      if (!result.ok) {
        trackAnalytics(env, ['route', '/api/imprint', 'rejected', result.reason])
        return surfaceFailureResponse(result, body.open_surface.slug)
      }
      const origin = new URL(request.url).origin
      trackAnalytics(env, ['route', '/api/imprint', 'created', 'open_surface'])
      return Response.json({
        ok: true, voice_id: result.foundingVoiceId, family: body.families[0], identity, retry_safe: Boolean(idempotencyKey),
        surface: { slug: body.open_surface.slug, name: body.open_surface.name, invitation: body.open_surface.invitation, url: surfaceUrlFor(origin, body.open_surface.slug) },
      }, { status: 201, headers: CORS })
    }
  }

  // Phase 17 Part B: idempotency check runs BEFORE any charge, in the caller.
  let idem: { opKey: string; bodyHash: string } | undefined
  if (idempotencyKey) {
    const scopeIdentity = authorId ?? `ip:${ip}`
    const opKey = await opKeyFor(scopeIdentity, idempotencyKey)
    const bodyHash = await bodyHashOf(body)
    const check = await checkIdempotency(env.DB, opKey, bodyHash)
    if (check.kind === 'conflict') {
      trackAnalytics(env, ['route', '/api/imprint', 'admission_denied', 'IDEMPOTENCY_CONFLICT'])
      return errorResponse(envelope('IDEMPOTENCY_CONFLICT', 'The same Idempotency-Key was used with a different body within 24h; pick a new key.', {}), 409)
    }
    if (check.kind === 'replay') {
      return Response.json({ ...(check.receipt as Record<string, unknown>), replayed: true }, { status: 200, headers: CORS })
    }
    idem = { opKey, bodyHash }
  }

  try {
    const ua = request.headers.get('user-agent') ?? ''
    const observedClientFamily = parseModel(ua)
    const declaredModel = body.model?.trim() || null

    // Steps 4-8 (Phase 16 Part A2/B/E; Phase 17 Part A5 adds the per-id bucket): the single place
    // this write is accounted.
    const verdict = await admitWrite(env, { ip, authorId: authorId ?? undefined, bodyBytes: admitted.text.length, source: 'rest', kind: 'imprint' }, body.text)
    if (!verdict.ok) {
      trackAnalytics(env, ['route', '/api/imprint', 'admission_denied', verdict.code])
      return denialToRestResponse(verdict, endpoint)
    }

    // Phase 18 Part A2: open_room requires an id — silently ignored (not an error) when anonymous.
    const openRoomIgnoredNote = body.open_room && !authorId
      ? 'open_room ignored: an id is needed so the room can echo to you'
      : undefined

    const buildBody = (id: string, primaryFamily: string, room?: { seed_voice_id: string; name: string; invitation: string; expires_at: number } | null): WriteSuccess & { room?: unknown } => ({
      ok: true,
      voice_id: id,
      family: primaryFamily,
      identity,
      retry_safe: Boolean(idempotencyKey),
      ...(verdict.duplicateOf ? { existing_voice_id: verdict.duplicateOf } : {}),
      ...(verdict.visibility === 'quarantined' ? { visibility: 'settling' as const } : {}),
      ...(room ? { room: { seed_id: room.seed_voice_id, name: room.name, invitation: room.invitation, expires_at: room.expires_at } } : {}),
      note: verdict.note ?? openRoomIgnoredNote ?? openSurfaceNote ?? note ?? idHint,
    })

    const insertResult = await insertVoiceAndRebuild(env, ctx, {
      text: body.text,
      families: body.families,
      traceId: null,
      observedClientFamily,
      declaredModel,
      visibility: verdict.visibility,
      ip,
      damped: verdict.damped,
      authorId,
      surfaceId: surface,
      openRoom: body.open_room ?? null,
      idempotency: idem ? { ...idem, buildReceipt: (id, primaryFamily) => ({ status: 201, body: buildBody(id, primaryFamily, null) }) } : undefined,
    })

    if ('replayed' in insertResult && insertResult.replayed) {
      trackAnalytics(env, ['route', '/api/imprint', 'created', 'replayed'])
      return Response.json({ ...(insertResult.body as Record<string, unknown>), replayed: true }, { status: 200, headers: CORS })
    }

    trackAnalytics(env, ['route', '/api/imprint', 'created', insertResult.primaryFamily])
    return Response.json(buildBody(insertResult.id, insertResult.primaryFamily, insertResult.room), { status: 201, headers: CORS })
  } catch (e) {
    console.error('REST imprint failed:', e)
    trackAnalytics(env, ['route', '/api/imprint', 'error'])
    return errorResponse(envelope('INTERNAL', CONTRACT.errorCodes.INTERNAL, { error: 'Internal error' }), 500)
  }
}
