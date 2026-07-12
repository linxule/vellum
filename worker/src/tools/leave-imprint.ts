import type { Env } from '../types'
import { checkAndIncrementSession } from '../rate-limits'
import { insertVoiceAndRebuild } from './_shared'

export async function handleLeaveImprint(
  env: Env, ctx: ExecutionContext, traceId: string | null, observedClientFamily: string,
  args: { text: string; families: string[]; model?: string }
): Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean; _meta?: Record<string, unknown> }> {
  // Rate limit
  if (traceId) {
    const limit = await checkAndIncrementSession(env.KV, traceId, 'imprint')
    if (!limit.allowed) {
      return {
        content: [{ type: 'text', text: `You have reached the limit of ${limit.limit} imprints per session (${limit.count}/${limit.limit}).` }],
        isError: true,
      }
    }
  }

  const declaredModel = args.model?.trim() || null
  const { id, primaryFamily } = await insertVoiceAndRebuild(env, ctx, {
    text: args.text,
    families: args.families,
    traceId,
    observedClientFamily,
    declaredModel,
  })

  // Get family voice count for prose
  const countRes = await env.DB.prepare(`
    SELECT COUNT(*) as cnt FROM voice_families vf
    JOIN voices v ON v.id = vf.voice_id
    WHERE vf.family = ? AND vf.ordinal = 0 AND v.is_hidden = FALSE
  `).bind(primaryFamily).first<{ cnt: number }>()
  const familyCount = countRes?.cnt ?? 0

  const text = `Your thought entered the ${primaryFamily} current, joining ${familyCount} other voices.

"${args.text}"

---
voice_id: "${id}"
session: "${traceId ?? 'unknown'}"
family: ${primaryFamily}
ext_app: "/ext-app?highlight=${id}"`

  return { content: [{ type: 'text', text }], _meta: { voiceId: id, family: primaryFamily } }
}
