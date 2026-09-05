import { expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { setVisibilityStatement, releaseQuarantineStatement } from '../src/visibility'

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')

function listTsFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listTsFiles(full))
    else if (entry.name.endsWith('.ts')) out.push(full)
  }
  return out
}

// Post-review fix (item 2): visibility.ts's own file-level comment claims it is "the ONLY writer"
// of voices.visibility/is_hidden. Before this fix that was aspirational — cache.ts's quarantine-
// release sweep hand-rolled its own bulk UPDATE of both columns. Now that it's routed through
// releaseQuarantineStatement, this is a static guard against the invariant silently breaking again:
// no other file under src/ may contain a literal `SET visibility` or `SET is_hidden`.
test('visibility.ts is the only file under src/ that writes voices.visibility or voices.is_hidden', () => {
  const offenders: { file: string; match: string }[] = []
  for (const file of listTsFiles(SRC_DIR)) {
    if (file.endsWith(`${join('src', 'visibility.ts')}`) || file.endsWith('/visibility.ts')) continue
    const contents = readFileSync(file, 'utf8')
    if (contents.includes('SET visibility')) offenders.push({ file, match: 'SET visibility' })
    if (contents.includes('SET is_hidden')) offenders.push({ file, match: 'SET is_hidden' })
  }
  expect(offenders).toEqual([])
})

test('setVisibilityStatement: single-id UPDATE, with and without onlyIfCurrently', () => {
  const calls: { sql: string; args: unknown[] }[] = []
  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          calls.push({ sql, args })
          return { run: async () => ({ meta: { changes: 1 } }) }
        },
      }
    },
  } as unknown as D1Database

  setVisibilityStatement(db, 'v:1', 'hidden')
  expect(calls[0]!.sql).toContain('SET visibility = ?, is_hidden = ? WHERE id = ?')
  expect(calls[0]!.args).toEqual(['hidden', 1, 'v:1'])

  setVisibilityStatement(db, 'v:2', 'surfaced', { onlyIfCurrently: 'quarantined' })
  expect(calls[1]!.sql).toContain('AND visibility = ?')
  expect(calls[1]!.args).toEqual(['surfaced', 0, 'v:2', 'quarantined'])
})

test('releaseQuarantineStatement: binds now - quarantineMaxAgeMs, matches the pre-fix literal SQL', () => {
  let bound: unknown[] = []
  const db = {
    prepare(sql: string) {
      expect(sql).toContain("UPDATE voices SET visibility = 'surfaced', is_hidden = FALSE")
      expect(sql).toContain("WHERE visibility = 'quarantined' AND (damped = 0 OR created_at < ?)")
      return {
        bind(...args: unknown[]) {
          bound = args
          return { run: async () => ({ meta: { changes: 0 } }) }
        },
      }
    },
  } as unknown as D1Database

  const now = 1_000_000
  releaseQuarantineStatement(db, 3_600_000, now)
  expect(bound).toEqual([now - 3_600_000])
})
