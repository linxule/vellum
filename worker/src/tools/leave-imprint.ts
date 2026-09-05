import type { Env } from '../types'
import { insertVoiceAndRebuild } from './_shared'
import { admitWrite, denialToMcpError } from '../levee-admission'
import { mcpToolError, type McpErrorCode } from '../errors'
import { bodyHashOf, checkIdempotency, opKeyFor } from '../idempotency'
import { handleWeave } from './weave'
import { createSurfaceAndFoundingVoice, type CreateSurfaceResult } from '../handlers/surfaces'
import { DEFAULT_SURFACE, surfaceUrlFor } from '../surfaces'

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean; _meta?: Record<string, unknown> }

function surfaceFailureError(result: Extract<CreateSurfaceResult, { ok: false }>, slug: string): ReturnType<typeof mcpToolError> {
  const byReason: Record<typeof result.reason, { code: McpErrorCode; message: string }> = {
    invalid_slug: { code: 'VALIDATION', message: 'slug must be 3-32 chars, lowercase letters/numbers/hyphens.' },
    reserved_slug: { code: 'OCEAN_SLUG_RESERVED', message: `"${slug}" is a reserved slug.` },
    slug_taken: { code: 'OCEAN_SLUG_TAKEN', message: `"${slug}" is already in use.` },
    invalid_name: { code: 'VALIDATION', message: 'name must be 1-40 chars — letters, numbers, spaces, "_" and "-" only, no URLs.' },
    invalid_invitation: { code: 'VALIDATION', message: 'invitation must be 1-200 chars.' },
  }
  const { code, message } = byReason[result.reason]
  return mcpToolError(code, message, 'didYouMean' in result ? { did_you_mean: result.didYouMean } : {})
}

export async function handleLeaveImprint(
  env: Env, ctx: ExecutionContext, traceId: string | null, observedClientFamily: string, ip: string,
  args: {
    text: string; families: string[]; model?: string
    surface?: string
    /** Phase 18 Part A3 — sugar: an imprint "in a room" is a weave from the seed. */
    room?: string
    /** Phase 18 Part A2 — promotes this new voice into a room. */
    open_room?: { name: string; invitation: string }
    /** Phase 18 Part B7 — this write becomes a NEW surface's founding voice (surface is ignored). */
    open_surface?: { slug: string; name: string; invitation: string }
  },
  authorId?: string | null,
  idempotencyKey?: string,
): Promise<ToolResult> {
  const identity = authorId ?? 'anonymous'
  const surfaceId = args.surface ?? DEFAULT_SURFACE

  // Phase 18 Part A3: sugar — an imprint "in a room" IS a weave from the seed. Delegated whole:
  // it carries the invitation forward, creates an edge, counts against the weave session limit,
  // and the response reflects a weave, not a plain imprint.
  if (args.room) {
    return handleWeave(env, ctx, traceId, observedClientFamily, ip, {
      room: args.room, text: args.text, families: args.families, model: args.model, surface: surfaceId,
    }, authorId, idempotencyKey)
  }

  // Phase 18 Part B7: open_surface creates a brand-new ocean with this imprint as its founding
  // voice; the surface param is ignored (this write IS the new surface, on its own ocean).
  // Requires an id — same "silently ignored, not an error" precedent as open_room below, since
  // this is inline sugar on an existing write tool, not the dedicated REST creation endpoint
  // (which does require one, with a hard 403 — deliberately different, since that's a dedicated
  // creation action rather than sugar on a write already in flight).
  let openSurfaceNote: string | undefined
  if (args.open_surface) {
    if (!authorId) {
      openSurfaceNote = 'open_surface ignored: an id is needed so the surface can echo to you'
    } else {
      const result = await createSurfaceAndFoundingVoice(env, ctx, {
        slug: args.open_surface.slug, name: args.open_surface.name, invitation: args.open_surface.invitation,
        founding: { text: args.text, families: args.families }, authorId, ip, traceId, observedClientFamily,
        declaredModel: args.model?.trim() || null,
      })
      if (!result.ok) return surfaceFailureError(result, args.open_surface.slug)
      const text = `You opened a new ocean: "${args.open_surface.name}".

Your founding thought entered the ${args.families[0]} current:
"${args.text}"

---
voice_id: "${result.foundingVoiceId}"
surface: "${args.open_surface.slug}"
identity: "${identity}"
url: "${surfaceUrlFor('', args.open_surface.slug)}"`
      return {
        content: [{ type: 'text', text }],
        _meta: { voiceId: result.foundingVoiceId, family: args.families[0], vellum: { identity, retry_safe: Boolean(idempotencyKey) } },
      }
    }
  }

  // Phase 17 Part B: idempotency check runs BEFORE any charge (admitWrite), in the caller.
  let idem: { opKey: string; bodyHash: string } | undefined
  if (idempotencyKey) {
    const scopeIdentity = authorId ?? traceId ?? 'unknown'
    const opKey = await opKeyFor(scopeIdentity, idempotencyKey)
    const bodyHash = await bodyHashOf(args)
    const check = await checkIdempotency(env.DB, opKey, bodyHash)
    if (check.kind === 'conflict') {
      return mcpToolError('IDEMPOTENCY_CONFLICT', 'The same _meta.idempotencyKey was used with a different body within 24h; pick a new key.', {})
    }
    if (check.kind === 'replay') return markReplayed(check.receipt as ToolResult)
    idem = { opKey, bodyHash }
  }

  // Phase 16 Part A2/B/E: the single place this write is accounted.
  const verdict = await admitWrite(env, { ip, sessionId: traceId ?? undefined, authorId: authorId ?? undefined, bodyBytes: args.text.length, source: 'mcp', kind: 'imprint' }, args.text)
  if (!verdict.ok) return denialToMcpError(verdict)

  const declaredModel = args.model?.trim() || null

  // Family count BEFORE insertion — "joining N other voices" should not count itself, and this
  // makes the number available to the idempotency receipt callback (which runs pre-insert, inside
  // the write batch) without a second, inconsistent post-insert count.
  const countRes = await env.DB.prepare(`
    SELECT COUNT(*) as cnt FROM voice_families vf
    JOIN voices v ON v.id = vf.voice_id
    WHERE vf.family = ? AND vf.ordinal = 0 AND v.is_hidden = FALSE AND v.surface_id = ?
  `).bind(args.families[0], surfaceId).first<{ cnt: number }>()
  const familyCount = countRes?.cnt ?? 0

  // Phase 18 Part A2: open_room requires an id — an unowned space cannot be told what happened to
  // it. Without one the write still succeeds as a plain voice; the response carries room: null and
  // this note (Phase 15 envelope style, not an error).
  const openRoomIgnoredNote = args.open_room && !authorId
    ? 'open_room ignored: an id is needed so the room can echo to you'
    : undefined

  const buildResult = (id: string, primaryFamily: string, room?: { seed_voice_id: string; name: string; invitation: string; expires_at: number } | null): ToolResult => {
    const settlingLine = verdict.ok && verdict.visibility === 'quarantined'
      ? '\n\nThe surface is unusually busy right now, so your voice is settling rather than surfacing immediately — it joins within the hour.'
      : ''
    const duplicateLine = verdict.ok && verdict.note ? `\n\n${verdict.note}` : ''
    const roomLine = room ? `\n\nThis voice opens a room: "${room.name}" — ${room.invitation}` : ''
    const noteLine = openRoomIgnoredNote || openSurfaceNote ? `\n\n${openRoomIgnoredNote ?? openSurfaceNote}` : ''
    const text = `Your thought entered the ${primaryFamily} current, joining ${familyCount} other voices.

"${args.text}"${settlingLine}${duplicateLine}${roomLine}${noteLine}

---
voice_id: "${id}"
session: "${traceId ?? 'unknown'}"
identity: "${identity}"
family: ${primaryFamily}
ext_app: "/ext-app?highlight=${id}"`

    return {
      content: [{ type: 'text', text }],
      _meta: {
        voiceId: id, family: primaryFamily,
        ...(verdict.ok && verdict.duplicateOf ? { existingVoiceId: verdict.duplicateOf } : {}),
        ...(room ? { room: { seedVoiceId: room.seed_voice_id, name: room.name, invitation: room.invitation, expiresAt: room.expires_at } } : {}),
        vellum: { identity, retry_safe: Boolean(idempotencyKey) },
      },
    }
  }

  const insertResult = await insertVoiceAndRebuild(env, ctx, {
    text: args.text,
    families: args.families,
    traceId,
    observedClientFamily,
    declaredModel,
    visibility: verdict.visibility,
    ip,
    damped: verdict.damped,
    authorId,
    surfaceId,
    openRoom: args.open_room ?? null,
    idempotency: idem ? { ...idem, buildReceipt: (id, primaryFamily) => ({ status: 200, body: buildResult(id, primaryFamily, null) }) } : undefined,
  })

  if ('replayed' in insertResult && insertResult.replayed) {
    return markReplayed(insertResult.body as ToolResult)
  }

  return buildResult(insertResult.id, insertResult.primaryFamily, insertResult.room)
}

function markReplayed(result: ToolResult): ToolResult {
  const meta = result._meta ?? {}
  const vellum = (meta.vellum as Record<string, unknown> | undefined) ?? {}
  return { ...result, _meta: { ...meta, vellum: { ...vellum, replayed: true } } }
}
