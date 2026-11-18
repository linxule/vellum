// Migration 0014 (the one-shot permanence recompute) against real SQLite. The schema is built by
// applying the real migration files 0001..0013 in order to an in-memory bun:sqlite database; the
// fixture rows are inserted afterwards, in the state production holds them, and 0014 is then run
// from its file. Each expectation is also checked against the worker's own weave-path recompute
// (weaverRowsSql + computeQualifiedWeavers), so the SQL rule and the TypeScript rule cannot drift.
import { describe, test, expect } from 'bun:test'
import { Database } from 'bun:sqlite'
import { readdirSync, readFileSync } from 'fs'
import { LEVEE } from '../src/contract'
import { computeDistinctWeavers, computeQualifiedWeavers, toWeaveLogRows, weaverRowsSql } from '../src/levee-permanence'

const migrationsDir = new URL('../migrations/', import.meta.url)
const migrationFiles = readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort()
const MIGRATION_0014 = readFileSync(new URL('0014_permanence_bar.sql', migrationsDir), 'utf8')

const { minWeavers, minHourBuckets, legacyWeaveCutoffMs: CUTOFF } = LEVEE.permanence
const hourMs = 3_600_000
const dayMs = 24 * hourMs

type LogRow = { trace: string; at: number; bucket?: string; id?: string; voice?: string }
type Counts = { distinct_weavers: number; qualified_weavers: number }

function freshDb(): Database {
  const db = new Database(':memory:')
  for (const f of migrationFiles.filter(f => f < '0014')) db.exec(readFileSync(new URL(f, migrationsDir), 'utf8'))
  return db
}

function addVoice(db: Database, id: string, extra: Record<string, string | number | null> = {}) {
  const row: Record<string, string | number | null> = { id, text: `text of ${id}`, created_at: CUTOFF - 200 * dayMs, ...extra }
  const cols = Object.keys(row)
  db.prepare(`INSERT INTO voices (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...Object.values(row))
}

function addWeaves(db: Database, sourceId: string, rows: LogRow[]) {
  const insert = db.prepare('INSERT INTO weave_log (source_voice_id, weaver_trace_id, created_at, weaver_bucket, weaver_id, weaver_voice_id) VALUES (?, ?, ?, ?, ?, ?)')
  for (const r of rows) insert.run(sourceId, r.trace, r.at, r.bucket ?? null, r.id ?? null, r.voice ?? null)
}

const counts = (db: Database, id: string) =>
  db.query('SELECT distinct_weavers, qualified_weavers FROM voices WHERE id = ?').get(id) as Counts

/** What the weave path would write for this source: the worker's SQL, then its pure functions. */
function weavePathCounts(db: Database, id: string): Counts {
  const rows = toWeaveLogRows(db.query(weaverRowsSql(CUTOFF)).all(id) as { weaver_key: string | null; created_at: number }[])
  return { distinct_weavers: computeDistinctWeavers(rows), qualified_weavers: computeQualifiedWeavers(rows, minWeavers, minHourBuckets) }
}

const before = (i: number) => CUTOFF - (i + 1) * 30 * dayMs // pre-Levee, each in its own clock hour
const after = (i: number) => CUTOFF + (i + 1) * 7 * dayMs + i * hourMs // post-Levee, each in its own clock hour
const legacy = (n: number, prefix = 't:old'): LogRow[] => Array.from({ length: n }, (_, i) => ({ trace: `${prefix}-${i}`, at: before(i) }))

function seedFixture(db: Database) {
  // Weaver voices named by post-0011 rows.
  addVoice(db, 'v:w-surfaced-1'); addVoice(db, 'v:w-surfaced-2'); addVoice(db, 'v:w-surfaced-3')
  addVoice(db, 'v:w-hidden', { visibility: 'hidden', is_hidden: 1 })
  addVoice(db, 'v:w-settling', { visibility: 'quarantined', is_hidden: 1 })

  // The production leader on 2026-11-18: 8 weaving sessions over 7 months, counted as 3.
  addVoice(db, 'v:p06dtn3b5h', { weave_count: 8, unique_weavers: 8, qualified_weavers: 0, distinct_weavers: 3 })
  addWeaves(db, 'v:p06dtn3b5h', [
    ...legacy(3),
    { trace: 't:new-0', at: after(0), bucket: '9f16de' },
    { trace: 't:new-1', at: after(1), bucket: '9f16de' },
    { trace: 't:new-2', at: after(2), bucket: '9f16de', voice: 'v:w-surfaced-1' },
    { trace: 't:new-3', at: after(3), bucket: '835bd7', id: 'a_481V8', voice: 'v:w-surfaced-2' },
    { trace: 't:new-4', at: after(4), bucket: 'd6978b', voice: 'v:w-surfaced-3' },
  ])

  // One key short of the bar.
  addVoice(db, 'v:one-short')
  addWeaves(db, 'v:one-short', legacy(minWeavers - 1))

  // Exactly at the bar: enough keys, exactly enough clock hours (the last two share one).
  addVoice(db, 'v:at-bar')
  addWeaves(db, 'v:at-bar', [
    ...legacy(minHourBuckets - 1),
    ...Array.from({ length: minWeavers - minHourBuckets + 1 }, (_, i) => ({ trace: `t:same-hour-${i}`, at: after(0) + i * 60_000, bucket: `bucket-${i}` })),
  ])

  // Enough keys, one clock hour too few.
  addVoice(db, 'v:too-few-hours')
  addWeaves(db, 'v:too-few-hours', Array.from({ length: minWeavers }, (_, i) => ({
    trace: `t:rush-${i}`, at: after(i % (minHourBuckets - 1)) + i * 60_000, bucket: `bucket-${i}`,
  })))

  // A post-cutoff row with no id and no bucket is not a weaver (here it would be the last key).
  addVoice(db, 'v:keyless-new')
  addWeaves(db, 'v:keyless-new', [...legacy(minWeavers - 1), { trace: 't:keyless-at-cutoff', at: CUTOFF }, { trace: 't:keyless-later', at: after(5) }])

  // A row whose weaver voice is hidden (or still settling) is not counted.
  addVoice(db, 'v:hidden-weaver')
  addWeaves(db, 'v:hidden-weaver', [
    ...legacy(minWeavers - 1),
    { trace: 't:hidden', at: after(0), bucket: 'bucket-hidden', voice: 'v:w-hidden' },
    { trace: 't:settling', at: after(1), bucket: 'bucket-settling', voice: 'v:w-settling' },
  ])

  // Stale 0013 credits: raw session counts left in qualified_weavers.
  addVoice(db, 'v:stale-no-rows', { unique_weavers: 3, qualified_weavers: 3, distinct_weavers: 0 })
  addVoice(db, 'v:stale-one-hour', { unique_weavers: 7, qualified_weavers: 7, distinct_weavers: 0 })
  addWeaves(db, 'v:stale-one-hour', Array.from({ length: 7 }, (_, i) => ({ trace: `t:burst-${i}`, at: before(0) + i * 60_000 })))

  // Columns 0014 must leave alone.
  addVoice(db, 'v:legacy-source', { unique_weavers: 12, permanence_source: 'legacy', rooted_at: 1234 })
  addWeaves(db, 'v:legacy-source', legacy(2))
  addVoice(db, 'v:never-woven')
}

const expected: Record<string, Counts> = {
  'v:p06dtn3b5h': { distinct_weavers: 6, qualified_weavers: 6 },
  'v:one-short': { distinct_weavers: minWeavers - 1, qualified_weavers: 0 },
  'v:at-bar': { distinct_weavers: minWeavers, qualified_weavers: minWeavers },
  'v:too-few-hours': { distinct_weavers: minWeavers, qualified_weavers: 0 },
  'v:keyless-new': { distinct_weavers: minWeavers - 1, qualified_weavers: 0 },
  'v:hidden-weaver': { distinct_weavers: minWeavers - 1, qualified_weavers: 0 },
  'v:stale-no-rows': { distinct_weavers: 0, qualified_weavers: 0 },
  'v:stale-one-hour': { distinct_weavers: 7, qualified_weavers: 0 },
  'v:legacy-source': { distinct_weavers: 2, qualified_weavers: 0 },
  'v:never-woven': { distinct_weavers: 0, qualified_weavers: 0 },
}

describe('migration 0014: permanence bar recompute', () => {
  test('its literals are the bar the worker reads (5 weavers, 4 clock hours, the 0007 moment)', () => {
    expect([minWeavers, minHourBuckets, CUTOFF]).toEqual([5, 4, 1788613200000])
    const sql = MIGRATION_0014.split('\n').filter(line => !line.startsWith('--')).join('\n')
    expect(sql).toContain(`>= ${minWeavers}\n`)
    expect(sql).toContain(`>= ${minHourBuckets}\n`)
    expect(sql.match(new RegExp(`wl\\.created_at < ${CUTOFF}\\)`, 'g'))).toHaveLength(2)
    // D1-safe shape: a single statement, no window functions, CTEs or RETURNING.
    expect(sql).not.toMatch(/\bOVER\s*\(|\bRETURNING\b|\bWITH\b/i)
    expect(sql.split(';').filter(s => s.trim()).length).toBe(1)
  })

  test('the production leader: 8 sessions, 3 of them pre-Levee, count as 6 distinct weavers and qualify', () => {
    const db = freshDb(); seedFixture(db)
    expect(counts(db, 'v:p06dtn3b5h')).toEqual({ distinct_weavers: 3, qualified_weavers: 0 })
    db.exec(MIGRATION_0014)
    expect(counts(db, 'v:p06dtn3b5h')).toEqual({ distinct_weavers: 6, qualified_weavers: 6 })
  })

  test('every fixture voice lands where the rule says, and where the weave path would put it', () => {
    const db = freshDb(); seedFixture(db)
    db.exec(MIGRATION_0014)
    for (const [id, want] of Object.entries(expected)) {
      expect({ id, ...counts(db, id) }).toEqual({ id, ...want })
      expect({ id, ...weavePathCounts(db, id) }).toEqual({ id, ...want })
    }
  })

  test('stale 0013 credits reset to 0, including a voice with no weave_log rows at all', () => {
    const db = freshDb(); seedFixture(db)
    expect(counts(db, 'v:stale-no-rows').qualified_weavers).toBe(3)
    expect(counts(db, 'v:stale-one-hour').qualified_weavers).toBe(7)
    db.exec(MIGRATION_0014)
    expect(counts(db, 'v:stale-no-rows').qualified_weavers).toBe(0)
    expect(counts(db, 'v:stale-one-hour').qualified_weavers).toBe(0)
  })

  test('permanence_source, rooted_at and unique_weavers are untouched', () => {
    const db = freshDb(); seedFixture(db)
    const untouched = () => db.query('SELECT id, permanence_source, rooted_at, unique_weavers, weave_count, visibility, is_hidden FROM voices ORDER BY id').all()
    const snapshot = untouched()
    db.exec(MIGRATION_0014)
    expect(untouched()).toEqual(snapshot)
    expect(db.query("SELECT permanence_source, rooted_at FROM voices WHERE id = 'v:legacy-source'").get()).toEqual({ permanence_source: 'legacy', rooted_at: 1234 })
  })

  test('idempotent: a second run changes nothing', () => {
    const db = freshDb(); seedFixture(db)
    const all = () => db.query('SELECT * FROM voices ORDER BY id').all()
    db.exec(MIGRATION_0014)
    const once = all()
    db.exec(MIGRATION_0014)
    expect(all()).toEqual(once)
  })
})
