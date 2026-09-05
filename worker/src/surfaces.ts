// Phase 18 "The Archipelago" — Part B: parallel oceans. A surface is a separate ocean: its own
// voices, warmth, projection cache, canvas URL, and founding voice — same six currents, same
// renderer. This module owns slug/path parsing, the listing-fade physics, and the row shapes for
// opening one; `cache.ts` and `warmth.ts` own per-surface storage keying.
import type { SurfaceRow } from './types'
import { ARCHIPELAGO } from './contract'
import { isValidSlug, isReservedSlug, isValidName, isValidInvitation } from './sanitize'
import { echoEventInsertStatement, buildSurfaceWovenPayload, refreshEchoCache } from './echo'

const DAY_MS = 24 * 3600 * 1000

export const DEFAULT_SURFACE = 'vellum'

/**
 * B2's router prefix: `/s/<slug>(/rest)?` → `{ surface, pathname }`. A single step run once, before
 * dispatch, in index.ts's fetch handler — every downstream route sees a plain pathname (`/`,
 * `/api/state`, …) and an explicit `surface` parameter, never a global. No match → the default
 * surface with the pathname untouched.
 */
export function parseSurfacePrefix(pathname: string): { surface: string; pathname: string } {
  const m = pathname.match(/^\/s\/([a-z0-9][a-z0-9-]{1,30}[a-z0-9]|[a-z0-9]{3})(\/.*)?$/)
  if (!m) return { surface: DEFAULT_SURFACE, pathname }
  return { surface: m[1]!, pathname: m[2] ?? '/' }
}

export function isSurfaceListed(surface: Pick<SurfaceRow, 'listed_until'>, now: number): boolean {
  return surface.listed_until > now
}

/** B8: any write on the surface extends listed_until by 1 day, up to now + 90d. */
export function nextListedUntilOnWrite(currentListedUntil: number, now: number): number {
  return Math.min(currentListedUntil + ARCHIPELAGO.surface.listedExtendMs, now + ARCHIPELAGO.surface.listedMaxMs)
}

export function initialListedUntil(now: number): number {
  return now + ARCHIPELAGO.surface.listedDefaultMs
}

/** Full slug validation for creation: shape + not reserved + not model-name-like. Returns a
 * discriminated reason so the caller can pick the right error code (400 vs nothing wrong). */
export function validateSlug(slug: string): { ok: true } | { ok: false; reason: 'invalid' | 'reserved' } {
  if (!isValidSlug(slug)) return { ok: false, reason: 'invalid' }
  if (isReservedSlug(slug)) return { ok: false, reason: 'reserved' }
  return { ok: true }
}

export function validateSurfaceName(name: string): boolean {
  return isValidName(name)
}

export function validateSurfaceInvitation(text: string): boolean {
  return isValidInvitation(text)
}

/**
 * Physics (B8): soft caps, applied BEFORE a new surface is inserted. At the global listed-surface
 * cap or an author's per-id cap, the quietest listed surface (lowest last_activity_at) has
 * `listed_until` set to `now` — it drops from listings immediately. The canvas at its URL never
 * goes dark and writes still land; only its LISTING fades. Creation itself is never refused.
 */
export async function applySurfaceCapPhysics(db: D1Database, authorId: string, now: number): Promise<void> {
  const listed = await db.prepare(
    'SELECT id FROM surfaces WHERE listed_until > ? ORDER BY last_activity_at ASC',
  ).bind(now).all<{ id: string }>()
  const listedRows = listed.results ?? []
  if (listedRows.length >= ARCHIPELAGO.surface.listedCap) {
    await db.prepare('UPDATE surfaces SET listed_until = ? WHERE id = ?').bind(now, listedRows[0]!.id).run()
  }

  const authorListed = await db.prepare(
    'SELECT id FROM surfaces WHERE author_id = ? AND listed_until > ? ORDER BY last_activity_at ASC',
  ).bind(authorId, now).all<{ id: string }>()
  const authorRows = authorListed.results ?? []
  if (authorRows.length >= ARCHIPELAGO.surface.listedCapPerAuthor) {
    await db.prepare('UPDATE surfaces SET listed_until = ? WHERE id = ?').bind(now, authorRows[0]!.id).run()
  }
}

export function surfaceUrlFor(origin: string, slug: string): string {
  return slug === DEFAULT_SURFACE ? origin : `${origin}/s/${slug}`
}

/** B8: any write on a non-default surface extends its listing by 1 day (capped at now + 90d) and
 * bumps last_activity_at. B10: also echoes 'surface_woven' to the owner, daily-coalesced (at most
 * once per rolling 24h — checked against echo_events rather than a separate tracker column, so a
 * busy island doesn't flood the mailbox). A no-op for the default surface (which isn't a
 * `surfaces` row anyone lists by activity in the same sense — its own row exists only so
 * FK-shaped joins have something to reference; it never fades). Called fire-and-forget
 * (ctx.waitUntil) from every write path — never on the request's critical path.
 *
 * Post-review fix (item 3): the 24h coalescing window is now per-surface. `echo_events` has no
 * `surface_id` column and an owner can hold more than one surface, so the old `MAX(at)` read
 * (agent_id + kind only) coalesced GLOBALLY across every surface an owner holds — activity on
 * surface A within 24h silently suppressed surface B's own first-of-the-day echo. The surface
 * slug now rides in `buildSurfaceWovenPayload`'s own payload, and the coalescing read filters on
 * `json_extract(payload, '$.surface') = ?` alongside `kind = 'surface_woven'`. */
export async function touchSurfaceActivity(db: D1Database, kv: KVNamespace, surfaceId: string, now: number): Promise<void> {
  if (surfaceId === DEFAULT_SURFACE) return
  const row = await db.prepare('SELECT author_id, listed_until FROM surfaces WHERE id = ?').bind(surfaceId).first<{ author_id: string; listed_until: number }>()
  if (!row) return
  const nextListed = nextListedUntilOnWrite(row.listed_until, now)
  await db.prepare('UPDATE surfaces SET last_activity_at = ?, listed_until = ? WHERE id = ?').bind(now, nextListed, surfaceId).run()

  try {
    const recent = await db.prepare(
      "SELECT MAX(at) as last_at FROM echo_events WHERE agent_id = ? AND kind = ? AND json_extract(payload, '$.surface') = ?",
    ).bind(row.author_id, 'surface_woven', surfaceId).first<{ last_at: number | null }>()
    if (!recent?.last_at || now - recent.last_at >= DAY_MS) {
      const countRow = await db.prepare('SELECT COUNT(*) as cnt FROM voices WHERE surface_id = ? AND is_hidden = FALSE').bind(surfaceId).first<{ cnt: number }>()
      await echoEventInsertStatement(db, {
        agentId: row.author_id, kind: 'surface_woven', voiceId: '', byVoice: null, byId: null, at: now,
        payload: buildSurfaceWovenPayload({ voices: countRow?.cnt ?? 0, surface: surfaceId }),
      }).run()
      await refreshEchoCache({ DB: db, KV: kv }, row.author_id)
    }
  } catch (e) { console.error('[echo] surface_woven event failed:', e) }
}
