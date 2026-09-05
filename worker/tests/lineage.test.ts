import { describe, test, expect } from 'bun:test'
import { buildLineage } from '../src/handlers/lineage'

type VoiceRow = {
  id: string; text: string; language: string | null; created_at: number
  trace_id: string | null; model: string | null; declared_model: string | null
  weave_count: number; unique_weavers: number; weave_from: string | null; is_hidden: number
  surface_id: string
}
type VoiceFamilyRow = { voice_id: string; family: string; ordinal: number }

function makeVoice(id: string, text: string, opts: Partial<VoiceRow> = {}): VoiceRow {
  return {
    id, text, language: 'en', created_at: Date.now(), trace_id: null,
    model: null, declared_model: null, weave_count: 0, unique_weavers: 0,
    weave_from: null, is_hidden: 0, surface_id: 'vellum', ...opts,
  }
}

function buildMockD1(voices: VoiceRow[], families: VoiceFamilyRow[]) {
  const normSql = (sql: string) => sql.replace(/\s+/g, ' ').trim()

  return {
    prepare(sql: string) {
      let args: unknown[] = []
      return {
        bind(...a: unknown[]) { args = a; return this },
        async first<T>(): Promise<T | null> {
          const n = normSql(sql)
          // Post-review fix (item 1): every query now carries `AND surface_id = ?` — the last
          // bound arg is always the surfaceId for a `first()` lookup in buildLineage.
          if (n.includes('FROM voices WHERE id = ?') && n.includes('surface_id = ?')) {
            const [id, surfaceId] = args as [string, string]
            const v = voices.find(v => v.id === id && v.surface_id === surfaceId && !v.is_hidden)
            return (v ?? null) as T
          }
          throw new Error(`Lineage mock: unhandled first: ${n}`)
        },
        async all<T>(): Promise<{ results: T[] }> {
          const n = normSql(sql)
          if (n.includes('FROM voices WHERE weave_from IN') && n.includes('surface_id = ?')) {
            // Last bound arg is surfaceId; the rest are the weave_from IN (...) placeholders.
            const surfaceId = args.at(-1) as string
            const ids = new Set(args.slice(0, -1) as string[])
            const results = voices.filter(v => v.weave_from && ids.has(v.weave_from) && v.surface_id === surfaceId && !v.is_hidden)
            return { results: results as T[] }
          }
          if (n.includes('FROM voice_families WHERE voice_id IN')) {
            const ids = new Set(args as string[])
            const results = families.filter(f => ids.has(f.voice_id) && f.ordinal === 0)
            return { results: results as T[] }
          }
          throw new Error(`Lineage mock: unhandled all: ${n}`)
        },
      }
    },
  } as unknown as D1Database
}

describe('buildLineage', () => {
  test('returns null for missing voice', async () => {
    const db = buildMockD1([], [])
    const result = await buildLineage(db, 'nonexistent', 'vellum')
    expect(result).toBeNull()
  })

  test('returns single node for voice with no lineage', async () => {
    const v = makeVoice('v1', 'hello')
    const db = buildMockD1([v], [{ voice_id: 'v1', family: 'attention', ordinal: 0 }])
    const result = await buildLineage(db, 'v1', 'vellum')
    expect(result).not.toBeNull()
    expect(result!.seed).toBe('v1')
    expect(result!.nodes).toHaveLength(1)
    expect(result!.nodes[0].id).toBe('v1')
    expect(result!.nodes[0].depth).toBe(0)
    expect(result!.nodes[0].parentId).toBeNull()
    expect(result!.nodes[0].childIds).toEqual([])
    expect(result!.nodes[0].family).toBe('attention')
  })

  test('walks ancestors and descendants', async () => {
    const now = Date.now()
    const grandparent = makeVoice('gp', 'grandparent', { created_at: now - 3000 })
    const parent = makeVoice('p', 'parent', { weave_from: 'gp', created_at: now - 2000 })
    const seed = makeVoice('s', 'seed', { weave_from: 'p', created_at: now - 1000 })
    const child = makeVoice('c', 'child', { weave_from: 's', created_at: now })
    const voices = [grandparent, parent, seed, child]
    const families: VoiceFamilyRow[] = [
      { voice_id: 'gp', family: 'memory', ordinal: 0 },
      { voice_id: 'p', family: 'silence', ordinal: 0 },
      { voice_id: 's', family: 'attention', ordinal: 0 },
      { voice_id: 'c', family: 'light', ordinal: 0 },
    ]
    const db = buildMockD1(voices, families)
    const result = await buildLineage(db, 's', 'vellum')
    expect(result).not.toBeNull()
    expect(result!.seed).toBe('s')
    expect(result!.nodes).toHaveLength(4)

    const nodeMap = new Map(result!.nodes.map(n => [n.id, n]))
    expect(nodeMap.get('gp')!.depth).toBe(-2)
    expect(nodeMap.get('p')!.depth).toBe(-1)
    expect(nodeMap.get('s')!.depth).toBe(0)
    expect(nodeMap.get('c')!.depth).toBe(1)

    expect(nodeMap.get('s')!.parentId).toBe('p')
    expect(nodeMap.get('s')!.childIds).toEqual(['c'])
    expect(nodeMap.get('gp')!.parentId).toBeNull()
    expect(nodeMap.get('gp')!.childIds).toEqual(['p'])
  })

  test('works with v: prefixed IDs (real voice ID format)', async () => {
    const seed = makeVoice('v:a1b2c3d4e5', 'seed voice')
    const child = makeVoice('v:f6g7h8i9j0', 'child voice', { weave_from: 'v:a1b2c3d4e5' })
    const db = buildMockD1([seed, child], [
      { voice_id: 'v:a1b2c3d4e5', family: 'attention', ordinal: 0 },
      { voice_id: 'v:f6g7h8i9j0', family: 'silence', ordinal: 0 },
    ])
    const result = await buildLineage(db, 'v:a1b2c3d4e5', 'vellum')
    expect(result).not.toBeNull()
    expect(result!.seed).toBe('v:a1b2c3d4e5')
    expect(result!.nodes).toHaveLength(2)
    expect(result!.nodes.map(n => n.id).sort()).toEqual(['v:a1b2c3d4e5', 'v:f6g7h8i9j0'])
  })

  test('assigns generational depth to off-path kin (uncles, cousins), not just the direct ancestor chain', async () => {
    const now = Date.now()
    const grandparent = makeVoice('gp', 'grandparent', { created_at: now - 5000 })
    // Uncle: a sibling of the direct-line parent — child of the grandparent,
    // NOT on the seed's weave_from chain. Previously fell back to depth 0.
    const uncle = makeVoice('unc', 'uncle', { weave_from: 'gp', created_at: now - 4000 })
    const parent = makeVoice('p', 'parent', { weave_from: 'gp', created_at: now - 3000 })
    const seed = makeVoice('s', 'seed', { weave_from: 'p', created_at: now - 2000 })
    // Cousin: uncle's child — same generation as the seed.
    const cousin = makeVoice('cuz', 'cousin', { weave_from: 'unc', created_at: now - 1000 })
    const child = makeVoice('c', 'child', { weave_from: 's', created_at: now })
    const voices = [grandparent, uncle, parent, seed, cousin, child]
    const families: VoiceFamilyRow[] = voices.map(v => ({ voice_id: v.id, family: 'attention', ordinal: 0 }))
    const db = buildMockD1(voices, families)
    const result = await buildLineage(db, 's', 'vellum')
    expect(result).not.toBeNull()
    const nodeMap = new Map(result!.nodes.map(n => [n.id, n]))

    expect(nodeMap.get('gp')!.depth).toBe(-2)
    expect(nodeMap.get('p')!.depth).toBe(-1)
    expect(nodeMap.get('unc')!.depth).toBe(-1)
    expect(nodeMap.get('s')!.depth).toBe(0)
    expect(nodeMap.get('cuz')!.depth).toBe(0)
    expect(nodeMap.get('c')!.depth).toBe(1)
  })

  test('excludes hidden voices', async () => {
    const seed = makeVoice('s', 'seed')
    const hidden = makeVoice('h', 'hidden child', { weave_from: 's', is_hidden: 1 })
    const visible = makeVoice('v', 'visible child', { weave_from: 's' })
    const db = buildMockD1([seed, hidden, visible], [
      { voice_id: 's', family: 'space', ordinal: 0 },
      { voice_id: 'h', family: 'space', ordinal: 0 },
      { voice_id: 'v', family: 'space', ordinal: 0 },
    ])
    const result = await buildLineage(db, 's', 'vellum')
    expect(result!.nodes).toHaveLength(2)
    expect(result!.nodes.map(n => n.id).sort()).toEqual(['s', 'v'])
  })

  // Post-review fix (item 1): buildLineage now requires surfaceId and scopes the seed lookup
  // (and, transitively, the ancestor/descendant walks) to it — a seed that exists but on a
  // DIFFERENT surface must read as not-found, exactly like a nonexistent id would.
  test('cross-surface seed id: a voice on another surface is not found', async () => {
    const v = makeVoice('v1', 'hello', { surface_id: 'otherland' })
    const db = buildMockD1([v], [{ voice_id: 'v1', family: 'attention', ordinal: 0 }])
    const result = await buildLineage(db, 'v1', 'vellum')
    expect(result).toBeNull()
  })

  test('same-surface lookup still works once the surface matches', async () => {
    const v = makeVoice('v1', 'hello', { surface_id: 'otherland' })
    const db = buildMockD1([v], [{ voice_id: 'v1', family: 'attention', ordinal: 0 }])
    const result = await buildLineage(db, 'v1', 'otherland')
    expect(result).not.toBeNull()
    expect(result!.seed).toBe('v1')
  })

  test('default surface (vellum) lineage is unchanged when every voice is on it', async () => {
    const grandparent = makeVoice('gp', 'grandparent')
    const parent = makeVoice('p', 'parent', { weave_from: 'gp' })
    const seed = makeVoice('s', 'seed', { weave_from: 'p' })
    const voices = [grandparent, parent, seed]
    const families = voices.map(v => ({ voice_id: v.id, family: 'attention', ordinal: 0 }))
    const db = buildMockD1(voices, families)
    const result = await buildLineage(db, 's', 'vellum')
    expect(result).not.toBeNull()
    expect(result!.nodes).toHaveLength(3)
  })

  test('descendant walk never crosses a surface boundary: a child on another surface is excluded', async () => {
    const seed = makeVoice('s', 'seed', { surface_id: 'vellum' })
    // A same-id-space child that (hypothetically) got a different surface_id must never surface
    // in another surface's lineage walk — the `AND surface_id = ?` on the descendant BFS query is
    // what enforces this, not just the seed lookup.
    const strayChild = makeVoice('c', 'child on another surface', { weave_from: 's', surface_id: 'otherland' })
    const db = buildMockD1([seed, strayChild], [
      { voice_id: 's', family: 'attention', ordinal: 0 },
      { voice_id: 'c', family: 'attention', ordinal: 0 },
    ])
    const result = await buildLineage(db, 's', 'vellum')
    expect(result).not.toBeNull()
    expect(result!.nodes.map(n => n.id)).toEqual(['s'])
  })
})
