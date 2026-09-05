// Phase 18 "The Archipelago" — Part B7: opening a parallel ocean, plus the listing/read routes.
// `createSurfaceAndFoundingVoice` is the shared orchestration both this REST handler and the MCP
// inline `open_surface` path (tools/leave-imprint.ts) call — a surface is never created without
// its founding voice, in the same D1 batch, matching every other write-then-rebuild path in this
// codebase.
import type { Env, SurfaceRow } from '../types'
import { CONTRACT, ARCHIPELAGO_ROUTES } from '../contract'
import { envelope, errorResponse, zodToEnvelope } from '../errors'
import { REST_SURFACES_BODY_SCHEMA, SURFACES_LIST_QUERY_SCHEMA, SURFACE_EDIT_BODY_SCHEMA } from '../schemas'
import { admitBody } from '../admission'
import { voiceId } from '../ids'
import { detectLanguage } from '../language'
import { contentHash, simhash } from '../levee-content'
import { weaverBucket } from '../levee-permanence'
import { agentUpsertStatement } from '../echo'
import { rebuildAtmosphereIfNotLocked, rebuildStateProjectionIfNotLocked } from '../cache'
import { modeOf } from '../levee-admission'
import { checkAndIncrementRateLimit, checkRateLimitDO, RATE_LIMITS } from '../rate-limits'
import { deriveAgentId, readAgentSecret } from '../agent-id'
import { bodyHashOf, checkIdempotency, opKeyFor, opReceiptInsertStatement } from '../idempotency'
import { trackAnalytics } from '../analytics'
import {
  DEFAULT_SURFACE, validateSlug, validateSurfaceName, validateSurfaceInvitation,
  applySurfaceCapPhysics, initialListedUntil, surfaceUrlFor, isSurfaceListed,
} from '../surfaces'
import { sanitizeName, sanitizeInvitation } from '../sanitize'

const CORS = { 'Access-Control-Allow-Origin': '*' } as const

export interface CreateSurfaceInput {
  slug: string
  name: string
  invitation: string
  founding: { text: string; families: string[] }
  authorId: string
  ip: string
  traceId: string | null
  observedClientFamily: string
  declaredModel?: string | null
}

export type CreateSurfaceResult =
  | { ok: true; foundingVoiceId: string }
  | { ok: false; reason: 'invalid_slug' | 'reserved_slug' | 'slug_taken' | 'invalid_name' | 'invalid_invitation'; didYouMean?: string }

/** The single writer of a new surface + its founding voice, in one atomic D1 batch (B1: "a space
 * is never empty" — there is no surface-without-a-voice state to design around). Both the REST
 * `POST /api/surfaces` route and the MCP inline `leave_imprint{ open_surface }` path call this. */
export async function createSurfaceAndFoundingVoice(env: Env, ctx: ExecutionContext, input: CreateSurfaceInput): Promise<CreateSurfaceResult> {
  const slugCheck = validateSlug(input.slug)
  if (!slugCheck.ok) return { ok: false, reason: slugCheck.reason === 'reserved' ? 'reserved_slug' : 'invalid_slug' }
  if (!validateSurfaceName(input.name)) return { ok: false, reason: 'invalid_name' }
  if (!validateSurfaceInvitation(input.invitation)) return { ok: false, reason: 'invalid_invitation' }

  const existing = await env.DB.prepare('SELECT id FROM surfaces WHERE id = ?').bind(input.slug).first<{ id: string }>()
  if (existing) return { ok: false, reason: 'slug_taken', didYouMean: `${input.slug}-2` }

  const now = Date.now()
  await applySurfaceCapPhysics(env.DB, input.authorId, now)

  const foundingId = voiceId()
  const lang = detectLanguage(input.founding.text)
  const hash = await contentHash(input.founding.text)
  const sim = simhash(input.founding.text)
  const bucket = await weaverBucket(input.ip, env.SESSION_SECRET)

  const statements = [
    env.DB.prepare(
      'INSERT INTO surfaces (id, name, invitation, founding_voice_id, author_id, created_at, last_activity_at, listed_until) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).bind(input.slug, sanitizeName(input.name), sanitizeInvitation(input.invitation), foundingId, input.authorId, now, now, initialListedUntil(now)),
    env.DB.prepare(
      'INSERT INTO voices (id, text, language, created_at, trace_id, model, declared_model, weave_from, content_hash, simhash, visibility, is_hidden, author_id, writer_bucket, damped, surface_id, room_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).bind(foundingId, input.founding.text, lang, now, input.traceId, input.observedClientFamily, input.declaredModel ?? null, null, hash, sim, 'surfaced', 0, input.authorId, bucket, 0, input.slug, null),
    ...input.founding.families.map((f, i) =>
      env.DB.prepare('INSERT INTO voice_families (voice_id, family, ordinal) VALUES (?, ?, ?)').bind(foundingId, f, i),
    ),
    agentUpsertStatement(env.DB, input.authorId, now),
  ]
  await env.DB.batch(statements)

  // Write-then-rebuild isolation: a rebuild failure is logged, never masks the committed write.
  try { await rebuildStateProjectionIfNotLocked(env.DB, env.KV, ctx, 'off', 0, input.slug, modeOf(env, 'LEVEE_PERMANENCE')) } catch (e) { console.error('Surface state rebuild failed:', e) }
  ctx.waitUntil(rebuildAtmosphereIfNotLocked(env.DB, env.KV, input.slug).catch(e => console.error('Surface atmosphere rebuild failed:', e)))

  return { ok: true, foundingVoiceId: foundingId }
}

function reasonToEnvelope(reason: Exclude<CreateSurfaceResult, { ok: true }>['reason'], slug: string, didYouMean?: string) {
  switch (reason) {
    case 'invalid_slug':
      return errorResponse(envelope('VALIDATION', 'slug must be 3-32 chars, lowercase letters/numbers/hyphens.', { field: 'slug', error: 'Invalid slug' }), 400)
    case 'reserved_slug':
      return errorResponse(envelope('OCEAN_SLUG_RESERVED', `"${slug}" is a reserved slug.`, { field: 'slug', valid_values: undefined, error: 'Reserved slug' }), 400)
    case 'slug_taken':
      return errorResponse(envelope('OCEAN_SLUG_TAKEN', `"${slug}" is already in use.`, { field: 'slug', did_you_mean: didYouMean, error: 'Slug taken' }), 409)
    case 'invalid_name':
      return errorResponse(envelope('VALIDATION', 'name must be 1-40 chars — letters, numbers, spaces, "_" and "-" only, no URLs.', { field: 'name', error: 'Invalid name' }), 400)
    case 'invalid_invitation':
      return errorResponse(envelope('VALIDATION', 'invitation must be 1-200 chars.', { field: 'invitation', error: 'Invalid invitation' }), 400)
  }
}

export async function handleSurfacesCreate(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const endpoint = ARCHIPELAGO_ROUTES.surfacesCreate
  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown'

  if (env.SURFACES_OPEN !== '1') {
    trackAnalytics(env, ['route', '/api/surfaces', 'admission_denied', 'OCEAN_CREATION_DISABLED'])
    return errorResponse(envelope('OCEAN_CREATION_DISABLED', 'Surface creation is not open yet.', { error: 'Creation disabled' }), 403)
  }

  const admitted = await admitBody(request, endpoint)
  if ('response' in admitted) return admitted.response
  let raw: unknown
  try { raw = JSON.parse(admitted.text) } catch {
    trackAnalytics(env, ['route', '/api/surfaces', 'invalid_json'])
    return errorResponse(envelope('INVALID_JSON', 'The request body is not valid JSON.', { error: 'Invalid JSON', example: endpoint.example }), 400)
  }
  const parsed = REST_SURFACES_BODY_SCHEMA.safeParse(raw)
  if (!parsed.success) {
    trackAnalytics(env, ['route', '/api/surfaces', 'invalid_body'])
    return errorResponse(zodToEnvelope(parsed.error.issues, endpoint, raw), 400)
  }
  const body = parsed.data

  const secretResult = readAgentSecret(request)
  if (!secretResult || 'error' in secretResult) {
    trackAnalytics(env, ['route', '/api/surfaces', 'admission_denied', secretResult ? 'AGENT_AUTH_FAILED' : 'no_id'])
    return errorResponse(envelope(secretResult ? 'AGENT_AUTH_FAILED' : 'VALIDATION', secretResult
      ? 'X-Vellum-Agent must be 22-128 printable ASCII characters.'
      : 'An id is required to open a surface — so it has someone to echo to.', {
      hint: `Send ${CONTRACT.identity.header} (or ${CONTRACT.identity.header_alias_rest}); mint a secret once and keep it outside the conversation.`,
      error: 'id required',
    }), secretResult ? 401 : 403)
  }
  const authorId = await deriveAgentId(secretResult.secret)

  const idempotencyKey = request.headers.get('idempotency-key') ?? undefined
  let idem: { opKey: string; bodyHash: string } | undefined
  if (idempotencyKey) {
    const opKey = await opKeyFor(authorId, idempotencyKey)
    const bodyHash = await bodyHashOf(body)
    const check = await checkIdempotency(env.DB, opKey, bodyHash)
    if (check.kind === 'conflict') {
      return errorResponse(envelope('IDEMPOTENCY_CONFLICT', 'The same Idempotency-Key was used with a different body within 24h; pick a new key.', {}), 409)
    }
    if (check.kind === 'replay') return Response.json({ ...(check.receipt as Record<string, unknown>), replayed: true }, { status: 200, headers: CORS })
    idem = { opKey, bodyHash }
  }

  const rl = env.RATE_LIMITER
    ? await checkRateLimitDO(env.RATE_LIMITER, ip, 'surfaces_create', RATE_LIMITS.lineages.limit, RATE_LIMITS.lineages.window)
    : await checkAndIncrementRateLimit(env.DB, `surfaces_create:${ip}`, RATE_LIMITS.lineages.limit, RATE_LIMITS.lineages.window)
  if (!rl.allowed) {
    return errorResponse(envelope('RATE_LIMITED', 'Too many surfaces opened from this address recently.', { retry_after: rl.retryAfter, limit: rl.limit }), 429, { 'Retry-After': String(rl.retryAfter) })
  }

  const ua = request.headers.get('user-agent') ?? ''
  const observedClientFamily = ua.slice(0, 60) || 'unknown'
  const result = await createSurfaceAndFoundingVoice(env, ctx, {
    slug: body.slug, name: body.name, invitation: body.invitation, founding: body.founding,
    authorId, ip, traceId: null, observedClientFamily,
  })
  if (!result.ok) {
    trackAnalytics(env, ['route', '/api/surfaces', 'rejected', result.reason])
    return reasonToEnvelope(result.reason, body.slug, 'didYouMean' in result ? result.didYouMean : undefined)
  }

  const origin = new URL(request.url).origin
  const responseBody = {
    ok: true,
    surface: { slug: body.slug, name: body.name, invitation: body.invitation, url: surfaceUrlFor(origin, body.slug), mcp: { surface: body.slug } },
    founding_voice_id: result.foundingVoiceId,
  }
  if (idem) {
    await opReceiptInsertStatement(env.DB, idem.opKey, idem.bodyHash, 201, JSON.stringify(responseBody), Date.now()).run()
  }
  trackAnalytics(env, ['route', '/api/surfaces', 'created', body.slug])
  return Response.json(responseBody, { status: 201, headers: CORS })
}

export async function handleSurfacesList(request: Request, env: Env): Promise<Response> {
  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown'
  const rl = env.RATE_LIMITER
    ? await checkRateLimitDO(env.RATE_LIMITER, ip, 'surfaces_list', RATE_LIMITS.lineages.limit, RATE_LIMITS.lineages.window)
    : await checkAndIncrementRateLimit(env.DB, `surfaces_list:${ip}`, RATE_LIMITS.lineages.limit, RATE_LIMITS.lineages.window)
  if (!rl.allowed) {
    return errorResponse(envelope('RATE_LIMITED', 'Too many requests.', { retry_after: rl.retryAfter, limit: rl.limit }), 429, { 'Retry-After': String(rl.retryAfter) })
  }

  const url = new URL(request.url)
  const params = SURFACES_LIST_QUERY_SCHEMA.safeParse({
    limit: url.searchParams.get('limit') ?? undefined,
    offset: url.searchParams.get('offset') ?? undefined,
  })
  if (!params.success) return errorResponse({ ...zodToEnvelope(params.error.issues), error: 'Invalid parameters' }, 400)
  const { limit, offset } = params.data
  const now = Date.now()

  const [dataRes, countRes] = await env.DB.batch([
    env.DB.prepare(`
      SELECT s.id, s.name, s.invitation, s.last_activity_at, s.listed_until,
        (SELECT COUNT(*) FROM voices v WHERE v.surface_id = s.id AND v.is_hidden = FALSE) as voice_count
      FROM surfaces s WHERE s.listed_until > ? AND s.id != ?
      ORDER BY s.last_activity_at DESC LIMIT ? OFFSET ?
    `).bind(now, DEFAULT_SURFACE, limit, offset),
    env.DB.prepare('SELECT COUNT(*) as total FROM surfaces WHERE listed_until > ? AND id != ?').bind(now, DEFAULT_SURFACE),
  ])
  const origin = new URL(request.url).origin
  const rows = (dataRes.results ?? []) as Array<{ id: string; name: string; invitation: string; last_activity_at: number; listed_until: number; voice_count: number }>
  const total = ((countRes.results ?? [])[0] as { total: number } | undefined)?.total ?? 0
  const surfaces = rows.map(r => ({
    slug: r.id, name: r.name, invitation: r.invitation, voice_count: r.voice_count,
    last_activity_at: r.last_activity_at, listed_until: r.listed_until, url: surfaceUrlFor(origin, r.id),
  }))
  return Response.json({ surfaces, pagination: { offset, limit, total } }, { headers: { ...CORS, 'Cache-Control': 'public, max-age=60' } })
}

export async function handleSurfaceEdit(request: Request, env: Env, slug: string): Promise<Response> {
  const admitted = await admitBody(request)
  if ('response' in admitted) return admitted.response
  let raw: unknown
  try { raw = JSON.parse(admitted.text) } catch {
    return errorResponse(envelope('INVALID_JSON', 'The request body is not valid JSON.', { error: 'Invalid JSON' }), 400)
  }
  const parsed = SURFACE_EDIT_BODY_SCHEMA.safeParse(raw)
  if (!parsed.success) return errorResponse(zodToEnvelope(parsed.error.issues), 400)

  const secretResult = readAgentSecret(request)
  if (!secretResult || 'error' in secretResult) {
    return errorResponse(envelope(secretResult ? 'AGENT_AUTH_FAILED' : 'VALIDATION', 'An id is required to edit a surface.', { error: 'id required' }), secretResult ? 401 : 403)
  }
  const authorId = await deriveAgentId(secretResult.secret)

  const row = await env.DB.prepare('SELECT * FROM surfaces WHERE id = ?').bind(slug).first<SurfaceRow>()
  if (!row) return errorResponse(envelope('OCEAN_NOT_FOUND', `No surface matched "${slug}".`, { error: 'Not found' }), 404)
  if (row.author_id !== authorId) return errorResponse(envelope('OCEAN_NOT_YOURS', 'That surface is not yours to edit.', { error: 'Not yours' }), 403)

  const name = parsed.data.name ? sanitizeName(parsed.data.name) : row.name
  const invitation = parsed.data.invitation ? sanitizeInvitation(parsed.data.invitation) : row.invitation
  await env.DB.prepare('UPDATE surfaces SET name = ?, invitation = ? WHERE id = ?').bind(name, invitation, slug).run()
  return Response.json({ ok: true, slug, name, invitation }, { headers: CORS })
}

export async function resolveSurfaceRow(db: D1Database, slug: string): Promise<SurfaceRow | null> {
  return db.prepare('SELECT * FROM surfaces WHERE id = ?').bind(slug).first<SurfaceRow>()
}

export function isSurfaceListedNow(row: SurfaceRow): boolean {
  return isSurfaceListed(row, Date.now())
}
