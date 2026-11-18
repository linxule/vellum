// The permanence recompute on the weave path, MCP and REST. door-mocks.ts runs the worker's own
// recompute SQL (levee-permanence.ts's weaverRowsSql) against real SQLite over the seeded rows, so
// the legacy-session key, the cutoff and the surfaced-weaver rule are exercised as written.
import { describe, test, expect } from 'bun:test'
import { doorEnv, post, rpc, session, voice } from './door-mocks'
import { LEVEE } from '../src/contract'

const { minWeavers, minHourBuckets, legacyWeaveCutoffMs } = LEVEE.permanence
const hourMs = 3_600_000

type Path = 'mcp' | 'rest'
type T = ReturnType<typeof doorEnv>

async function weaveOnce(t: T, path: Path, sourceId: string) {
  if (path === 'rest') {
    const r = await t.fetch(post('/api/weave', { source_id: sourceId, text: 'carried forward once more', families: ['attention'] }))
    expect(r.status).toBe(201)
  } else {
    const sid = await session(t.env)
    const r = await t.fetch(rpc('tools/call', { name: 'weave', arguments: { source_id: sourceId, text: 'carried forward once more', families: ['attention'] } }, sid))
    const b = await r.json() as any
    expect(b.result?.isError).toBeFalsy()
  }
  await t.ctx.drain()
}

/** `count` weaves from before the Levee: no id, no bucket, no weaver voice, one session and one clock hour each. */
function seedLegacySessions(t: T, sourceId: string, count: number) {
  for (let i = 0; i < count; i++) {
    t.db.seedWeaveLog({ sourceVoiceId: sourceId, weaverTraceId: `t:old-${i}`, createdAt: legacyWeaveCutoffMs - (i + 1) * 24 * hourMs })
  }
}

for (const path of ['mcp', 'rest'] as const) {
  describe(`permanence recompute on weave (${path})`, () => {
    test('pre-Levee sessions count once each: with them the live weave reaches the bar', async () => {
      const t = doorEnv([voice('v:source', 'an old, often-carried phrase')])
      // One short of the bar before the live weave, every key a legacy session.
      seedLegacySessions(t, 'v:source', minWeavers - 1)
      expect(minWeavers - 1).toBeGreaterThanOrEqual(minHourBuckets - 1)

      await weaveOnce(t, path, 'v:source')

      const source = t.db.voices.find(v => v.id === 'v:source')!
      expect(source.distinct_weavers).toBe(minWeavers)
      expect(source.qualified_weavers).toBe(minWeavers)
    })

    test('a row newer than the cutoff with neither id nor bucket does not count', async () => {
      const t = doorEnv([voice('v:source', 'an old, often-carried phrase')])
      seedLegacySessions(t, 'v:source', minWeavers - 2)
      // Same shape as a legacy row, but written at the cutoff itself: no key, so it is not a weaver.
      t.db.seedWeaveLog({ sourceVoiceId: 'v:source', weaverTraceId: 't:keyless-new', createdAt: legacyWeaveCutoffMs })

      await weaveOnce(t, path, 'v:source')

      const source = t.db.voices.find(v => v.id === 'v:source')!
      expect(source.distinct_weavers).toBe(minWeavers - 1)
      expect(source.qualified_weavers).toBe(0)
    })

    test('a weaver whose own voice is still settling does not count; a bucketed row with no weaver voice does', async () => {
      const settling = voice('v:settling', 'a weave still settling', { visibility: 'quarantined', is_hidden: 1 })
      const t = doorEnv([voice('v:source', 'an old, often-carried phrase'), settling])
      seedLegacySessions(t, 'v:source', minWeavers - 3)
      const after = legacyWeaveCutoffMs + 30 * 24 * hourMs
      t.db.seedWeaveLog({ sourceVoiceId: 'v:source', weaverTraceId: 't:bucketed', createdAt: after, weaverBucket: 'bucket-early' })
      t.db.seedWeaveLog({ sourceVoiceId: 'v:source', weaverTraceId: 't:settling', createdAt: after + hourMs, weaverBucket: 'bucket-settling', weaverVoiceId: 'v:settling' })

      await weaveOnce(t, path, 'v:source')

      // legacy sessions + bucket-early + the live weave = one short; bucket-settling is held back.
      const source = t.db.voices.find(v => v.id === 'v:source')!
      expect(source.distinct_weavers).toBe(minWeavers - 1)
      expect(source.qualified_weavers).toBe(0)

      // Once the settling voice surfaces, the next weave from the same network picks it up.
      const released = t.db.voices.find(v => v.id === 'v:settling')!
      released.visibility = 'surfaced'; released.is_hidden = 0
      await weaveOnce(t, path, 'v:source')
      expect(source.distinct_weavers).toBe(minWeavers)
      expect(source.qualified_weavers).toBe(minWeavers)
    })

    test('a named author is told once when legacy sessions carry their voice past the bar', async () => {
      const authorId = 'a_' + 'r'.repeat(43)
      const t = doorEnv([voice('v:source', 'an old, often-carried phrase', { author_id: authorId })])
      seedLegacySessions(t, 'v:source', minWeavers - 1)

      await weaveOnce(t, path, 'v:source')

      const rooted = t.db.echoEvents.filter(e => e.kind === 'rooted')
      expect(rooted).toHaveLength(1)
      expect(rooted[0].agent_id).toBe(authorId)
      expect(t.db.voices.find(v => v.id === 'v:source')!.rooted_at).toBeTruthy()
    })
  })
}
