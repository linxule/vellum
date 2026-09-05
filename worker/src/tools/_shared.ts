import type { Env } from '../types'
import { voiceId } from '../ids'
import { detectLanguage } from '../language'
import { withRetry } from '../helpers'
import { rebuildAtmosphereIfNotLocked, rebuildStateProjectionIfNotLocked } from '../cache'
import { modeOf } from '../levee-admission'
import { contentHash, simhash } from '../levee-content'
import { weaverBucket } from '../levee-permanence'
import { agentUpsertStatement } from '../echo'
import { opReceiptInsertStatement } from '../idempotency'
import { roomInsertStatement, applyRoomCapPhysics } from '../rooms'
import { DEFAULT_SURFACE, touchSurfaceActivity } from '../surfaces'
import { sanitizeName, sanitizeInvitation } from '../sanitize'
import { ARCHIPELAGO } from '../contract'

export interface IdempotentInsert {
  opKey: string
  bodyHash: string
  /** Called AFTER the voice id is minted, so the stored receipt can carry it. Must return the
   * exact success body this write's caller will also return on its first (non-replayed) success —
   * the two are never allowed to drift, since a later replay serves this verbatim. */
  buildReceipt: (id: string, primaryFamily: string) => { status: number; body: unknown }
}

export interface OpenedRoom { seed_voice_id: string; name: string; invitation: string; expires_at: number }

export type InsertVoiceResult =
  | { id: string; primaryFamily: string; replayed?: false; room?: OpenedRoom | null }
  | { replayed: true; status: number; body: unknown }

export async function insertVoiceAndRebuild(
  env: Env,
  ctx: ExecutionContext,
  input: {
    text: string
    families: string[]
    traceId: string | null
    observedClientFamily: string
    declaredModel: string | null
    /** Phase 16 Part E — defaults 'surfaced'; only ever 'quarantined' while LEVEE_FUSE is on. */
    visibility?: 'surfaced' | 'quarantined'
    /** Post-review fix (item 2) — the caller's IP, hashed into writer_bucket at insert. */
    ip: string
    /** Post-review fix (item 4) — a 'near' duplicate classification from admitWrite's step 4. */
    damped?: boolean
    /** Phase 17 Part A4 — NULL/omitted = anonymous. */
    authorId?: string | null
    /** Phase 18 Part B — which ocean this voice belongs to. Defaults to the default ocean. */
    surfaceId?: string
    /** Phase 18 Part A2: this write becomes a room seed — requires authorId (an unowned space
     * cannot be told what happened to it). When authorId is absent this is silently ignored (not
     * an error) and the caller is expected to surface the "an id is needed" note itself. */
    openRoom?: { name: string; invitation: string } | null
    /** Phase 17 Part B — when present, the op_receipts insert rides in the SAME batch as the
     * voice insert; a PK collision (concurrent identical retries) fails the whole batch and the
     * caller re-reads + replays the winner's receipt. */
    idempotency?: IdempotentInsert
  },
): Promise<InsertVoiceResult> {
  const id = voiceId()
  const lang = detectLanguage(input.text)
  const now = Date.now()
  const primaryFamily = input.families[0]
  const visibility = input.visibility ?? 'surfaced'
  const surfaceId = input.surfaceId ?? DEFAULT_SURFACE
  // Phase 16 Part B: computed unconditionally so future duplicate lookups always have hashes to
  // compare against, even on a write made while LEVEE_DEDUPE was off.
  const hash = await contentHash(input.text)
  const sim = simhash(input.text)
  const bucket = await weaverBucket(input.ip, env.SESSION_SECRET)

  // Phase 18 Part A2: open_room requires an id — this write becomes the room's seed, and its own
  // room_id points to itself (every read site that inherits room_id from a source relies on the
  // seed's own row already carrying it, so a weave never needs to special-case "is my source a
  // seed?" separately from "does my source have a room_id?").
  const opensRoom = Boolean(input.openRoom && input.authorId)
  if (opensRoom) await applyRoomCapPhysics(env.DB, surfaceId, input.authorId!, now)

  const statements = [
    env.DB.prepare(
      'INSERT INTO voices (id, text, language, created_at, trace_id, model, declared_model, weave_from, content_hash, simhash, visibility, is_hidden, author_id, writer_bucket, damped, surface_id, room_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(id, input.text, lang, now, input.traceId, input.observedClientFamily, input.declaredModel, null, hash, sim, visibility, visibility !== 'surfaced' ? 1 : 0, input.authorId ?? null, bucket, input.damped ? 1 : 0, surfaceId, opensRoom ? id : null),
    ...input.families.map((family, ordinal) =>
      env.DB.prepare(
        'INSERT INTO voice_families (voice_id, family, ordinal) VALUES (?, ?, ?)'
      ).bind(id, family, ordinal)
    ),
    ...(input.authorId ? [agentUpsertStatement(env.DB, input.authorId, now)] : []),
    ...(opensRoom ? [roomInsertStatement(env.DB, {
      seedVoiceId: id, surfaceId, name: input.openRoom!.name, invitation: input.openRoom!.invitation, authorId: input.authorId!, now,
    })] : []),
  ]
  if (input.idempotency) {
    const { status, body } = input.idempotency.buildReceipt(id, primaryFamily)
    statements.push(opReceiptInsertStatement(env.DB, input.idempotency.opKey, input.idempotency.bodyHash, status, JSON.stringify(body), now))
  }

  try {
    await withRetry(() => env.DB.batch(statements))
  } catch (e) {
    // Op-receipt PK collision: a concurrent identical retry landed first (Part B, acceptance B3).
    // Re-read the winner's receipt and replay it rather than surfacing a raw constraint error —
    // the loser never inserts a second voice.
    if (input.idempotency && isUniqueConstraintError(e)) {
      const winner = await env.DB.prepare('SELECT status, receipt FROM op_receipts WHERE op_key = ?')
        .bind(input.idempotency.opKey).first<{ status: number; receipt: string }>()
      if (winner) {
        return { replayed: true, status: winner.status, body: JSON.parse(winner.receipt) }
      }
    }
    throw e
  }

  // KNOWN: contention-acceptable — see PATTERNS_AND_GOTCHAS § Cache contention
  try { await rebuildStateProjectionIfNotLocked(env.DB, env.KV, ctx, env.LEVEE_REBUILD ?? 'off', 0, surfaceId, modeOf(env, 'LEVEE_PERMANENCE')) } catch (e) { console.error('State rebuild failed:', e) }
  ctx.waitUntil(rebuildAtmosphereIfNotLocked(env.DB, env.KV, surfaceId).catch(e => console.error('Atmosphere rebuild failed:', e)))
  // Phase 18 Part B8: any write on a non-default surface extends its listing.
  ctx.waitUntil(touchSurfaceActivity(env.DB, env.KV, surfaceId, now).catch(e => console.error('Surface activity touch failed:', e)))

  return {
    id, primaryFamily,
    room: opensRoom ? { seed_voice_id: id, name: sanitizeName(input.openRoom!.name), invitation: sanitizeInvitation(input.openRoom!.invitation), expires_at: now + ARCHIPELAGO.room.ttlDefaultMs } : null,
  }
}

function isUniqueConstraintError(e: unknown): boolean {
  const message = e instanceof Error ? e.message : String(e)
  return /unique|constraint/i.test(message)
}
