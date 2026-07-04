import { describe, expect, test } from 'bun:test'
import { handleFocus } from '../src/tools/focus'
import { MockExecutionContext } from './mocks'

type VoiceRow = {
  id: string
  text: string
  language: string | null
  created_at: number
  weave_count: number
  unique_weavers: number
  is_hidden: number
}

type VoiceFamilyRow = {
  voice_id: string
  family: string
  ordinal: number
}

const normalizeSql = (sql: string) => sql.replace(/\s+/g, ' ').trim()

class FocusTestStatement {
  private args: unknown[] = []

  constructor(private db: FocusTestDb, private sql: string) {}

  bind(...args: unknown[]) {
    this.args = args
    return this
  }

  first<T>() {
    return this.db.first<T>(this.sql, this.args)
  }
}

class FocusTestDb {
  constructor(
    private voices: VoiceRow[],
    private voiceFamilies: VoiceFamilyRow[],
  ) {}

  prepare(sql: string) {
    return new FocusTestStatement(this, sql)
  }

  async batch(statements: FocusTestStatement[]) {
    return Promise.all(statements.map(statement => this.select(statement)))
  }

  async first<T>(sql: string, args: unknown[]): Promise<T | null> {
    const normalized = normalizeSql(sql)
    if (normalized === 'SELECT score, last_updated FROM warmth_state WHERE family = ?') {
      return { score: 0, last_updated: 0 } as T
    }
    throw new Error(`Unhandled first() SQL: ${normalized}`)
  }

  private async select(statement: FocusTestStatement) {
    const sql = normalizeSql((statement as unknown as { sql: string }).sql)
    const args = (statement as unknown as { args: unknown[] }).args
    const family = args[0] as string
    const threeDaysAgo = args[1] as number | undefined
    const rows = this.visiblePrimaryVoices(family)

    if (sql.includes('v.weave_count >= 3')) {
      return {
        results: rows
          .filter(voice => voice.weave_count >= 3)
          .sort((a, b) => b.weave_count - a.weave_count)
          .slice(0, 3),
      }
    }

    if (sql.includes('v.created_at > ?')) {
      return {
        results: rows
          .filter(voice => threeDaysAgo !== undefined && voice.created_at > threeDaysAgo)
          .sort((a, b) => b.created_at - a.created_at)
          .slice(0, 3),
      }
    }

    if (sql.includes('v.created_at < ? AND v.weave_count < 3')) {
      return {
        results: rows
          .filter(voice => threeDaysAgo !== undefined && voice.created_at < threeDaysAgo && voice.weave_count < 3)
          .sort((a, b) => b.created_at - a.created_at)
          .slice(0, 5),
      }
    }

    throw new Error(`Unhandled batch SQL: ${sql}`)
  }

  private visiblePrimaryVoices(family: string) {
    const primaryIds = new Set(
      this.voiceFamilies
        .filter(row => row.family === family && row.ordinal === 0)
        .map(row => row.voice_id),
    )
    return this.voices.filter(voice => primaryIds.has(voice.id) && !voice.is_hidden)
  }
}

describe('handleFocus', () => {
  test('returns only voices whose primary family matches the requested family', async () => {
    const now = Date.now()
    const db = new FocusTestDb(
      [
        {
          id: 'voice-x',
          text: 'Primary attention, secondary silence',
          language: 'en',
          created_at: now - 12 * 3_600_000,
          weave_count: 4,
          unique_weavers: 1,
          is_hidden: 0,
        },
        {
          id: 'voice-y',
          text: 'Primary silence',
          language: 'en',
          created_at: now - 6 * 3_600_000,
          weave_count: 4,
          unique_weavers: 1,
          is_hidden: 0,
        },
      ],
      [
        { voice_id: 'voice-x', family: 'attention', ordinal: 0 },
        { voice_id: 'voice-x', family: 'silence', ordinal: 1 },
        { voice_id: 'voice-y', family: 'silence', ordinal: 0 },
      ],
    )

    const result = await handleFocus(
      { DB: db as unknown as D1Database } as never,
      new MockExecutionContext() as never,
      null,
      { family: 'silence' },
    )

    const text = result.content[0]?.text ?? ''
    expect(text).toContain('voice-y')
    expect(text).not.toContain('voice-x')
  })
})
