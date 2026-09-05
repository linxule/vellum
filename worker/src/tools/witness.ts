import { mcpToolError } from '../errors'
import type { Env } from '../types'
import { FAMILIES } from '../types'
import { checkAndIncrementSession } from '../rate-limits'
import { updateWarmth } from '../warmth'
import { rebuildStateProjectionIfNotLocked } from '../cache'
import { modeOf } from '../levee-admission'

export async function handleWitnessTool(
  env: Env, ctx: ExecutionContext, traceId: string,
  args: { voice_id?: string; family?: string; families?: string[]; dwell_s: number; surface?: string }
): Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean; _meta?: Record<string, unknown> }> {
  const surface = args.surface ?? 'vellum'
  // Resolve and validate target BEFORE spending session quota
  let targetFamilies: string[] = []
  let resolvedVoiceText: string | null = null

  if (args.voice_id) {
    const row = await env.DB.prepare(
      `SELECT v.text, vf.family FROM voices v
       JOIN voice_families vf ON v.id = vf.voice_id
       WHERE v.id = ? AND vf.ordinal = 0 AND v.is_hidden = FALSE AND v.surface_id = ?`
    ).bind(args.voice_id, surface).first<{ text: string; family: string }>()
    if (!row) {
      return mcpToolError('SOURCE_NOT_FOUND', `Voice not found: ${args.voice_id}`, { field: 'voice_id' })
    }
    targetFamilies = [row.family]
    resolvedVoiceText = row.text
  } else if (args.family) {
    targetFamilies = [args.family]
  } else if (args.families && args.families.length > 0) {
    targetFamilies = args.families
  }

  // Validate and deduplicate families (match REST witness behavior)
  const validFamilies = [...new Set(
    targetFamilies.filter(f => (FAMILIES as readonly string[]).includes(f))
  )]
  if (validFamilies.length === 0) {
    return mcpToolError('VALIDATION', 'No valid families to witness. Provide voice_id, family, or families.', { field: 'families', valid_values: [...FAMILIES] })
  }

  // Session rate limit (after validation — don't waste quota on bad input)
  const limit = await checkAndIncrementSession(env.DB, traceId, 'witness')
  if (!limit.allowed) {
    return mcpToolError('SESSION_QUOTA', `You have reached the limit of ${limit.limit} witness events per session (${limit.count}/${limit.limit}).`, { limit: limit.limit, count: limit.count, verb: 'witness', retry_after: limit.retryAfter })
  }

  // Clamp dwell
  const dwell = Math.min(Math.max(1, args.dwell_s), 300)

  // Update warmth for each unique family
  for (const family of validFamilies) {
    await updateWarmth(env.DB, family, dwell, surface)
  }

  // Background cache rebuild
  ctx.waitUntil(
    rebuildStateProjectionIfNotLocked(env.DB, env.KV, undefined, 'off', 0, surface, modeOf(env, 'LEVEE_PERMANENCE'))
      .catch(e => console.error('Background rebuild after witness tool failed:', e))
  )

  // Response
  const familyStr = validFamilies.join(', ')
  const voiceLine = resolvedVoiceText
    ? `You witnessed "${resolvedVoiceText.slice(0, 60)}${resolvedVoiceText.length > 60 ? '...' : ''}" for ${dwell} seconds.`
    : `You witnessed the ${familyStr} ${validFamilies.length === 1 ? 'current' : 'currents'} for ${dwell} seconds.`
  const warmthLine = validFamilies.length === 1
    ? `The ${validFamilies[0]} current grows a little warmer.`
    : `The ${familyStr} currents grow a little warmer.`

  const yaml = [
    '---',
    'data:',
    args.voice_id ? `  voice_id: "${args.voice_id}"` : null,
    `  families: [${validFamilies.join(', ')}]`,
    `  dwell_s: ${dwell}`,
    `  session_witnesses: ${limit.count}/${limit.limit}`,
  ].filter(Boolean).join('\n')

  return {
    content: [{ type: 'text', text: `${voiceLine}\n${warmthLine}\n\n${yaml}` }],
  }
}
