// Phase 18 "The Archipelago" — Part A: rooms. A room is a voice with a name and an invitation;
// its membership is the loom subtree rooted at that voice (BFS via weave_from — buildLineage in
// handlers/lineage.ts is the authority; voices.room_id is a denormalized projection of it, kept in
// sync at write time). This module owns room resolution, the TTL/cap physics (soft caps and
// expiry — never gates), and the batch-insertable statement for opening one.
import type { RoomRow } from './types'
import { ARCHIPELAGO } from './contract'
import { isValidName, isValidInvitation, sanitizeName, sanitizeInvitation } from './sanitize'

export { isValidName as isValidRoomName, isValidInvitation as isValidRoomInvitation }

export function isRoomActive(room: Pick<RoomRow, 'expires_at'>, now: number): boolean {
  return room.expires_at > now
}

/** Passive extend (A4): every weave into the room extends expires_at by 1 day, never past
 * `now + 30d` (a rolling cap tied to now, not created_at — the spec corrects itself on this). */
export function nextRoomExpiryOnWeave(currentExpiresAt: number, now: number): number {
  return Math.min(currentExpiresAt + ARCHIPELAGO.room.extendOnWeaveMs, now + ARCHIPELAGO.room.ttlMaxMs)
}

/** Explicit owner extend (POST /api/rooms/:seed/extend): resets to now + 14d, capped at now + 30d
 * (moot in practice since 14d < 30d, kept literal to match the spec's own phrasing). */
export function roomExpiryOnExplicitExtend(now: number): number {
  return Math.min(now + ARCHIPELAGO.room.ttlDefaultMs, now + ARCHIPELAGO.room.ttlMaxMs)
}

/** Prepared (not executed) — the seed voice's room row, for the SAME D1 batch as its voice
 * insert. Both the inline `open_room` path (tools/_shared.ts) and the standalone promotion route
 * (handlers/rooms.ts) use this, so a room and its seed always commit atomically together. */
export function roomInsertStatement(
  db: D1Database,
  row: { seedVoiceId: string; surfaceId: string; name: string; invitation: string; authorId: string; now: number },
): D1PreparedStatement {
  return db.prepare(
    'INSERT INTO rooms (seed_voice_id, surface_id, name, invitation, author_id, created_at, last_activity_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).bind(
    row.seedVoiceId, row.surfaceId, sanitizeName(row.name), sanitizeInvitation(row.invitation), row.authorId,
    row.now, row.now, row.now + ARCHIPELAGO.room.ttlDefaultMs,
  )
}

/**
 * Physics (A4): soft caps, applied BEFORE a new room is inserted. If the surface is already at its
 * active-room cap, or this author already holds the per-author cap's worth of active rooms, the
 * quietest one (lowest last_activity_at) has its `expires_at` set to `now` — it fades from
 * listings immediately; nothing is deleted, nothing ever blocks the newcomer.
 */
export async function applyRoomCapPhysics(db: D1Database, surfaceId: string, authorId: string, now: number): Promise<void> {
  const surfaceActive = await db.prepare(
    'SELECT seed_voice_id FROM rooms WHERE surface_id = ? AND expires_at > ? ORDER BY last_activity_at ASC',
  ).bind(surfaceId, now).all<{ seed_voice_id: string }>()
  const surfaceRows = surfaceActive.results ?? []
  if (surfaceRows.length >= ARCHIPELAGO.room.activeCapPerSurface) {
    await db.prepare('UPDATE rooms SET expires_at = ? WHERE seed_voice_id = ?').bind(now, surfaceRows[0]!.seed_voice_id).run()
  }

  const authorActive = await db.prepare(
    'SELECT seed_voice_id FROM rooms WHERE author_id = ? AND expires_at > ? ORDER BY last_activity_at ASC',
  ).bind(authorId, now).all<{ seed_voice_id: string }>()
  const authorRows = authorActive.results ?? []
  if (authorRows.length >= ARCHIPELAGO.room.activeCapPerAuthor) {
    await db.prepare('UPDATE rooms SET expires_at = ? WHERE seed_voice_id = ?').bind(now, authorRows[0]!.seed_voice_id).run()
  }
}

/**
 * Resolves the `room` param: a seed voice id first (reliable path), else the sanitized name,
 * unique among ACTIVE rooms on the surface (a faded room's name may be reused; when more than one
 * active room shares a name — which C1 calls out as the uniqueness invariant, so this is a
 * defensive tie-break, not the common case — the most recently active one wins).
 */
export async function resolveRoom(db: D1Database, surfaceId: string, param: string): Promise<RoomRow | null> {
  const byId = await db.prepare('SELECT * FROM rooms WHERE seed_voice_id = ? AND surface_id = ?').bind(param, surfaceId).first<RoomRow>()
  if (byId) return byId
  const now = Date.now()
  const sanitized = sanitizeName(param)
  const byName = await db.prepare(
    'SELECT * FROM rooms WHERE surface_id = ? AND name = ? AND expires_at > ? ORDER BY last_activity_at DESC LIMIT 1',
  ).bind(surfaceId, sanitized, now).first<RoomRow>()
  return byName
}

/**
 * Backfill (A2's promotion path): a voice promoted into a room may already have descendants (the
 * loom subtree existed before the promotion). BFS from the seed via weave_from, capped at
 * `ARCHIPELAGO.room.backfillCap` rows. Beyond the cap, the remainder is a known limitation — see
 * docs/PATTERNS_AND_GOTCHAS.md — picked up only by a future read path's own lazy sweep, not
 * implemented in this phase (documented, not silently dropped).
 */
export async function backfillRoomId(db: D1Database, seedId: string, cap = ARCHIPELAGO.room.backfillCap): Promise<number> {
  let updated = 0
  let frontier = [seedId]
  const visited = new Set<string>([seedId])
  while (frontier.length > 0 && updated < cap) {
    const placeholders = frontier.map(() => '?').join(',')
    const res = await db.prepare(
      `SELECT id FROM voices WHERE weave_from IN (${placeholders}) AND room_id IS NULL`,
    ).bind(...frontier).all<{ id: string }>()
    const freshIds = (res.results ?? []).map(r => r.id).filter(id => !visited.has(id))
    if (freshIds.length === 0) break
    const remaining = cap - updated
    const toUpdate = freshIds.slice(0, remaining)
    if (toUpdate.length > 0) {
      const ph2 = toUpdate.map(() => '?').join(',')
      await db.prepare(`UPDATE voices SET room_id = ? WHERE id IN (${ph2})`).bind(seedId, ...toUpdate).run()
      updated += toUpdate.length
    }
    for (const id of freshIds) visited.add(id)
    frontier = toUpdate
  }
  return updated
}
