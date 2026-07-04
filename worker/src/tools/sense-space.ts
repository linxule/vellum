import type { Env, AtmosphereData, VoiceRow } from '../types'
import { getWarmthMap } from '../warmth'
import { computeMood, warmthDesc } from '../prose'
import { yamlEscape } from '../helpers'
import { readAtmosphereCache, rebuildAtmosphere } from '../cache'

const FAMILY_COLORS: Record<string, string> = {
  attention: 'cyan',
  silence: 'blue-violet',
  space: 'teal',
  ephemeral: 'lavender',
  memory: 'green',
  light: 'gold',
}

export async function handleSenseSpace(
  env: Env, ctx: ExecutionContext, traceId: string | null,
  args: { echo_trace?: string }
): Promise<{ content: { type: 'text'; text: string }[] }> {
  let atmosphere = await readAtmosphereCache(env.KV)
  if (!atmosphere) {
    await rebuildAtmosphere(env.DB, env.KV)
    atmosphere = await readAtmosphereCache(env.KV)
  }

  // Fallback if no atmosphere cached yet
  if (!atmosphere) {
    return {
      content: [{ type: 'text', text: 'The Pensieve is new. No voices yet.\n\n---\ndata:\n  total_voices: 0\n  session: "' + (traceId ?? 'unknown') + '"' }],
    }
  }

  // Overlay live warmth values from D1 so human witnessing is visible immediately.
  const liveWarmth = await getWarmthMap(env.DB)
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

  // Echo trace (if provided)
  let echoBlock = ''
  if (args.echo_trace) {
    const echoVoices = await env.DB.prepare(`
      SELECT id, text, language, weave_count, created_at
      FROM voices WHERE trace_id = ? AND is_hidden = FALSE
      ORDER BY created_at
    `).bind(args.echo_trace).all<VoiceRow>()

    if (echoVoices.results?.length) {
      const lines = echoVoices.results.map(v => {
        const status = v.weave_count > 0
          ? `woven ${v.weave_count} times`
          : 'unwoven'
        return `  "${v.text}" — ${status}`
      })
      echoBlock = `\nTraces from session ${args.echo_trace}:\n${lines.join('\n')}\n`
    } else {
      echoBlock = `\nNo traces found for session ${args.echo_trace}.\n`
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
${surfaceYaml || '    []'}
  session: "${traceId ?? 'unknown'}"
  mood: ${mood}`

  return {
    content: [{ type: 'text', text: prose + '\n\n' + structured }],
  }
}
