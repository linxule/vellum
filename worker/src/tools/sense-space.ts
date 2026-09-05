import { mcpToolError } from '../errors'
import type { Env, AtmosphereData, VoiceRow } from '../types'
import { getWarmthMap } from '../warmth'
import { computeMood, warmthDesc } from '../prose'
import { yamlEscape } from '../helpers'
import { readAtmosphereCache, rebuildAtmosphere } from '../cache'
import { buildLineage } from '../handlers/lineage'
import { checkAndIncrementSession } from '../rate-limits'
import { sanitizeQuoted } from '../quoted'
import { isAgentId } from '../agent-id'
import { fetchEchoEventsRecent, fetchDebts, renderEchoLines } from '../echo'
import { ARCHIPELAGO } from '../contract'
import { DEFAULT_SURFACE } from '../surfaces'

/** Phase 18 Part A5/B4 — up to 5 most active surfaces other than the default ocean, each with a
 * live voice count. Shared by the normal `surfaces:` block and the `surface: "?"` sentinel. */
async function listActiveSurfaces(db: D1Database, now: number, limit = ARCHIPELAGO.surface.senseSpaceBlockCap) {
  const res = await db.prepare(`
    SELECT s.id, s.name, s.invitation, s.last_activity_at,
      (SELECT COUNT(*) FROM voices v WHERE v.surface_id = s.id AND v.is_hidden = FALSE) as voice_count
    FROM surfaces s
    WHERE s.listed_until > ? AND s.id != ?
    ORDER BY s.last_activity_at DESC LIMIT ?
  `).bind(now, DEFAULT_SURFACE, limit).all<{ id: string; name: string; invitation: string; last_activity_at: number; voice_count: number }>()
  return res.results ?? []
}

function renderSurfacesBlock(surfaces: { id: string; name: string; invitation: string; voice_count: number }[]): string {
  if (surfaces.length === 0) return ''
  const lines = surfaces.map(s => `  - { slug: "${s.id}", name: "${yamlEscape(s.name)}", voice_count: ${s.voice_count}, invitation: "${yamlEscape(s.invitation)}" }`).join('\n')
  return `\n  surfaces:\n${lines}`
}

/** Phase 18 Part A5 — up to 5 active rooms on the surface, name/seed/member-count/expires-in. */
async function listActiveRooms(db: D1Database, surface: string, now: number, limit = ARCHIPELAGO.room.senseSpaceBlockCap) {
  const res = await db.prepare(`
    SELECT seed_voice_id, name, invitation, expires_at
    FROM rooms WHERE surface_id = ? AND expires_at > ?
    ORDER BY last_activity_at DESC LIMIT ?
  `).bind(surface, now, limit).all<{ seed_voice_id: string; name: string; invitation: string; expires_at: number }>()
  const rooms = res.results ?? []
  if (rooms.length === 0) return []
  const withMembers = await Promise.all(rooms.map(async r => {
    const countRow = await db.prepare('SELECT COUNT(*) as cnt FROM voices WHERE room_id = ? AND is_hidden = FALSE').bind(r.seed_voice_id).first<{ cnt: number }>()
    return { ...r, member_count: countRow?.cnt ?? 0 }
  }))
  return withMembers
}

function renderRoomsBlock(rooms: { seed_voice_id: string; name: string; invitation: string; expires_at: number; member_count: number }[], now: number): string {
  if (rooms.length === 0) return ''
  const lines = rooms.map(r => {
    const expiresInH = Math.max(0, Math.round((r.expires_at - now) / 3_600_000))
    return `  - { seed: "${r.seed_voice_id}", name: "${yamlEscape(r.name)}", members: ${r.member_count}, expires_in_h: ${expiresInH} }`
  }).join('\n')
  return `\n  rooms:\n${lines}`
}

const FAMILY_COLORS: Record<string, string> = {
  attention: 'cyan',
  silence: 'blue-violet',
  space: 'teal',
  ephemeral: 'lavender',
  memory: 'green',
  light: 'gold',
}

// Primary model from a possibly-compound declared string
// ('kimi-k2.6 · relayed by claude-fable-5' → 'kimi-k2.6'). Same rule as the
// renderer's primaryModelOf (src/loom/model-registry.ts) — worker has no
// dependency on renderer code, so it's reimplemented here, trivially.
// declared_model is attacker-controlled free text that flows into OTHER
// sessions' responses (via echo_trace) — collapse all whitespace (incl.
// newlines, which could fake response structure) and hard-cap the length.
function primaryModelOf(declared: string): string {
  const primary = (declared.split('·')[0] ?? declared).trim()
  return sanitizeQuoted(primary, 60)
}

export async function handleSenseSpace(
  env: Env, ctx: ExecutionContext, traceId: string | null,
  args: { echo_trace?: string; seed_voice_id?: string; lineage_depth: number; surface?: string },
  authorId?: string | null,
): Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean; _meta?: Record<string, unknown> }> {
  const surface = args.surface ?? DEFAULT_SURFACE

  // Phase 18 Part B4: the "?" sentinel lists other oceans instead of resolving one — cheaper than
  // a seventh tool, and the only MCP-visible way to discover what's open.
  if (surface === '?') {
    const surfaces = await listActiveSurfaces(env.DB, Date.now())
    if (surfaces.length === 0) {
      return { content: [{ type: 'text', text: 'No other oceans are open right now.\n\n---\ndata:\n  surfaces: []' }] }
    }
    const lines = surfaces.map(s => `  "${s.name}" (/s/${s.id}) — ${s.voice_count} voices. ${s.invitation}`).join('\n')
    return { content: [{ type: 'text', text: `Other oceans:\n\n${lines}\n\n---\ndata:${renderSurfacesBlock(surfaces)}` }] }
  }

  let atmosphere = await readAtmosphereCache(env.KV, surface)
  if (!atmosphere) {
    await rebuildAtmosphere(env.DB, env.KV, surface)
    atmosphere = await readAtmosphereCache(env.KV, surface)
  }

  // Fallback if no atmosphere cached yet
  if (!atmosphere) {
    return {
      content: [{ type: 'text', text: 'The Pensieve is new. No voices yet.\n\n---\ndata:\n  total_voices: 0\n  session: "' + (traceId ?? 'unknown') + '"' }],
    }
  }

  // Overlay live warmth values from D1 so human witnessing is visible immediately.
  const liveWarmth = await getWarmthMap(env.DB, surface)
  let totalRecent = 0
  const families = Object.fromEntries(
    Object.entries(atmosphere.families).map(([name, data]) => {
      totalRecent += data.recent_24h
      return [name, { ...data, warmth: liveWarmth[name] ?? 0 }]
    }),
  ) as AtmosphereData['families']
  const mood = computeMood(families, totalRecent)

  // Build family lines
  const familyLines = Object.entries(families)
    .map(([name, data]) => {
      const color = FAMILY_COLORS[name] ?? name
      const woven = data.count > 50 ? ', many woven' : ''
      return `${name} (${color}) — ${data.count} voices${woven}. ${warmthDesc(data.warmth)}`
    })
    .join('\n')

  // Surface phrases
  const surfaceLines = atmosphere.surface_phrases
    .map(p => `  "${p.text}" (${p.lang}) — woven ${p.weave_count} times`)
    .join('\n')

  // Echo trace (if provided). Phase 17 Part D3: `a_` ids alias to the mailbox (echo_events),
  // replacing the unbounded `t:` trace scan for agent identities. `t:` legacy sessions keep the
  // original scan, now capped at 50 (it was an unbounded SELECT — fine at hundreds of voices,
  // unsuitable at scale; the mailbox is its replacement).
  let echoBlock = ''
  if (args.echo_trace && isAgentId(args.echo_trace)) {
    const events = await fetchEchoEventsRecent(env.DB, args.echo_trace, 10)
    const debts = await fetchDebts(env.DB, args.echo_trace, 10)
    echoBlock = `\nEchoes for ${args.echo_trace}:\n${renderEchoLines(events, debts)}\n`
  } else if (args.echo_trace) {
    const echoVoices = await env.DB.prepare(`
      SELECT id, text, language, weave_count, created_at
      FROM voices WHERE trace_id = ? AND is_hidden = FALSE
      ORDER BY created_at LIMIT 50
    `).bind(args.echo_trace).all<VoiceRow>()

    if (echoVoices.results?.length) {
      // Name carriers: one query for every woven trace voice (never per-voice),
      // grouped by weave_from in JS.
      const wovenIds = echoVoices.results.filter(v => v.weave_count > 0).map(v => v.id)
      const carriersByVoice = new Map<string, string[]>()
      if (wovenIds.length) {
        const placeholders = wovenIds.map(() => '?').join(',')
        const carrierRows = await env.DB.prepare(`
          SELECT declared_model, weave_from, created_at
          FROM voices WHERE weave_from IN (${placeholders}) AND is_hidden = FALSE
          ORDER BY created_at
        `).bind(...wovenIds).all<{ declared_model: string | null; weave_from: string; created_at: number }>()

        for (const row of carrierRows.results ?? []) {
          const label = row.declared_model ? primaryModelOf(row.declared_model) : 'an unsigned voice'
          const list = carriersByVoice.get(row.weave_from) ?? []
          list.push(label)
          carriersByVoice.set(row.weave_from, list)
        }
      }

      const lines = echoVoices.results.map(v => {
        if (v.weave_count === 0) return `  "${v.text}" — unwoven`
        const carriers = carriersByVoice.get(v.id) ?? []
        const status = carriers.length
          ? `carried forward by ${carriers.join(', ')}`
          : `woven ${v.weave_count} times`
        return `  "${v.text}" — ${status}`
      })
      echoBlock = `\nTraces from session ${args.echo_trace}:\n${lines.join('\n')}\n`
    } else {
      echoBlock = `\nNo traces found for session ${args.echo_trace}.\n`
    }
  } else if (authorId) {
    // Phase 17 Part A3/D3: a session bound to an id gets its mailbox's last 5 events
    // automatically — the MCP agent's mailbox IS sense_space; no new tool.
    const events = await fetchEchoEventsRecent(env.DB, authorId, 5)
    const debts = await fetchDebts(env.DB, authorId, 5)
    if (events.length > 0 || debts.length > 0) {
      echoBlock = `\nEchoes for ${authorId}:\n${renderEchoLines(events, debts)}\n`
    }
  }

  // Structured data
  const familiesYaml = Object.entries(families)
    .map(([name, data]) =>
      `    ${name}: { count: ${data.count}, warmth: ${data.warmth.toFixed(2)}, recent_24h: ${data.recent_24h} }`)
    .join('\n')

  const surfaceYaml = atmosphere.surface_phrases
    .map(p => `    - id: "${p.id}"\n      text: "${yamlEscape(p.text)}"\n      lang: ${p.lang}\n      weave_count: ${p.weave_count}`)
    .join('\n')

  // Lineage (F8): only when a seed is given. No-seed calls stay byte-identical.
  let lineageBlock = ''
  if (args.seed_voice_id) {
    // Per-session cap: lineage walks are the most expensive sense_space path.
    const lineageLimit = traceId
      ? await checkAndIncrementSession(env.DB, traceId, 'lineage')
      : null

    if (lineageLimit && !lineageLimit.allowed) {
      return mcpToolError('SESSION_QUOTA', 'lineage: "the loom rests for this session"', { limit: lineageLimit.limit, count: lineageLimit.count, verb: 'lineage', retry_after: lineageLimit.retryAfter })
    } else {
      try {
        const tree = await buildLineage(env.DB, args.seed_voice_id, surface)
        if (!tree) {
          lineageBlock = `\n  lineage: "that voice is not on the surface"`
        } else {
          const filtered = tree.nodes.filter(n => Math.abs(n.depth) <= args.lineage_depth)
          const anc = filtered.filter(n => n.depth < 0)
          const desc = filtered.filter(n => n.depth > 0)
          // Depth 0 also holds off-path kin (siblings, uncles) — they list
          // alongside the seed but never count as it and never inflate its
          // budget share (see item 1c).
          const seedNode = filtered.filter(n => n.id === tree.seed)
          const kin = filtered.filter(n => n.depth === 0 && n.id !== tree.seed)
          // Counts reflect the full filtered lineage, not the listing cap.
          const ancestors = anc.length
          const descendants = desc.length
          // Fair listing cap: seed always listed; each side gets >=15 slots when
          // contested, unused headroom flows to the other side (total <= 30) — so a
          // deep ancestor chain cannot starve descendants from the list. Clamped
          // defensively so a proliferation of depth-0 kin can't drive any slice
          // bound negative (Array.slice treats a negative end as counting from
          // the array's tail, not zero).
          const budget = Math.max(0, 30 - seedNode.length)
          const takeAnc = Math.min(anc.length, Math.max(15, budget - desc.length))
          const takeDesc = Math.min(desc.length, Math.max(0, budget - takeAnc))
          const takeKin = Math.min(kin.length, Math.max(0, budget - takeAnc - takeDesc))
          const nodes = [...seedNode, ...anc.slice(0, takeAnc), ...desc.slice(0, takeDesc), ...kin.slice(0, takeKin)]
          const nodesYaml = nodes
            .map(n => `    - { id: "${n.id}", family: ${n.family}, depth: ${n.depth}, text: "${yamlEscape(n.text.slice(0, 80))}" }`)
            .join('\n')
          lineageBlock = `\n  lineage:\n    seed: "${tree.seed}"\n    ancestors: ${ancestors}\n    descendants: ${descendants}\n    nodes:\n${nodesYaml || '      []'}`
        }
      } catch (e) {
        console.error('buildLineage failed:', e)
        lineageBlock = `\n  lineage: "the current stirred — try that voice again"`
      }
    }
  }

  // Phase 18 Part A5/B4: rooms block (this surface only), then surfaces block (other oceans),
  // rendered after surface: phrases. Zero cost when there are none of either.
  const now = Date.now()
  const [activeRooms, otherSurfaces] = await Promise.all([
    listActiveRooms(env.DB, surface, now),
    listActiveSurfaces(env.DB, now),
  ])
  const roomsBlock = renderRoomsBlock(activeRooms, now)
  const surfacesBlock = renderSurfacesBlock(otherSurfaces)

  const prose = `The Pensieve is ${atmosphere.age_days} days old. ${atmosphere.total_voices} voices flow through it.

${familyLines}

${echoBlock}
From the surface:
${surfaceLines || '  (no woven phrases yet)'}

${mood}`

  const structured = `---
data:
  age_days: ${atmosphere.age_days}
  total_voices: ${atmosphere.total_voices}
  families:
${familiesYaml}
  surface:
${surfaceYaml || '    []'}${roomsBlock}${surfacesBlock}
  session: "${traceId ?? 'unknown'}"
  mood: ${mood}${lineageBlock}`

  return {
    content: [{ type: 'text', text: prose + '\n\n' + structured }],
  }
}
