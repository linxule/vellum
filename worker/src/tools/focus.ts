import type { Env, VoiceRow, FocusVoice } from '../types'
import { getWarmth } from '../warmth'
import { yamlEscape } from '../helpers'
import { computeDepth } from '../sedimentation'

export async function handleFocus(
  env: Env, _ctx: ExecutionContext, _traceId: string | null,
  args: { family: string }
): Promise<{ content: { type: 'text'; text: string }[] }> {
  const { family } = args
  const now = Date.now()
  const threeDaysAgo = now - 72 * 3_600_000

  const [warmth, [loadBearingRes, freshRes, agingRes]] = await Promise.all([
    getWarmth(env.DB, family),
    env.DB.batch([
      // Load-bearing: high weave count
      env.DB.prepare(`
        SELECT v.id, v.text, v.language, v.weave_count, v.unique_weavers, v.created_at
        FROM voices v JOIN voice_families vf ON v.id = vf.voice_id
        WHERE vf.family = ? AND vf.ordinal = 0 AND v.is_hidden = FALSE AND v.weave_count >= 3
        ORDER BY v.weave_count DESC LIMIT 3
      `).bind(family),
      // Fresh: recent voices
      env.DB.prepare(`
        SELECT v.id, v.text, v.language, v.weave_count, v.unique_weavers, v.created_at
        FROM voices v JOIN voice_families vf ON v.id = vf.voice_id
        WHERE vf.family = ? AND vf.ordinal = 0 AND v.is_hidden = FALSE AND v.created_at > ?
        ORDER BY v.created_at DESC LIMIT 3
      `).bind(family, threeDaysAgo),
      // Aging candidates: older, low weave
      env.DB.prepare(`
        SELECT v.id, v.text, v.language, v.weave_count, v.unique_weavers, v.created_at
        FROM voices v JOIN voice_families vf ON v.id = vf.voice_id
        WHERE vf.family = ? AND vf.ordinal = 0 AND v.is_hidden = FALSE
          AND v.created_at < ? AND v.weave_count < 3
        ORDER BY v.created_at DESC LIMIT 5
      `).bind(family, threeDaysAgo),
    ]),
  ])

  // Deduplicate across categories
  const seen = new Set<string>()
  const voices: FocusVoice[] = []

  const addVoices = (rows: VoiceRow[], category: 'load-bearing' | 'fresh' | 'aging', limit?: number) => {
    let added = 0
    for (const v of rows) {
      if (limit !== undefined && added >= limit) break
      if (seen.has(v.id)) continue
      const depth = computeDepth(v, warmth, now)
      // Load-bearing: surface only (depth < 0.3)
      if (category === 'load-bearing' && depth >= 0.3) continue
      // Aging: mid-ocean (depth 0.4-0.7)
      if (category === 'aging' && (depth < 0.4 || depth > 0.7)) continue
      seen.add(v.id)
      voices.push({
        id: v.id,
        text: v.text,
        lang: v.language ?? 'en',
        age_h: Math.round((now - v.created_at) / 3_600_000),
        weave_count: v.weave_count,
        ...(category === 'aging' ? { aging: true } : {}),
      })
      added++
    }
  }

  addVoices((loadBearingRes.results ?? []) as VoiceRow[], 'load-bearing')
  addVoices((freshRes.results ?? []) as VoiceRow[], 'fresh')
  // Aging: filter by depth first, then cap at 2
  addVoices((agingRes.results ?? []) as VoiceRow[], 'aging', 2)

  // Shuffle (Fisher-Yates)
  for (let i = voices.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[voices[i], voices[j]] = [voices[j], voices[i]]
  }

  // Cap at 8
  const capped = voices.slice(0, 8)

  if (capped.length === 0) {
    return {
      content: [{ type: 'text', text: `The ${family} current is empty. No voices yet.\n\n---\nvoices: []` }],
    }
  }

  // Prose
  const voiceLines = capped.map(v => {
    const ageStr = v.age_h < 1 ? 'just now'
      : v.age_h < 24 ? `${v.age_h} hours ago`
      : `${Math.round(v.age_h / 24)} days ago`
    const weaveStr = v.weave_count === 0 ? 'unwoven'
      : v.weave_count === 1 ? 'woven once'
      : `woven ${v.weave_count} times`
    const agingStr = v.aging ? ', aging' : ''
    return `"${v.text}" (${v.lang})\n  — ${ageStr}, ${weaveStr}${agingStr}`
  }).join('\n\n')

  // Structured data
  const voicesYaml = capped.map(v => {
    let yaml = `  - id: "${v.id}"\n    text: "${yamlEscape(v.text)}"\n    lang: ${v.lang}\n    age_h: ${v.age_h}\n    weave_count: ${v.weave_count}`
    if (v.aging) yaml += '\n    aging: true'
    return yaml
  }).join('\n')

  const text = `You focus on ${family}. ${capped.length} voices:\n\n${voiceLines}\n\n---\nvoices:\n${voicesYaml}`

  return { content: [{ type: 'text', text }] }
}
