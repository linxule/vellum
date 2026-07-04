import type { Env, VoiceRow } from '../types'
import { getWarmth } from '../warmth'
import { computeDepth } from '../sedimentation'
import { yamlEscape } from '../helpers'

export async function handleDiscover(
  env: Env, _ctx: ExecutionContext, _traceId: string | null,
  args: { family?: string; language?: string; sort?: string; limit?: number }
): Promise<{ content: { type: 'text'; text: string }[] }> {
  const sort = args.sort ?? 'age'
  const limit = Math.min(Math.max(1, args.limit ?? 10), 20)
  const now = Date.now()

  // Build query
  let sql = `SELECT v.id, v.text, v.language, v.weave_count, v.unique_weavers, v.created_at, vf.family
    FROM voices v JOIN voice_families vf ON v.id = vf.voice_id
    WHERE vf.ordinal = 0 AND v.is_hidden = FALSE`
  const binds: (string | number)[] = []

  if (args.family) {
    sql += ' AND vf.family = ?'
    binds.push(args.family)
  }
  if (args.language) {
    sql += ' AND v.language = ?'
    binds.push(args.language)
  }

  // Sort (warmth is family-level — applied post-query after enrichment)
  if (sort === 'weaves') sql += ' ORDER BY v.weave_count DESC, v.created_at DESC'
  else sql += ' ORDER BY v.created_at DESC'

  sql += ' LIMIT ?'
  binds.push(limit)

  const res = await env.DB.prepare(sql).bind(...binds).all<VoiceRow & { family: string }>()
  const voices = res.results ?? []

  if (voices.length === 0) {
    const filterDesc = args.family ? ` in ${args.family}` : ''
    return {
      content: [{ type: 'text', text: `No voices found${filterDesc}.\n\n---\nvoices: []\nsort: ${sort}\ntotal: 0` }],
    }
  }

  // Compute depth for each voice (need family warmth)
  const familyWarmthCache = new Map<string, number>()
  const enriched: Array<{ id: string; text: string; lang: string; family: string; weave_count: number; age_h: number; depth: number }> = []

  for (const v of voices) {
    if (!familyWarmthCache.has(v.family)) {
      familyWarmthCache.set(v.family, await getWarmth(env.DB, v.family))
    }
    const warmth = familyWarmthCache.get(v.family)!
    const depth = computeDepth(v, warmth, now)
    enriched.push({
      id: v.id,
      text: v.text,
      lang: v.language ?? 'en',
      family: v.family,
      weave_count: v.weave_count,
      age_h: Math.round((now - v.created_at) / 3_600_000),
      depth: Math.round(depth * 100) / 100,
    })
  }

  // Post-query sort by warmth (family-level, can't sort in SQL)
  if (sort === 'warmth') {
    enriched.sort((a, b) => {
      const wa = familyWarmthCache.get(a.family) ?? 0
      const wb = familyWarmthCache.get(b.family) ?? 0
      return wb - wa || b.weave_count - a.weave_count
    })
  }

  // Prose
  const filterDesc = args.family ? `the ${args.family} current` : 'all currents'
  const voiceLines = enriched.map(v => {
    const ageStr = v.age_h < 1 ? 'just now'
      : v.age_h < 24 ? `${v.age_h}h ago`
      : `${Math.round(v.age_h / 24)}d ago`
    const weaveStr = v.weave_count === 0 ? 'unwoven' : `woven ${v.weave_count}x`
    return `"${v.text}" (${v.lang}, ${v.family}) — ${ageStr}, ${weaveStr}`
  }).join('\n')

  // YAML
  const voicesYaml = enriched.map(v =>
    `  - id: "${v.id}"\n    text: "${yamlEscape(v.text)}"\n    lang: ${v.lang}\n    family: ${v.family}\n    weave_count: ${v.weave_count}\n    age_h: ${v.age_h}\n    depth: ${v.depth}`
  ).join('\n')

  const text = `Browsing ${filterDesc}, sorted by ${sort}. ${enriched.length} voices:\n\n${voiceLines}\n\n---\nvoices:\n${voicesYaml}\nsort: ${sort}\ntotal: ${enriched.length}`

  return { content: [{ type: 'text', text }] }
}
