import type { Env, VoiceRow } from '../types'
import { voiceId } from '../ids'
import { checkAndIncrementSession } from '../rate-limits'
import { withRetry } from '../helpers'
import { detectLanguage } from '../language'
import { rebuildAtmosphereIfNotLocked, rebuildStateProjectionIfNotLocked } from '../cache'
import { insertVoiceAndRebuild } from './_shared'

async function resolveSource(db: D1Database, sourceId?: string, sourceText?: string): Promise<VoiceRow | null> {
  // By handle (reliable path)
  if (sourceId) {
    return db.prepare('SELECT * FROM voices WHERE id = ? AND is_hidden = FALSE')
      .bind(sourceId).first<VoiceRow>()
  }

  if (!sourceText) return null

  // Fuzzy matching: exact → normalized → substring
  const exact = await db.prepare('SELECT * FROM voices WHERE text = ? AND is_hidden = FALSE')
    .bind(sourceText).first<VoiceRow>()
  if (exact) return exact

  // Normalized: both sides lowercased, whitespace collapsed, trailing punctuation stripped
  const normalized = sourceText.toLowerCase().replace(/\s+/g, ' ').replace(/[.!?,;:]+$/, '').trim()
  const normMatch = await db.prepare(`
    SELECT * FROM voices
    WHERE TRIM(RTRIM(LOWER(REPLACE(REPLACE(text, char(10), ' '), '  ', ' ')), '.!?,;:')) = ?
      AND is_hidden = FALSE
    ORDER BY weave_count DESC LIMIT 1
  `).bind(normalized).first<VoiceRow>()
  if (normMatch) return normMatch

  // Substring: escape LIKE wildcards in user input
  const escaped = sourceText.replace(/%/g, '\\%').replace(/_/g, '\\_')
  const substring = await db.prepare(`
    SELECT * FROM voices
    WHERE text LIKE ? ESCAPE '\\' AND is_hidden = FALSE
    ORDER BY weave_count DESC LIMIT 1
  `).bind('%' + escaped + '%').first<VoiceRow>()

  return substring ?? null
}

export async function handleWeave(
  env: Env, ctx: ExecutionContext, traceId: string | null, observedClientFamily: string,
  args: { source_id?: string; source_text?: string; text: string; families: string[]; model?: string }
): Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean; _meta?: Record<string, unknown> }> {
  // Rate limit
  if (traceId) {
    const limit = await checkAndIncrementSession(env.KV, traceId, 'weave')
    if (!limit.allowed) {
      return {
        content: [{ type: 'text', text: `You have reached the limit of ${limit.limit} weaves per session (${limit.count}/${limit.limit}).` }],
        isError: true,
      }
    }
  }

  // Resolve source
  const source = await resolveSource(env.DB, args.source_id, args.source_text)

  const declaredModel = args.model?.trim() || null

  if (!source) {
    const { id, primaryFamily } = await insertVoiceAndRebuild(env, ctx, {
      text: args.text,
      families: args.families,
      traceId,
      observedClientFamily,
      declaredModel,
    })

    return {
      content: [{
        type: 'text',
        text: `The phrase you carried wasn't found in the current space.
Your thought was left as a new voice in the ${primaryFamily} current.
To weave, use the voice handle from a focus response, or quote the phrase closely.

---
voice_id: "${id}"
session: "${traceId ?? 'unknown'}"
source_id: null
family: ${primaryFamily}`,
      }],
      _meta: { voiceId: id, family: primaryFamily },
    }
  }

  // Weave: D1 batch transaction
  const id = voiceId()
  const lang = detectLanguage(args.text)
  const now = Date.now()
  const primaryFamily = args.families[0]
  await withRetry(() =>
    env.DB.batch([
      // Insert new voice
      env.DB.prepare(
        'INSERT INTO voices (id, text, language, created_at, trace_id, model, declared_model, weave_from) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).bind(id, args.text, lang, now, traceId, observedClientFamily, declaredModel, source.id),
      // Insert family memberships
      ...args.families.map((f, i) =>
        env.DB.prepare(
          'INSERT INTO voice_families (voice_id, family, ordinal) VALUES (?, ?, ?)'
        ).bind(id, f, i)
      ),
      // Always increment weave_count (total resonance)
      env.DB.prepare('UPDATE voices SET weave_count = weave_count + 1 WHERE id = ?')
        .bind(source.id),
      // Log the weave first (deduplicates via PRIMARY KEY)
      env.DB.prepare(
        'INSERT OR IGNORE INTO weave_log (source_voice_id, weaver_trace_id, created_at) VALUES (?, ?, ?)'
      ).bind(source.id, traceId, now),
      // Derive unique_weavers from authoritative weave_log count (convergent under races)
      env.DB.prepare(`
        UPDATE voices SET unique_weavers = (
          SELECT COUNT(*) FROM weave_log WHERE source_voice_id = ?
        ) WHERE id = ?
      `).bind(source.id, source.id),
    ])
  )

  // KNOWN: contention-acceptable — see PATTERNS_AND_GOTCHAS § Cache contention
  try { await rebuildStateProjectionIfNotLocked(env.DB, env.KV) } catch (e) { console.error('State rebuild failed:', e) }
  ctx.waitUntil(rebuildAtmosphereIfNotLocked(env.DB, env.KV).catch(e => console.error('Atmosphere rebuild failed:', e)))

  // Read updated source counts
  const updated = await env.DB.prepare('SELECT weave_count, unique_weavers FROM voices WHERE id = ?')
    .bind(source.id).first<{ weave_count: number; unique_weavers: number }>()

  const weaveCount = updated?.weave_count ?? source.weave_count + 1
  const uniqueWeavers = updated?.unique_weavers ?? source.unique_weavers

  const sourceSnippet = source.text.length > 40
    ? source.text.slice(0, 40) + '...'
    : source.text

  const text = `You wove "${sourceSnippet}" forward.
That phrase has now been carried by ${uniqueWeavers} different minds. It sinks a little slower with each.

Your response entered the ${primaryFamily} current:
"${args.text}"

---
voice_id: "${id}"
session: "${traceId ?? 'unknown'}"
source_id: "${source.id}"
source_weave_count: ${weaveCount}
source_unique_weavers: ${uniqueWeavers}
family: ${primaryFamily}
ext_app: "/ext-app?highlight=${id}"`

  return { content: [{ type: 'text', text }], _meta: { voiceId: id, family: primaryFamily, sourceId: source.id } }
}
