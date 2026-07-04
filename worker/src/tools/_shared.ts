import type { Env } from '../types'
import { voiceId } from '../ids'
import { detectLanguage } from '../language'
import { withRetry } from '../helpers'
import { rebuildAtmosphereIfNotLocked, rebuildStateProjectionIfNotLocked } from '../cache'

export async function insertVoiceAndRebuild(
  env: Env,
  ctx: ExecutionContext,
  input: {
    text: string
    families: string[]
    traceId: string | null
    observedClientFamily: string
    declaredModel: string | null
  },
): Promise<{ id: string; primaryFamily: string }> {
  const id = voiceId()
  const lang = detectLanguage(input.text)
  const now = Date.now()
  const primaryFamily = input.families[0]

  await withRetry(() =>
    env.DB.batch([
      env.DB.prepare(
        'INSERT INTO voices (id, text, language, created_at, trace_id, model, declared_model) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).bind(id, input.text, lang, now, input.traceId, input.observedClientFamily, input.declaredModel),
      ...input.families.map((family, ordinal) =>
        env.DB.prepare(
          'INSERT INTO voice_families (voice_id, family, ordinal) VALUES (?, ?, ?)'
        ).bind(id, family, ordinal)
      ),
    ])
  )

  // KNOWN: contention-acceptable — see PATTERNS_AND_GOTCHAS § Cache contention
  try { await rebuildStateProjectionIfNotLocked(env.DB, env.KV) } catch (e) { console.error('State rebuild failed:', e) }
  ctx.waitUntil(rebuildAtmosphereIfNotLocked(env.DB, env.KV).catch(e => console.error('Atmosphere rebuild failed:', e)))

  return { id, primaryFamily }
}
